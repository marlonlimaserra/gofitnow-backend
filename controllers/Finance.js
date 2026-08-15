module.exports = function (app) {
  // O financeiro de cada pessoa.
  //
  // Cobranças e pagamentos são rotas separadas porque são coisas separadas: uma
  // é o que a pessoa deve, a outra é o que ela pagou. Juntá-las num lançamento
  // só impediria o pagamento parcial e o pagamento adiantado, que são os dois
  // casos que mais aparecem.

  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  // Tudo do financeiro de uma pessoa numa resposta só.
  //
  // A tela mostra as três coisas juntas — o que deve, o que pagou e o saldo —
  // e três chamadas para desenhar uma aba fariam a tela piscar em três tempos.
  app.get("/people/:personId/finance", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    // As moedas da conta vão junto: os lançamentos antigos não têm a sua
    // gravada, e é a padrão que os interpreta.
    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      currency: moedas.currency,
      currencies: moedas.currencies,
      charges: await app.api.finance.listCharges(student._id),
      payments: await app.api.finance.listPayments(student._id),
      // Um saldo POR MOEDA: somar moedas diferentes daria um total que não
      // existe.
      balance: await app.api.finance.balanceOf(student._id, moedas.currency),
      paidByCharge: await app.api.finance.paidByCharge(student._id),
    });
  });

  // ── Cobranças ───────────────────────────────────────────────────────────

  app.post("/people/:personId/charges", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};
    // A moeda escolhida no formulário, se estiver habilitada; senão a padrão.
    const moeda = await app.api.tenant.currencyFor(body.currency);
    const id = await app.api.finance.insertCharge(student._id, body, trainer._id, moeda);
    const criada = await app.api.finance.chargeData(id);

    app.insertUserActionHistory(req, trainer, "create_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: id + "" },
      extra: { person: student.name, personId: student._id + "", amount: criada?.amount },
    });

    res.status(201).send(criada);
  });

  app.put("/charges/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const antes = await app.api.finance.chargeData(req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.chargeNotFound") });
      return;
    }

    const corpo = req.body || {};
    if (corpo.currency) corpo.currency = await app.api.tenant.currencyFor(corpo.currency);

    await app.api.finance.updateCharge(req.params.id, corpo);
    const depois = await app.api.finance.chargeData(req.params.id);

    app.insertUserActionHistory(req, trainer, "update_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: req.params.id + "" },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/charges/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const alvo = await app.api.finance.chargeData(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.chargeNotFound") });
      return;
    }

    await app.api.finance.deleteCharge(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: req.params.id + "" },
      extra: { amount: alvo.amount },
    });

    res.send({ msg: req.t("ok.chargeRemoved") });
  });

  // ── Pagamentos ──────────────────────────────────────────────────────────

  app.post("/people/:personId/payments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    // O comprovante é lido ANTES de gravar: um arquivo recusado tem de virar
    // 400 com o motivo certo, e não um pagamento gravado sem ele.
    let comprovante;
    if (body.receipt) {
      comprovante = app.api.finance.parseReceipt(body.receipt);
      if (!comprovante) {
        res.status(400).send({ msg: req.t("errors.invalidAttachment") });
        return;
      }
    }

    const moeda = await app.api.tenant.currencyFor(body.currency);
    const id = await app.api.finance.insertPayment(student._id, body, trainer._id, moeda);
    if (comprovante) await app.api.finance.saveReceipt(id, comprovante);

    const criado = await app.api.finance.paymentData(id);

    app.insertUserActionHistory(req, trainer, "create_payment", {
      category: "finance",
      local: { target_type: "payments", target_id: id + "" },
      extra: {
        person: student.name,
        personId: student._id + "",
        amount: criado?.amount,
        method: criado?.method,
      },
    });

    res.status(201).send(criado);
  });

  app.put("/payments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const antes = await app.api.finance.paymentData(req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.paymentNotFound") });
      return;
    }

    const body = req.body || {};

    let comprovante;
    if (body.receipt?.dataUri) {
      comprovante = app.api.finance.parseReceipt(body.receipt);
      if (!comprovante) {
        res.status(400).send({ msg: req.t("errors.invalidAttachment") });
        return;
      }
    }

    if (body.currency) body.currency = await app.api.tenant.currencyFor(body.currency);

    await app.api.finance.updatePayment(req.params.id, body);
    if (comprovante) await app.api.finance.saveReceipt(req.params.id, comprovante);

    const depois = await app.api.finance.paymentData(req.params.id);

    app.insertUserActionHistory(req, trainer, "update_payment", {
      category: "finance",
      local: { target_type: "payments", target_id: req.params.id + "" },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/payments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const alvo = await app.api.finance.paymentData(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.paymentNotFound") });
      return;
    }

    await app.api.finance.deletePayment(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_payment", {
      category: "finance",
      local: { target_type: "payments", target_id: req.params.id + "" },
      extra: { amount: alvo.amount },
    });

    res.send({ msg: req.t("ok.paymentRemoved") });
  });

  // ── Comprovante ─────────────────────────────────────────────────────────

  app.get("/payments/:id/receipt", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const arquivo = await app.api.finance.receiptOf(req.params.id);
    if (!arquivo) {
      res.status(404).send({ msg: req.t("errors.noPhotoShort") });
      return;
    }

    // Imagem abre embutida; PDF baixa. `nosniff` fecha a outra metade: sem ele
    // o navegador adivinha o tipo pelo conteúdo e ignora o que declaramos.
    const embutido = arquivo.mime.startsWith("image/");
    const nome = String(arquivo.name || "comprovante").replace(/"/g, "");

    res.setHeader("Content-Type", arquivo.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${embutido ? "inline" : "attachment"}; filename="${nome}"`
    );
    res.setHeader("Cache-Control", "private, max-age=86400");

    res.send(arquivo.data.buffer ? Buffer.from(arquivo.data.buffer) : arquivo.data);
  });

  app.delete("/payments/:id/receipt", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    await app.api.finance.removeReceipt(req.params.id);
    res.send({ msg: req.t("ok.photoRemoved") });
  });
};
