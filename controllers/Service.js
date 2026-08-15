module.exports = function (app) {
  // Os serviços oferecidos.
  //
  // Ficam atrás das permissões da AGENDA e não de um grupo próprio: serviço não
  // é um módulo, é a definição do que se marca. Quem organiza a agenda define o
  // que ela oferece — e mais uma permissão para isso seria uma chave a mais
  // para configurar sem nenhuma decisão nova por trás.

  app.get("/services", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (user === false) return;

    // `active=1` para quem vai ESCOLHER um; a lista completa para quem
    // administra. Um serviço desativado ainda existe — só não se oferece mais.
    res.send({
      rows: await app.api.service.list({ apenasAtivos: req.query.active === "1" }),
    });
  });

  app.post("/services", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      res.status(400).send({ msg: req.t("errors.requireName") });
      return;
    }

    const id = await app.api.service.insert(body);
    const criado = await app.api.service.data(id);

    app.insertUserActionHistory(req, user, "create_service", {
      category: "schedule",
      local: { target_type: "services", target_id: id + "" },
      extra: { name: criado?.name, price: criado?.price },
    });

    res.status(201).send(criado);
  });

  app.put("/services/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const antes = await app.api.service.data(req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.serviceNotFound") });
      return;
    }

    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      res.status(400).send({ msg: req.t("errors.requireName") });
      return;
    }

    await app.api.service.update(req.params.id, body);
    const depois = await app.api.service.data(req.params.id);

    app.insertUserActionHistory(req, user, "update_service", {
      category: "schedule",
      local: { target_type: "services", target_id: req.params.id + "" },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/services/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.service.data(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.serviceNotFound") });
      return;
    }

    await app.api.service.delete(req.params.id);

    app.insertUserActionHistory(req, user, "delete_service", {
      category: "schedule",
      local: { target_type: "services", target_id: req.params.id + "" },
      extra: { name: alvo.name },
    });

    res.send({ msg: req.t("ok.serviceRemoved") });
  });
};
