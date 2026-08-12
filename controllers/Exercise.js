module.exports = function (app) {
  // O catálogo de exercícios — ÚNICO, no banco central, igual para todo mundo.
  //
  // A sessão continua sendo exigida (ninguém lê o catálogo sem entrar), mas ela
  // já NÃO delimita o que se vê: não há catálogo de um profissional para
  // alcançar o do outro.
  //
  // `exercises.manage` passou a valer muito mais do que valia: quem edita ou
  // apaga mexe no catálogo de todas as instâncias. Vale revisar quem a tem.

  // Muscle groups in use, for the filter dropdown.
  app.get("/exercises/groups", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    res.send(await app.api.exercise.groups());
  });

  // ?search=&group=&page=&limit=
  app.get("/exercises", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    res.send(
      await app.api.exercise.list({
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
      res.status(400).send({ msg: req.t("errors.requireExerciseName") });
      return;
    }

    const id = await app.api.exercise.insert(body);
    const created = await app.api.exercise.data(id);

    app.insertUserActionHistory(req, trainer, "create_exercise", {
      category: "exercises",
      local: { target_type: "exercises", target_id: id + "" },
      extra: { name: created.name, muscleGroup: created.muscleGroup },
    });

    res.status(201).send(created);
  });

  app.get("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    const exercise = await app.api.exercise.data(req.params.id);
    if (!exercise) {
      res.status(404).send({ msg: req.t("errors.exerciseNotFound") });
      return;
    }

    res.send(exercise);
  });

  app.put("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
    if (trainer === false) return;

    const body = req.body || {};
    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireExerciseName") });
      return;
    }

    const ok = await app.api.exercise.update(req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.exerciseNotFound") });
      return;
    }

    const updated = await app.api.exercise.data(req.params.id);

    app.insertUserActionHistory(req, trainer, "update_exercise", {
      category: "exercises",
      local: { target_type: "exercises", target_id: req.params.id + "" },
      extra: { name: updated.name },
    });

    res.send(updated);
  });

  // Deleting from the catalog does NOT touch sessions already using the
  // exercise: they keep their own name and sets, so the assembled workout
  // stays intact.
  app.delete("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
    if (trainer === false) return;

    const ok = await app.api.exercise.delete(req.params.id);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.exerciseNotFound") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "delete_exercise", {
      category: "exercises",
      local: { target_type: "exercises", target_id: req.params.id + "" },
    });

    res.send({ msg: req.t("ok.exerciseRemoved") });
  });
};
