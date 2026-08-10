module.exports = function (app) {
  // "Auto preencher": the professional's saved options for a new workout.
  //
  // Behind workouts.manage — a preset only exists to speed up creating a
  // workout, so whoever cannot create one has nothing to do here. The owner id
  // always comes from the session, never from the request.

  app.get("/workout-presets", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    res.send(await app.api.workoutPreset.list(trainer._id));
  });

  app.post("/workout-presets", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do treino." });
      return;
    }

    const id = await app.api.workoutPreset.insert(trainer._id, body);
    const created = await app.api.workoutPreset.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_workout_preset", {
      category: "workouts",
      local: { target_type: "workout_presets", target_id: id + "" },
      extra: { name: created.name },
    });

    res.status(201).send(created);
  });

  app.put("/workout-presets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do treino." });
      return;
    }

    const before = await app.api.workoutPreset.data(trainer._id, req.params.id);
    if (!before) {
      res.status(404).send({ msg: "Opção não encontrada." });
      return;
    }

    await app.api.workoutPreset.update(trainer._id, req.params.id, { ...before, ...body });
    const updated = await app.api.workoutPreset.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_workout_preset", {
      category: "workouts",
      local: { target_type: "workout_presets", target_id: req.params.id + "" },
      extra: { name: updated.name },
      diff: app.api.actionHistory.diff(before, updated),
    });

    res.send(updated);
  });

  app.delete("/workout-presets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const before = await app.api.workoutPreset.data(trainer._id, req.params.id);
    if (!before) {
      res.status(404).send({ msg: "Opção não encontrada." });
      return;
    }

    await app.api.workoutPreset.delete(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_workout_preset", {
      category: "workouts",
      local: { target_type: "workout_presets", target_id: req.params.id + "" },
      extra: { name: before.name },
    });

    res.send({ msg: "Opção removida." });
  });
};
