module.exports = function (app) {
  // Gestão de alunos — só trainer. O id do dono nunca vem do body ou da
  // query: sai sempre da sessão, então um trainer não alcança student de outro.

  app.get("/alunos", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    res.send(
      await app.api.user.listStudents(trainer._id, {
        busca: req.query.busca,
        active: req.query.active,
      })
    );
  });

  app.get("/alunos/resumo", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    res.send(await app.api.user.studentsSummary(trainer._id));
  });

  app.get("/alunos/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const student = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!student) {
      res.status(404).send({ msg: "Aluno não encontrado." });
      return;
    }

    res.send(app.api.user.filter(student));
  });

  app.post("/alunos", async function (req, res) {
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
      // Senha é opcional (a ficha pode existir sem acesso), mas se veio uma,
      // precisa de e-mail — é por ele que o aluno loga.
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
      const existe = await app.api.user.dataByEmail(body.email);
      if (existe) {
        res.status(409).send({ msg: "Já existe um usuário com esse e-mail." });
        return;
      }
    }

    const id = await app.api.user.insertStudent(trainer._id, body);
    res.status(201).send(app.api.user.filter(await app.api.user.data(id)));
  });

  app.put("/alunos/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verifyTrainer(req, res);
    if (trainer === false) return;

    const body = req.body || {};
    const alvo = await app.api.user.dataStudent(trainer._id, req.params.id);

    if (!alvo) {
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
      const emailFinal = body.email !== undefined ? body.email : alvo.email;
      if (!emailFinal) {
        res.status(400).send({ msg: "Informe o e-mail do aluno para liberar o acesso." });
        return;
      }
      if (String(body.password).length < 6) {
        res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
        return;
      }
    }
    if (body.email) {
      const existe = await app.api.user.dataByEmail(body.email);
      if (existe && String(existe._id) !== String(alvo._id)) {
        res.status(409).send({ msg: "Já existe um usuário com esse e-mail." });
        return;
      }
    }

    await app.api.user.updateStudent(trainer._id, req.params.id, body);
    res.send(app.api.user.filter(await app.api.user.data(req.params.id)));
  });

  // Tira o login do aluno mantendo a ficha.
  app.delete("/alunos/:id/acesso", async function (req, res) {
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

  app.delete("/alunos/:id", async function (req, res) {
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
