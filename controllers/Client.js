module.exports = function (app) {
  // The "Clients" menu — admin only. Here the admin registers and manages the
  // platform's TRAINERS, who in turn register their own students.

  app.get("/clients", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    res.send(await app.api.user.listTrainers({ search: req.query.search, active: req.query.active }));
  });

  app.get("/clients/summary", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    res.send(await app.api.user.platformSummary());
  });

  app.get("/clients/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    const trainer = await app.api.user.dataTrainer(req.params.id);
    if (!trainer) {
      res.status(404).send({ msg: "Personal não encontrado." });
      return;
    }

    res.send({
      ...app.api.user.filter(trainer),
      totalStudents: await app.api.user.countStudentsOfTrainer(trainer._id),
    });
  });

  app.post("/clients", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    const { name, email, password, phone, active } = req.body || {};

    if (!name || String(name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do personal." });
      return;
    }
    if (!email || !app.validator.isEmail(String(email).trim())) {
      res.status(400).send({ msg: "E-mail inválido." });
      return;
    }
    if (!password || String(password).length < 6) {
      res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
      return;
    }

    const exists = await app.api.user.dataByEmail(email);
    if (exists) {
      res.status(409).send({ msg: "Já existe um usuário com esse e-mail." });
      return;
    }

    const id = await app.api.user.insertTrainer({
      name,
      email,
      password,
      phone,
      active,
      admin: req.body.admin === true,
    });

    res.status(201).send(app.api.user.filter(await app.api.user.data(id)));
  });

  app.put("/clients/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    const target = await app.api.user.dataTrainer(req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Personal não encontrado." });
      return;
    }

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do personal." });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
      return;
    }
    if (body.email !== undefined) {
      if (!app.validator.isEmail(String(body.email).trim())) {
        res.status(400).send({ msg: "E-mail inválido." });
        return;
      }
      const exists = await app.api.user.dataByEmail(body.email);
      if (exists && String(exists._id) !== String(target._id)) {
        res.status(409).send({ msg: "Esse e-mail já está em uso." });
        return;
      }
    }

    // Last-admin guard: without it you could drop your own admin flag (or
    // deactivate the account) and leave nobody able to open this menu.
    const losesAdmin =
      (body.admin === false && target.admin === true) ||
      (body.active !== undefined && !Number(body.active) && target.admin === true);

    if (losesAdmin && (await app.api.user.countAdmins()) <= 1) {
      res.status(409).send({
        msg: "Este é o último administrador ativo — promova outro antes de alterar este.",
      });
      return;
    }

    await app.api.user.updateTrainer(req.params.id, body);
    res.send(app.api.user.filter(await app.api.user.data(req.params.id)));
  });

  app.delete("/clients/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    if (String(req.params.id) === String(admin._id)) {
      res.status(409).send({ msg: "Você não pode excluir a própria conta." });
      return;
    }

    const target = await app.api.user.dataTrainer(req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Personal não encontrado." });
      return;
    }

    if (target.admin === true && (await app.api.user.countAdmins()) <= 1) {
      res.status(409).send({ msg: "Este é o último administrador ativo." });
      return;
    }

    // Deleting a trainer who still has students would orphan their profiles
    // (`trainer` would point at an id that no longer exists). Better to block
    // it and make the decision explicit: deactivate them or move the students.
    const students = await app.api.user.countStudentsOfTrainer(target._id);
    if (students > 0) {
      res.status(409).send({
        msg:
          "Este personal tem " +
          students +
          (students === 1 ? " aluno vinculado" : " alunos vinculados") +
          ". Desative a conta ou remova os alunos antes de excluir.",
      });
      return;
    }

    await app.api.user.deleteTrainer(req.params.id);
    await app.api.auth.deleteAllTokensByUser(req.params.id);

    res.send({ msg: "Personal removido." });
  });
};
