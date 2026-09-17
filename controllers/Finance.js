const arquivos = require("../lib/arquivos.js");
const statusDeCobranca = require("../lib/statusDeCobranca.js");
const { documentoFinanceiro } = require("../lib/documentoFinanceiro.js");
const { registrarRotasDeDocumento } = require("../lib/rotasDeDocumento.js");
const { logoDaCasa } = require("../lib/logoDaCasa.js");
// O fuso da conta, sem poder derrubar quem o pediu.
//
// A janela do mês é melhor COM ele; o relatório é obrigatório SEM ele. É a mesma
// hierarquia do `vestirComAConta`: o menos importante não pode custar o mais
// importante.
async function fusoDaConta(app) {
  try {
    return await app.api.tenant.timezoneOfInstance();
  } catch (erro) {
    return undefined;
  }
}

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
  // ── O FINANCEIRO DE TODO MUNDO ──────────────────────────────────────────
  //
  // Tudo aqui era por pessoa, e isso responde à ficha de um aluno — não à
  // pergunta do fim do mês: "quanto tenho a receber?", "quem está atrasado?".
  // Com 217 pessoas, a resposta exigia abrir 217 fichas: o dado existia e era
  // inalcançável.
  //
  // ── OS NOMES VÊM JUNTO ────────────────────────────────────────────────
  //
  // A cobrança guarda o id da pessoa, e uma lista de ids não é um relatório.
  // Resolvidos numa consulta só — uma por linha seriam trezentas idas ao banco
  // para desenhar uma tela.
  app.get("/finance", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const { rows, resumo } = await app.api.finance.carteira({
      de: req.query.de,
      ate: req.query.ate,
      status: req.query.status,
      // O FUSO DA CONTA, para a janela do mês bater com o calendário de quem
      // olha. Sem ele o fim do dia 30 seria 23:59 UTC — 20:59 em São Paulo —, e
      // a cobrança da noite do último dia ficaria fora do próprio mês.
      //
      // Num `try`, e o relatório sai de todo jeito: uma leitura de configuração
      // que falha não pode derrubar a tela que mostra o dinheiro do mês. Sem
      // fuso, `carteira` cai no padrão — que é o de quase toda conta deste
      // produto, e erra no máximo por três horas no último dia.
      fuso: await fusoDaConta(app),
    });

    // Nome, e-mail e WhatsApp: os três numa consulta só. O contato vai para a
    // PLANILHA — quem exporta para cobrar precisa de por onde falar.
    const pessoas = await app.api.user.contactsByIds([...new Set(rows.map((r) => r.student))]);
    const nomes = new Map([...pessoas].map(([id, p]) => [id, p.name]));

    const termo = String(req.query.q || "").trim().toLowerCase();

    // A busca é por NOME, e acontece depois de resolver os nomes — é o único
    // jeito: a cobrança não os guarda, e filtrar antes exigiria uma consulta
    // por termo em outra collection.
    const visiveis = termo
      ? rows.filter(
          (r) =>
            String(nomes.get(r.student) || "").toLowerCase().includes(termo) ||
            r.description.toLowerCase().includes(termo)
        )
      : rows;

    // As moedas da conta vão junto: os lançamentos antigos não têm a sua
    // gravada, e é a padrão que os interpreta.
    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows: visiveis.map((r) => ({
        ...r,
        studentName: pessoas.get(r.student)?.name || "—",
        studentEmail: pessoas.get(r.student)?.email || "",
        studentPhone: pessoas.get(r.student)?.phone || "",
      })),
      // O resumo é de TODA a janela, não da busca — ver o comentário no modelo.
      resumo,
      currency: moedas.currency,
      currencies: moedas.currencies,
      // O CATÁLOGO DE ESTADOS, para a tela desenhar os filtros sem conhecê-los.
      // Ver `lib/statusDeCobranca.js`: acrescentar um estado lá o faz aparecer
      // aqui, e a tela não muda.
      status: statusDeCobranca.paraTela(req.t),
    });
  });

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

  // Os pagamentos de uma cobrança, para o diálogo de edição mostrar de onde vem
  // o "Paga". `finance.view` e não `manage`: é leitura.
  app.get("/charges/:id/payments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const cobranca = await app.api.finance.chargeData(req.params.id);
    if (!cobranca) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    res.send({ rows: await app.api.finance.paymentsOfCharge(req.params.id) });
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

    // ── A MOEDA DE UM PAGAMENTO COM COBRANÇA É A DA COBRANÇA ──────────────
    //
    // *"aqui nessa tela, temos moeda, já entendeu o problema né?"* — o dialog
    // abria em USD com o "Referente a" apontando para uma cobrança de R$ 25.
    //
    // O estrago não é cosmético: `paidByCharge` e `carteira` somam `amount` SEM
    // olhar moeda. Um pagamento de 25 USD quitaria uma cobrança de R$ 25 — a
    // conta fecharia na tela e o dinheiro recebido seria outro.
    //
    // ── Forçar, e não recusar ─────────────────────────────────────────────
    //
    // Recusar com 400 obrigaria a pessoa a descobrir sozinha qual moeda o campo
    // deveria ter. E não há ambiguidade a resolver: um pagamento QUE SE REFERE a
    // uma cobrança é, por definição, na moeda dela — quem recebe em outra moeda
    // está fazendo outro combinado, e aí lança um pagamento avulso.
    //
    // Pagamento SEM cobrança continua livre: a moeda vem do que foi pedido, com
    // a da conta como padrão (`currencyFor` só aceita as habilitadas).
    // A moeda pedida, validada contra o que a conta aceita receber. Se o
    // pagamento apontar para uma cobrança, `insertPayment` troca esta pela
    // moeda DELA — a regra vive lá, num lugar só, porque a edição passa pelo
    // mesmo problema e não passa por aqui.
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

    // Os BYTES podem estar no R2 — ver lib/arquivos.js. Note que isto
    // acontece DEPOIS do 304: quando o navegador já tem a versão
    // cacheada, não há ida ao bucket nenhuma.
    const bytes = await arquivos.bytesDoDocumento(arquivo);
    if (!bytes) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    res.send(bytes);
  });

  app.delete("/payments/:id/receipt", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    await app.api.finance.removeReceipt(req.params.id);
    res.send({ msg: req.t("ok.photoRemoved") });
  });

  // ── As formas de pagamento ────────────────────────────────────────────────
  //
  // Eram uma lista fixa no código. Continuam sendo um CATÁLOGO — a chave que fica
  // gravada no pagamento não muda —, mas quem manda no catálogo é cada conta:
  // renomear, desativar o que não usa, criar "Cheque" ou "Cartão da recepção" e
  // pôr na ordem em que se pergunta.
  //
  // Ler é `finance.view`: o seletor do formulário de pagamento precisa da lista.
  // Mexer é `finance.manage`.

  app.get("/payment-methods", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    // `?todas=1` traz também as desativadas — é a tela de configuração. O
    // formulário de pagamento pede só as ativas.
    const rows =
      req.query.todas === "1"
        ? await app.api.paymentMethod.list()
        : await app.api.paymentMethod.listActive();

    res.send({ rows });
  });

  app.post("/payment-methods", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const feito = await app.api.paymentMethod.insert(req.body || {});

    if (feito.erro === "name") {
      res.status(400).send({ msg: req.t("errors.requirePaymentMethodName") });
      return;
    }
    if (feito.erro === "duplicate") {
      res.status(409).send({ msg: req.t("errors.paymentMethodExists") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "create_payment_method", {
      category: "finance",
      local: { target_type: "payment_methods", target_id: String(feito.id) },
      extra: { name: req.body?.name },
    });

    res.status(201).send({ _id: feito.id });
  });

  // ANTES do `/:id`: registrada depois, esta rota nunca seria alcançada — o
  // Express casaria "order" como se fosse um id, e reordenar viraria uma
  // tentativa de editar a forma de pagamento chamada "order".
  app.put("/payment-methods/order", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const ok = await app.api.paymentMethod.reorder(req.body?.ids);
    if (!ok) {
      res.status(400).send({ msg: req.t("errors.invalidOrder") });
      return;
    }

    res.send({ msg: req.t("ok.paymentMethodSaved") });
  });

  app.put("/payment-methods/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const feito = await app.api.paymentMethod.update(req.params.id, req.body || {});

    if (feito?.erro === "name") {
      res.status(400).send({ msg: req.t("errors.requirePaymentMethodName") });
      return;
    }
    if (!feito) {
      res.status(404).send({ msg: req.t("errors.paymentMethodNotFound") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "update_payment_method", {
      category: "finance",
      local: { target_type: "payment_methods", target_id: String(req.params.id) },
      extra: { name: req.body?.name, active: req.body?.active },
    });

    res.send({ msg: req.t("ok.paymentMethodSaved") });
  });

  app.delete("/payment-methods/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const feito = await app.api.paymentMethod.delete(req.params.id);

    // As duas recusas dizem o MOTIVO, porque nos dois casos existe uma saída e
    // ela é a mesma: desativar. Um "não foi possível" mandaria a pessoa tentar
    // de novo até desistir.
    if (feito?.erro === "system") {
      res.status(409).send({ msg: req.t("errors.paymentMethodSystem"), code: "system" });
      return;
    }
    if (feito?.erro === "inUse") {
      res.status(409).send({ msg: req.t("errors.paymentMethodInUse"), code: "in_use" });
      return;
    }
    if (!feito) {
      res.status(404).send({ msg: req.t("errors.paymentMethodNotFound") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "delete_payment_method", {
      category: "finance",
      local: { target_type: "payment_methods", target_id: String(req.params.id) },
    });

    res.send({ msg: req.t("ok.paymentMethodRemoved") });
  });

  // ── O EXTRATO FINANCEIRO DE UMA PESSOA ────────────────────────────────
  //
  // As mesmas três rotas da avaliação e do plano alimentar (ver, baixar em PDF,
  // mandar por e-mail), pela mesma fábrica. Aqui fica só o que é do extrato:
  // quais lançamentos entram e como a folha se monta.
  //
  // Pedido do Marlon em 17/09/2026: *"pode exportar xlsx e pdf com a logo bonita
  // foto e dados do cliente"*. A PLANILHA sai na tela — ninguém abre planilha
  // para olhar, abre para somar. O papel, que é o que se entrega, vem daqui.
  //
  // ── `:id` É A PESSOA, e não um lançamento ───────────────────────────
  //
  // A fábrica monta `/finance/:id/documento`, e nas outras duas o `:id` é o
  // documento em si (uma coleta, um plano). Aqui não existe "um extrato" no
  // banco: ele é o recorte que alguém pediu. O dono do recorte é a PESSOA.
  //
  // ── E O RECORTE VIAJA NA QUERY ──────────────────────────────────────
  //
  // `?ids=a,b,c` são as cobranças marcadas na tela. Sem ele, o extrato é a vida
  // financeira inteira da pessoa — que é o que se quer ao entregar um
  // comprovante de quitação, e o que ninguém quer ao imprimir só o mês.
  //
  // Os TOTAIS são do que ficou na folha, e não o saldo da conta: três cobranças
  // marcadas com o "Cobrado" da conta inteira em cima seria um número que não
  // bate com nenhuma linha abaixo dele.
  function pedidas(req) {
    const bruto = String(req.query.ids || "").trim();
    if (!bruto) return null;

    const ids = bruto
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    return ids.length ? new Set(ids) : null;
  }

  registrarRotasDeDocumento(app, {
    base: "finance",
    prefixoDoArquivo: "extrato",
    chaveDoAssunto: "email.statement.subject",
    chaveDeOk: "ok.statementEmailed",
    acao: "email_statement",

    montar: async function (req, res) {
      const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
      if (trainer === false) return null;

      // `dataStudent` já filtra pelo profissional: quem não acompanha a pessoa
      // recebe 404, e não o extrato dela.
      const student = await app.api.user.dataStudent(trainer._id, req.params.id);
      if (!student) {
        res.status(404).send({ msg: req.t("errors.personNotFound") });
        return null;
      }

      const [todasAsCobrancas, todosOsPagamentos, moedas, fuso, casa, catalogo] = await Promise.all([
        app.api.finance.listCharges(student._id),
        app.api.finance.listPayments(student._id),
        app.api.tenant.currencyOfInstance(),
        app.api.tenant.timezoneOfInstance(),
        app.api.tenant.dataOfInstance(),
        // COM as desativadas: um pagamento antigo em boleto continua tendo de
        // dizer "Boleto" depois de o boleto sair de uso.
        app.api.paymentMethod.list(),
      ]);

      const escolhidas = pedidas(req);

      const charges = escolhidas
        ? todasAsCobrancas.filter((c) => escolhidas.has(String(c._id)))
        : todasAsCobrancas;

      // Com recorte, só os pagamentos DAS cobranças escolhidas: um avulso no
      // meio de três cobranças marcadas seria dinheiro que a pessoa não pediu
      // para ver, somado num total que ela vai conferir.
      const payments = escolhidas
        ? todosOsPagamentos.filter((p) => p.charge && escolhidas.has(String(p.charge)))
        : todosOsPagamentos;

      const formas = {};
      for (const f of catalogo || []) if (f.name) formas[f.key] = f.name;

      // ── A FOTO DA PESSOA, embutida ──────────────────────────────────
      //
      // `data:` URI, e não a URL de `/avatars/:id`: aquela exige sessão, e um
      // `<img>` apontando para ela sai em branco no e-mail, no PDF e no
      // `expo-print`. Embutida, a folha funciona salva em disco, meses depois.
      //
      // Sem foto a folha sai sem ela — o desenho já prevê isso, e um quadrado
      // cinza no lugar seria pior do que nada.
      let bytesDaFoto = null;
      let mimeDaFoto = "image/jpeg";

      try {
        const avatar = await app.api.avatar.data(student._id);
        if (avatar) {
          // `bytesDoDocumento` já devolve Buffer, venha a foto do R2 ou do
          // campo `data` do banco — ele resolve as duas pontas da migração.
          const crus = await arquivos.bytesDoDocumento(avatar);
          // Um Buffer de zero bytes é VERDADEIRO em JavaScript: sem o teste de
          // tamanho sairia `data:image/jpeg;base64,` — um URI de sintaxe
          // perfeita e nenhuma imagem, que vira ícone quebrado sem erro nenhum.
          if (crus && crus.length) {
            bytesDaFoto = crus;
            mimeDaFoto = avatar.mime || mimeDaFoto;
          }
        }
      } catch (erro) {
        // Foto que não carrega não pode custar o extrato: o dinheiro é o
        // conteúdo, e o retrato é enfeite.
        console.warn("[documento:finance] foto:", erro.message);
      }

      const marca = await logoDaCasa(casa?.theme);
      const CID_LOGO = "logo-da-casa";
      const CID_FOTO = "foto-da-pessoa";

      const desenhar = (comFoto, comMarca) =>
        documentoFinanceiro({
          person: student,
          charges,
          payments,
          moeda: moedas.currency,
          formas,
          foto: comFoto,
          lang: trainer.lang || req.language,
          fuso,
          marca: comMarca,
        });

      // ── DUAS VERSÕES DA MESMA FOLHA ─────────────────────────────────
      //
      // O Gmail DESCARTA `<img src="data:…">`, e o Chromium que gera o PDF não
      // resolve `cid:` — ele não tem a mensagem MIME, só a página. Cada saída
      // recebe a versão que sabe ler, e as duas nascem do mesmo dado.
      const fotos = [];

      if (bytesDaFoto) {
        fotos.push({
          cid: CID_FOTO,
          filename: `foto.${(mimeDaFoto.split("/")[1] || "jpg")}`,
          content: bytesDaFoto,
          contentType: mimeDaFoto,
        });
      }

      if (marca) {
        const [cabecalho, base64] = marca.split(",");
        fotos.push({
          cid: CID_LOGO,
          filename: "logo.png",
          content: Buffer.from(base64 || "", "base64"),
          contentType: (cabecalho.match(/data:([^;]+)/) || [])[1] || "image/png",
        });
      }

      const embutida = bytesDaFoto
        ? `data:${mimeDaFoto};base64,${bytesDaFoto.toString("base64")}`
        : null;

      return {
        trainer,
        pessoa: student,
        html: desenhar(embutida, marca),
        htmlDeEmail: desenhar(
          bytesDaFoto ? `cid:${CID_FOTO}` : null,
          marca ? `cid:${CID_LOGO}` : null
        ),
        fotos,
        nome: student.name,
        data: new Date(),
      };
    },
  });
};
