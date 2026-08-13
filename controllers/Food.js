module.exports = function (app) {
  // O catálogo de alimentos. Mesma forma do de exercícios — inclusive o aviso
  // que vale para os dois: quem gerencia mexe no catálogo de TODAS as contas,
  // porque a tabela é única e central.
  app.get("/foods", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "foods.view");
    if (user === false) return;

    res.send(
      await app.api.food.list({
        search: req.query.search,
        category: req.query.category,
        source: req.query.source,
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  });

  app.get("/foods/categories", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "foods.view");
    if (user === false) return;

    res.send({ rows: await app.api.food.categories() });
  });

  app.get("/foods/sources", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "foods.view");
    if (user === false) return;

    res.send({ rows: await app.api.food.sources() });
  });

  app.get("/foods/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "foods.view");
    if (user === false) return;

    const food = await app.api.food.data(req.params.id);
    if (!food) {
      res.status(404).send({ msg: req.t("errors.foodNotFound") });
      return;
    }

    res.send(food);
  });

  app.post("/foods", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "foods.manage");
    if (user === false) return;

    const body = req.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireFoodName") });
      return;
    }

    const id = await app.api.food.insert(body);
    const criado = await app.api.food.data(id);

    app.insertUserActionHistory(req, user, "create_food", {
      category: "foods",
      local: { target_type: "foods", target_id: id + "" },
      extra: { name: criado.name },
    });

    res.status(201).send(criado);
  });

  app.put("/foods/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "foods.manage");
    if (user === false) return;

    const body = req.body || {};
    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireFoodName") });
      return;
    }

    const antes = await app.api.food.data(req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.foodNotFound") });
      return;
    }

    await app.api.food.update(req.params.id, { ...antes, ...body });
    const depois = await app.api.food.data(req.params.id);

    app.insertUserActionHistory(req, user, "update_food", {
      category: "foods",
      local: { target_type: "foods", target_id: req.params.id + "" },
      extra: { name: depois.name },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/foods/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "foods.manage");
    if (user === false) return;

    const alvo = await app.api.food.data(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.foodNotFound") });
      return;
    }

    await app.api.food.delete(req.params.id);

    // Os planos que já usam este alimento NÃO mudam: cada refeição guarda uma
    // cópia do nome e dos valores. Apagar do catálogo tira das buscas futuras,
    // não reescreve o que já foi entregue a alguém.
    app.insertUserActionHistory(req, user, "delete_food", {
      category: "foods",
      local: { target_type: "foods", target_id: req.params.id + "" },
      extra: { name: alvo.name },
    });

    res.send({ msg: req.t("ok.foodRemoved") });
  });
};
