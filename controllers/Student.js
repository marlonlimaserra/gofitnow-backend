module.exports = function (app) {
  // Student management — trainer only. The owner id never comes from the body
  // or the query: it always comes from the session, so a trainer can never
  // reach another trainer's student.

  app.get("/students", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    res.send(
      await app.api.user.listStudents(trainer._id, {
        search: req.query.search,
        active: req.query.active,
      })
    );
  });

  app.get("/students/summary", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    res.send(await app.api.user.studentsSummary(trainer._id));
  });

  app.get("/students/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const student = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!student) {
      res.status(404).send({ msg: "Aluno não encontrado." });
      return;
    }

    res.send(app.api.user.filter(student));
  });

  app.post("/students", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do aluno." });
      return;
    }
    if (body.email && !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: "E-mail do aluno inválido." });
      return;
    }
    if (body.password) {
      // The password is optional (a profile can exist without access), but if
      // one is given the e-mail becomes required — that is how they log in.
      if (!body.email) {
        res.status(400).send({ msg: "Informe o e-mail do aluno para liberar o acesso." });
        return;
      }
      if (String(body.password).length < 6) {
        res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
        return;
      }
    }
    if (body.email) {
      const exists = await app.api.user.dataByEmail(body.email);
      if (exists) {
        res.status(409).send({ msg: "Já existe um usuário com esse e-mail." });
        return;
      }
    }

    const id = await app.api.user.insertStudent(trainer._id, body);
    res.status(201).send(app.api.user.filter(await app.api.user.data(id)));
  });

  app.put("/students/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const body = req.body || {};
    const target = await app.api.user.dataStudent(trainer._id, req.params.id);

    if (!target) {
      res.status(404).send({ msg: "Aluno não encontrado." });
      return;
    }

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do aluno." });
      return;
    }
    if (body.email && !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: "E-mail do aluno inválido." });
      return;
    }
    if (body.password) {
      const finalEmail = body.email !== undefined ? body.email : target.email;
      if (!finalEmail) {
        res.status(400).send({ msg: "Informe o e-mail do aluno para liberar o acesso." });
        return;
      }
      if (String(body.password).length < 6) {
        res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
        return;
      }
    }
    if (body.email) {
      const exists = await app.api.user.dataByEmail(body.email);
      if (exists && String(exists._id) !== String(target._id)) {
        res.status(409).send({ msg: "Já existe um usuário com esse e-mail." });
        return;
      }
    }

    await app.api.user.updateStudent(trainer._id, req.params.id, body);
    res.send(app.api.user.filter(await app.api.user.data(req.params.id)));
  });

  // Revokes the student's login while keeping the profile.
  app.delete("/students/:id/access", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const ok = await app.api.user.revokeStudentAccess(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Aluno não encontrado." });
      return;
    }

    await app.api.auth.deleteAllTokensByUser(req.params.id);
    res.send({ msg: "Acesso revogado." });
  });

  app.delete("/students/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const ok = await app.api.user.deleteStudent(trainer._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: "Aluno não encontrado." });
      return;
    }

    await app.api.auth.deleteAllTokensByUser(req.params.id);
    res.send({ msg: "Aluno removido." });
  });
};
