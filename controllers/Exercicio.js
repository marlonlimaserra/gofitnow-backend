module.exports = function (app) {
  // Catálogo de exercícios do trainer logado. Cada um monta o seu; tudo é
  // escopado na sessão, então um trainer nunca alcança o catálogo de outro.

  // Grupos musculares em uso, pro dropdown de filtro.
  app.get("/exercicios/grupos", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    res.send(await app.api.exercise.groups(trainer._id));
  });

  // ?busca=&grupo=&page=&limit=
  app.get("/exercicios", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    res.send(
      await app.api.exercise.list(trainer._id, {
        busca: req.query.busca,
        muscleGroup: req.query.grupo,
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  });

  app.post("/exercicios", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const body = req.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do exercício." });
      return;
    }

    const id = await app.api.exercise.insert(trainer._id, body);
    res.status(201).send(await app.api.exercise.data(trainer._id, id));
  });

  app.get("/exercicios/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const ex = await app.api.exercise.data(trainer._id, req.params.id);
    if (!ex) {
      res.status(404).send({ msg: "Exercício não encontrado." });
      return;
    }

    res.send(ex);
  });

  app.put("/exercicios/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const body = req.body || {};
    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do exercício." });
      return;
    }

    const ok = await app.api.exercise.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: "Exercício não encontrado." });
      return;
    }

    res.send(await app.api.exercise.data(trainer._id, req.params.id));
  });

  // Excluir do catálogo NÃO mexe nas sessões que já usam o exercício: elas
  // guardam nome e séries próprios, então o treino montado continua íntegro.
  app.delete("/exercicios/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const ok = await app.api.exercise.delete(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Exercício não encontrado." });
      return;
    }

    res.send({ msg: "Exercício removido." });
  });
};
