module.exports = function (app) {
  // Treinos e sessões — só trainer. Tudo escopado na sessão: o aluno é sempre
  // confirmado como sendo deste trainer antes de qualquer operação.

  // Confere que o aluno é do trainer logado. Responde 404 e devolve false se
  // não for — de fora não dá pra distinguir "não existe" de "é de outro".
  async function alunoDoTrainer(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.studentId);
    if (!student) {
      res.status(404).send({ msg: "Aluno não encontrado." });
      return false;
    }
    return student;
  }

  // ── Treinos do aluno ────────────────────────────────────────────────────

  app.get("/alunos/:studentId/treinos", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const student = await alunoDoTrainer(req, res, trainer);
    if (student === false) return;

    const treinos = await app.api.workout.list(trainer._id, student._id);

    // A tela tem as abas Atuais / Anteriores / Futuros / Todos com contagem.
    res.send({
      rows: treinos,
      counts: {
        current: treinos.filter((t) => t.status === "current").length,
        past: treinos.filter((t) => t.status === "past").length,
        future: treinos.filter((t) => t.status === "future").length,
        all: treinos.length,
      },
    });
  });

  app.post("/alunos/:studentId/treinos", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const student = await alunoDoTrainer(req, res, trainer);
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

    // Sem professor informado, assume o próprio trainer logado.
    if (!body.teacherName) body.teacherName = trainer.name;

    const id = await app.api.workout.insert(trainer._id, student._id, body);
    res.status(201).send(await app.api.workout.data(trainer._id, id));
  });

  // ── Um treino ───────────────────────────────────────────────────────────

  app.get("/treinos/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const treino = await app.api.workout.data(trainer._id, req.params.id);
    if (!treino) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    const student = await app.api.user.data(treino.student);
    const sessions = await app.api.workout.listSessions(treino._id);

    res.send({
      ...treino,
      student: student ? { _id: student._id, name: student.name } : null,
      sessions,
    });
  });

  app.put("/treinos/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
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

  app.delete("/treinos/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const ok = await app.api.workout.delete(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    res.send({ msg: "Treino removido." });
  });

  // Copia o treino (com as sessões) para o mesmo ou outro aluno.
  app.post("/treinos/:id/duplicar", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const destino = (req.body || {}).studentId;

    if (destino) {
      const student = await app.api.user.dataStudent(trainer._id, destino);
      if (!student) {
        res.status(404).send({ msg: "Aluno de destino não encontrado." });
        return;
      }
    }

    const novoId = await app.api.workout.duplicate(trainer._id, req.params.id, destino);
    if (!novoId) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    res.status(201).send(await app.api.workout.data(trainer._id, novoId));
  });

  // ── Sessões ─────────────────────────────────────────────────────────────

  app.post("/treinos/:id/sessoes", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const treino = await app.api.workout.data(trainer._id, req.params.id);
    if (!treino) {
      res.status(404).send({ msg: "Treino não encontrado." });
      return;
    }

    const body = req.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome da sessão." });
      return;
    }

    const id = await app.api.workout.insertSession(trainer._id, treino._id, body);
    res.status(201).send(await app.api.workout.dataSession(trainer._id, id));
  });

  app.get("/sessoes/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const sessao = await app.api.workout.dataSession(trainer._id, req.params.id);
    if (!sessao) {
      res.status(404).send({ msg: "Sessão não encontrada." });
      return;
    }

    const treino = await app.api.workout.data(trainer._id, sessao.workout);
    res.send({ ...sessao, workoutName: treino ? treino.name : "", workoutId: sessao.workout });
  });

  app.put("/sessoes/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
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

  app.delete("/sessoes/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const ok = await app.api.workout.deleteSession(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Sessão não encontrada." });
      return;
    }

    res.send({ msg: "Sessão removida." });
  });

  // Salva a lista inteira de exercícios da sessão de uma vez (ordem + séries).
  app.put("/sessoes/:id/exercicios", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
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
