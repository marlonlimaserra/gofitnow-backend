module.exports = function (app) {
  // The signed-in trainer's exercise catalog. Each trainer builds their own;
  // everything is scoped to the session, so a trainer never reaches another
  // trainer's catalog.

  // Muscle groups in use, for the filter dropdown.
  app.get("/exercises/groups", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    res.send(await app.api.exercise.groups(trainer._id));
  });

  // ?search=&group=&page=&limit=
  app.get("/exercises", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    res.send(
      await app.api.exercise.list(trainer._id, {
        search: req.query.search,
        muscleGroup: req.query.group,
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  });

  app.post("/exercises", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
    if (trainer === false) return;

    const body = req.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do exercício." });
      return;
    }

    const id = await app.api.exercise.insert(trainer._id, body);
    res.status(201).send(await app.api.exercise.data(trainer._id, id));
  });

  app.get("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    const exercise = await app.api.exercise.data(trainer._id, req.params.id);
    if (!exercise) {
      res.status(404).send({ msg: "Exercício não encontrado." });
      return;
    }

    res.send(exercise);
  });

  app.put("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
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

  // Deleting from the catalog does NOT touch sessions already using the
  // exercise: they keep their own name and sets, so the assembled workout
  // stays intact.
  app.delete("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
    if (trainer === false) return;

    const ok = await app.api.exercise.delete(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Exercício não encontrado." });
      return;
    }

    res.send({ msg: "Exercício removido." });
  });
};
