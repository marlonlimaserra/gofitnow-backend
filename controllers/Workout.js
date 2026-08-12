module.exports = function (app) {
  // Treinos — só profissional. Tudo é escopado ao profissional:
  // the student is always confirmed as belonging to this trainer first.

  // Confirms the student belongs to the signed-in trainer. Replies 404 and
  // returns false otherwise — from the outside there is no way to tell
  // "does not exist" from "belongs to someone else".
  async function studentOfTrainer(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.studentNotFound") });
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
      res.status(400).send({ msg: req.t("errors.requireWorkoutName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    // With no teacher given, assume the signed-in trainer.
    if (!body.teacherName) body.teacherName = trainer.name;

    const id = await app.api.workout.insert(trainer._id, student._id, body);
    const created = await app.api.workout.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_workout", {
      category: "workouts",
      local: { target_type: "workouts", target_id: id + "" },
      extra: { name: created.name, person: student.name, personId: student._id + "" },
    });

    res.status(201).send(created);
  });

  // ── A single workout ────────────────────────────────────────────────────

  app.get("/workouts/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.view");
    if (trainer === false) return;

    const workout = await app.api.workout.data(trainer._id, req.params.id);
    if (!workout) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    const student = await app.api.user.data(workout.student);

    // Os exercícios já vêm dentro de `workout` — a tela abre com tudo o que
    // precisa numa requisição só.
    res.send({
      ...workout,
      student: student ? { _id: student._id, name: student.name } : null,
    });
  });

  app.put("/workouts/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireWorkoutName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const before = await app.api.workout.data(trainer._id, req.params.id);

    const ok = await app.api.workout.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    const updated = await app.api.workout.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_workout", {
      category: "workouts",
      local: { target_type: "workouts", target_id: req.params.id + "" },
      extra: { name: updated.name },
      diff: app.api.actionHistory.diff(before, updated),
    });

    res.send(updated);
  });

  app.delete("/workouts/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const before = await app.api.workout.data(trainer._id, req.params.id);

    const ok = await app.api.workout.delete(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "delete_workout", {
      category: "workouts",
      local: { target_type: "workouts", target_id: req.params.id + "" },
      extra: { name: before ? before.name : null },
    });

    res.send({ msg: req.t("ok.workoutRemoved") });
  });

  // Copia o treino, com os exercícios, para a mesma pessoa ou outra.
  app.post("/workouts/:id/duplicate", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const targetStudent = (req.body || {}).studentId;
    const name = (req.body || {}).name;

    // Mesma regra do nome de treino em qualquer outro lugar: se veio, precisa ter
    // conteúdo. Ausente é válido — aí a cópia herda o "(cópia)".
    if (name !== undefined && String(name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireCopyName") });
      return;
    }

    if (targetStudent) {
      const student = await app.api.user.dataStudent(trainer._id, targetStudent);
      if (!student) {
        res.status(404).send({ msg: req.t("errors.targetStudentNotFound") });
        return;
      }
    }

    const newId = await app.api.workout.duplicate(trainer._id, req.params.id, targetStudent, name);
    if (!newId) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    const copy = await app.api.workout.data(trainer._id, newId);

    app.insertUserActionHistory(req, trainer, "duplicate_workout", {
      category: "workouts",
      local: { target_type: "workouts", target_id: newId + "" },
      extra: { name: copy.name, copiedFrom: req.params.id + "", toPerson: targetStudent || null },
    });

    res.status(201).send(copy);
  });

  // ── Exercícios ──────────────────────────────────────────────────────────
  //
  // Havia aqui seis rotas de SESSÃO: criar, ler, editar, duplicar, apagar e
  // salvar exercícios. Elas sumiram junto com o nível do meio — cada dia virou um
  // treino, e o que era "os exercícios da sessão" é agora "os exercícios do
  // treino". Uma rota no lugar de seis.

  // Salva a lista INTEIRA de uma vez (ordem + séries).
  app.put("/workouts/:id/exercises", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "workouts.manage");
    if (trainer === false) return;

    const { exercises } = req.body || {};
    if (!Array.isArray(exercises)) {
      res.status(400).send({ msg: req.t("errors.requireExerciseList") });
      return;
    }

    const before = await app.api.workout.data(trainer._id, req.params.id);

    const ok = await app.api.workout.saveExercises(trainer._id, req.params.id, exercises);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    const updated = await app.api.workout.data(trainer._id, req.params.id);

    // A lista inteira é reescrita a cada save, então um diff campo a campo não
    // diria nada. O que importa é quantos exercícios entraram e quais.
    app.insertUserActionHistory(req, trainer, "update_workout_exercises", {
      category: "workouts",
      local: { target_type: "workouts", target_id: req.params.id + "" },
      extra: {
        workout: updated.name,
        countBefore: before && before.exercises ? before.exercises.length : 0,
        countAfter: exercises.length,
        exercises: exercises.map((e) => e.name).filter(Boolean),
      },
    });

    res.send(updated);
  });
};
