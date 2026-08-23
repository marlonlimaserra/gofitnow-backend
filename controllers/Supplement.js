module.exports = function (app) {
  // A suplementação de uma pessoa.
  //
  // Espelha as rotas de dieta e de treino de propósito: mesma forma de URL,
  // mesmo formato de resposta, mesmo lugar para o escopo. Quem integrou uma
  // integra a outra sem reler nada.
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  app.get("/people/:personId/supplements", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "supplements.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const rows = await app.api.supplement.list(trainer._id, student._id);

    res.send({
      rows,
      counts: {
        current: rows.filter((s) => s.status === "current").length,
        past: rows.filter((s) => s.status === "past").length,
        future: rows.filter((s) => s.status === "future").length,
        all: rows.length,
      },
      // As duas listas fechadas vão na resposta em vez de ficarem cravadas na
      // tela: acrescentar uma unidade ou um momento passa a ser mexer num lugar
      // só, e a tela velha de um navegador com cache não fica oferecendo uma
      // opção que o servidor recusa.
      moments: app.api.supplement.MOMENTOS,
      units: app.api.supplement.UNIDADES,
    });
  });

  app.post("/people/:personId/supplements", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "supplements.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireSupplementName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const id = await app.api.supplement.insert(trainer._id, student._id, body);
    const criado = await app.api.supplement.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_supplement", {
      category: "supplements",
      local: { target_type: "supplements", target_id: id + "" },
      extra: { name: criado.name, person: student.name, personId: student._id + "" },
    });

    res.status(201).send(criado);
  });

  app.put("/supplements/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "supplements.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireSupplementName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const antes = await app.api.supplement.data(trainer._id, req.params.id);

    const ok = await app.api.supplement.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.supplementNotFound") });
      return;
    }

    const depois = await app.api.supplement.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_supplement", {
      category: "supplements",
      local: { target_type: "supplements", target_id: req.params.id + "" },
      extra: { name: depois.name },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/supplements/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "supplements.manage");
    if (trainer === false) return;

    const alvo = await app.api.supplement.data(trainer._id, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.supplementNotFound") });
      return;
    }

    await app.api.supplement.delete(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_supplement", {
      category: "supplements",
      local: { target_type: "supplements", target_id: req.params.id + "" },
      extra: { name: alvo.name },
    });

    res.send({ msg: req.t("ok.supplementRemoved") });
  });
};
