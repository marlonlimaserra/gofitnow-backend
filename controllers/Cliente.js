module.exports = function (app) {
  // Menu "Clientes" — só admin. Aqui o admin cadastra e administra os
  // TRAINERS da plataforma (que por sua vez cadastram seus students).

  app.get("/clientes", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    res.send(
      await app.api.user.listTrainers({ busca: req.query.busca, active: req.query.active })
    );
  });

  app.get("/clientes/resumo", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    res.send(await app.api.user.platformSummary());
  });

  app.get("/clientes/:id", async function (req, res) {
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

  app.post("/clientes", async function (req, res) {
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

    const existe = await app.api.user.dataByEmail(email);
    if (existe) {
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

  app.put("/clientes/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    const alvo = await app.api.user.dataTrainer(req.params.id);
    if (!alvo) {
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
      const existe = await app.api.user.dataByEmail(body.email);
      if (existe && String(existe._id) !== String(alvo._id)) {
        res.status(409).send({ msg: "Esse e-mail já está em uso." });
        return;
      }
    }

    // Trava do último admin: sem ela dá pra tirar o próprio admin (ou
    // desativar a conta) e ficar sem ninguém capaz de abrir este menu.
    const perdeAdmin =
      (body.admin === false && alvo.admin === true) ||
      (body.active !== undefined && !Number(body.active) && alvo.admin === true);

    if (perdeAdmin && (await app.api.user.countAdmins()) <= 1) {
      res.status(409).send({
        msg: "Este é o último administrador ativo — promova outro antes de alterar este.",
      });
      return;
    }

    await app.api.user.updateTrainer(req.params.id, body);
    res.send(app.api.user.filter(await app.api.user.data(req.params.id)));
  });

  app.delete("/clientes/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.verifyAdmin(req, res);
    if (admin === false) return;

    if (String(req.params.id) === String(admin._id)) {
      res.status(409).send({ msg: "Você não pode excluir a própria conta." });
      return;
    }

    const alvo = await app.api.user.dataTrainer(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: "Personal não encontrado." });
      return;
    }

    if (alvo.admin === true && (await app.api.user.countAdmins()) <= 1) {
      res.status(409).send({ msg: "Este é o último administrador ativo." });
      return;
    }

    // Excluir um trainer com students deixaria as fichas órfãs (o `trainer`
    // apontaria pra um id que não existe mais). Melhor barrar e deixar a
    // decisão explícita: desative o trainer ou mova os alunos antes.
    const students = await app.api.user.countStudentsOfTrainer(alvo._id);
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
