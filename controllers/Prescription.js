module.exports = function (app) {
  // As prescrições de uma pessoa: receita, manipulado, exame, encaminhamento,
  // atestado.
  //
  // Mesma forma das rotas de dieta e treino. A única diferença de verdade está
  // no GET de um documento: ele devolve também QUEM emitiu, porque a folha
  // impressa precisa da assinatura — e uma receita sem quem assina não é
  // receita.
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  app.get("/people/:personId/prescriptions", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "prescriptions.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const rows = await app.api.prescription.list(trainer._id, student._id);

    res.send({
      rows,
      counts: { all: rows.length },
      // A lista de tipos vem do servidor pelo mesmo motivo das unidades de
      // suplemento: um tipo novo aparece em toda tela de uma vez, e a tela com
      // cache não oferece o que o servidor recusa.
      types: app.api.prescription.TIPOS,
    });
  });

  app.post("/people/:personId/prescriptions", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "prescriptions.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    // Um documento sem NENHUM item e sem observação nenhuma é uma folha em
    // branco assinada. Isso não se emite — e recusar aqui é melhor que descobrir
    // depois de imprimir.
    const itens = app.api.prescription.limparItens(body.items);
    const semTexto = !String(body.notes || "").trim();
    if (!itens.length && semTexto) {
      res.status(400).send({ msg: req.t("errors.requirePrescriptionItem") });
      return;
    }
    if (body.date && body.validUntil && body.validUntil < body.date) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const id = await app.api.prescription.insert(trainer._id, student._id, body);
    const criada = await app.api.prescription.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_prescription", {
      category: "prescriptions",
      local: { target_type: "prescriptions", target_id: id + "" },
      extra: {
        type: criada.type,
        items: criada.itemCount,
        person: student.name,
        personId: student._id + "",
      },
    });

    res.status(201).send(criada);
  });

  // Um documento, com a pessoa e quem emitiu — é o que a folha de impressão lê.
  app.get("/prescriptions/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "prescriptions.view");
    if (trainer === false) return;

    const doc = await app.api.prescription.data(trainer._id, req.params.id);
    if (!doc) {
      res.status(404).send({ msg: req.t("errors.prescriptionNotFound") });
      return;
    }

    const student = await app.api.user.data(doc.student);

    res.send({
      ...doc,
      // Fora da ficha, "Receita de 12/08" não identifica de quem é.
      student: student
        ? {
            _id: student._id,
            name: student.name,
            birthDate: student.birthDate || "",
            document: student.document || "",
          }
        : null,
      // Quem assina. O nome sai da conta AGORA (é sempre o nome atual de quem
      // emitiu), e o registro do conselho sai do DOCUMENTO — ele é o que estava
      // valendo no dia da emissão.
      professional: { name: trainer.name, council: doc.council || "" },
    });
  });

  app.put("/prescriptions/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "prescriptions.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.items !== undefined || body.notes !== undefined) {
      const antesDoc = await app.api.prescription.data(trainer._id, req.params.id);
      const itens =
        body.items !== undefined
          ? app.api.prescription.limparItens(body.items)
          : antesDoc?.items || [];
      const texto =
        body.notes !== undefined ? String(body.notes || "").trim() : antesDoc?.notes || "";

      if (!itens.length && !texto) {
        res.status(400).send({ msg: req.t("errors.requirePrescriptionItem") });
        return;
      }
    }

    const antes = await app.api.prescription.data(trainer._id, req.params.id);

    const ok = await app.api.prescription.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.prescriptionNotFound") });
      return;
    }

    const depois = await app.api.prescription.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_prescription", {
      category: "prescriptions",
      local: { target_type: "prescriptions", target_id: req.params.id + "" },
      extra: { type: depois.type, items: depois.itemCount },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/prescriptions/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "prescriptions.manage");
    if (trainer === false) return;

    const alvo = await app.api.prescription.data(trainer._id, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.prescriptionNotFound") });
      return;
    }

    await app.api.prescription.delete(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_prescription", {
      category: "prescriptions",
      local: { target_type: "prescriptions", target_id: req.params.id + "" },
      extra: { type: alvo.type, items: alvo.itemCount },
    });

    res.send({ msg: req.t("ok.prescriptionRemoved") });
  });
};
