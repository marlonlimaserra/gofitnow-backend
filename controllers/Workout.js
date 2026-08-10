module.exports = function (app) {
  // Workouts and sessions — trainer only. Everything is scoped to the session:
  // the student is always confirmed as belonging to this trainer first.

  // Confirms the student belongs to the signed-in trainer. Replies 404 and
  // returns false otherwise — from the outside there is no way to tell
  // "does not exist" from "belongs to someone else".
  async function studentOfTrainer(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: "Aluno não encontrado." });
      return false;
    }
    return student;
  }

  // ── The student's workouts ──────────────────────────────────────────────

  app.get("/people/:personId/workouts", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.view");
    if (trainer === false) return;

    const student = await studentOfTrainer(req, res, trainer);
    if (student === false) return;

    const workouts = await app.api.workout.list(trainer._id, student._id);

    // The screen has Current / Past / Future / All tabs with counts.
    res.send({
      rows: workouts,
      counts: {
        current: workouts.filter((w) => w.status === "current").length,
        past: workouts.filter((w) => w.status === "past").length,
        future: workouts.filter((w) => w.status === "future").length,
        all: workouts.length,
      },
    });
  });

  app.post("/people/:personId/workouts", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const student = await studentOfTrainer(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do treino." });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: "A data final não pode ser antes da inicial." });
      return;
    }

    // With no teacher given, assume the signed-in trainer.
    if (!body.teacherName) body.teacherName = trainer.name;

    const id = await app.api.workout.insert(trainer._id, student._id, body);
    res.status(201).send(await app.api.workout.data(trainer._id, id));
  });

  // ── A single workout ────────────────────────────────────────────────────

  app.get("/workouts/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.view");
    if (trainer === false) return;

    const workout = await app.api.workout.data(trainer._id, req.params.id);
    if (!workout) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    const student = await app.api.user.data(workout.student);
    const sessions = await app.api.workout.listSessions(workout._id);

    res.send({
      ...workout,
      student: student ? { _id: student._id, name: student.name } : null,
      sessions,
    });
  });

  app.put("/workouts/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do treino." });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: "A data final não pode ser antes da inicial." });
      return;
    }

    const ok = await app.api.workout.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    res.send(await app.api.workout.data(trainer._id, req.params.id));
  });

  app.delete("/workouts/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const ok = await app.api.workout.delete(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    res.send({ msg: "Treino removido." });
  });

  // Copies the workout (with its sessions) to the same or another student.
  app.post("/workouts/:id/duplicate", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const targetStudent = (req.body || {}).studentId;

    if (targetStudent) {
      const student = await app.api.user.dataStudent(trainer._id, targetStudent);
      if (!student) {
        res.status(404).send({ msg: "Aluno de destino não encontrado." });
        return;
      }
    }

    const newId = await app.api.workout.duplicate(trainer._id, req.params.id, targetStudent);
    if (!newId) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    res.status(201).send(await app.api.workout.data(trainer._id, newId));
  });

  // ── Sessions ────────────────────────────────────────────────────────────

  app.post("/workouts/:id/sessions", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const workout = await app.api.workout.data(trainer._id, req.params.id);
    if (!workout) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    const body = req.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome da sessão." });
      return;
    }

    const id = await app.api.workout.insertSession(trainer._id, workout._id, body);
    res.status(201).send(await app.api.workout.dataSession(trainer._id, id));
  });

  app.get("/sessions/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.view");
    if (trainer === false) return;

    const session = await app.api.workout.dataSession(trainer._id, req.params.id);
    if (!session) {
      res.status(404).send({ msg: "Sessão não encontrada." });
      return;
    }

    const workout = await app.api.workout.data(trainer._id, session.workout);
    res.send({ ...session, workoutName: workout ? workout.name : "", workoutId: session.workout });
  });

  app.put("/sessions/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const body = req.body || {};
    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome da sessão." });
      return;
    }

    const ok = await app.api.workout.updateSession(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: "Sessão não encontrada." });
      return;
    }

    res.send(await app.api.workout.dataSession(trainer._id, req.params.id));
  });

  app.delete("/sessions/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const ok = await app.api.workout.deleteSession(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Sessão não encontrada." });
      return;
    }

    res.send({ msg: "Sessão removida." });
  });

  // Saves the session's whole exercise list at once (order + sets).
  app.put("/sessions/:id/exercises", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const { exercises } = req.body || {};
    if (!Array.isArray(exercises)) {
      res.status(400).send({ msg: "Envie a lista de exercícios." });
      return;
    }

    const ok = await app.api.workout.saveSessionExercises(trainer._id, req.params.id, exercises);
    if (!ok) {
      res.status(404).send({ msg: "Sessão não encontrada." });
      return;
    }

    res.send(await app.api.workout.dataSession(trainer._id, req.params.id));
  });
};
