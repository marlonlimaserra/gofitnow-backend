module.exports = function (app) {
  // The people a professional follows — professional only.
  //
  // The professional id never comes from the body or the query: it always
  // comes from the session, and every read goes through the link, so one
  // professional can never reach a person who did not let them in.
  //
  // The routes are still /students because that is what the whole app calls
  // them internally (and what workouts and sessions point at). The screens say
  // "pessoas" — a person here may be a patient, a student or a client
  // depending on who is looking.

  app.get("/students", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    res.send(
      await app.api.user.listStudents(trainer._id, {
        search: req.query.search,
        active: req.query.active,
      })
    );
  });

  app.get("/students/summary", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    res.send(await app.api.user.studentsSummary(trainer._id));
  });

  app.get("/students/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    const student = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!student) {
      res.status(404).send({ msg: "Pessoa não encontrada." });
      return;
    }

    res.send(app.api.user.filter(student));
  });

  app.post("/students", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (trainer === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome da pessoa." });
      return;
    }
    if (body.email && !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: "E-mail inválido." });
      return;
    }
    if (body.password) {
      // The password is optional (a profile can exist without access), but if
      // one is given the e-mail becomes required — that is how they log in.
      if (!body.email) {
        res.status(400).send({ msg: "Informe o e-mail para liberar o acesso." });
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
        // Registering a second copy of someone who is already here is exactly
        // what this app exists to stop. The way in is to ask them.
        res.status(409).send({
          msg: "Já existe uma conta com esse e-mail. Peça acesso a ela em vez de cadastrar de novo.",
          code: "email_taken",
        });
        return;
      }
    }

    // Someone being followed always starts as "Pessoa". The type is resolved
    // here and never taken from the body, so a crafted request cannot create
    // an account with more power than the screen offers.
    const role = await app.api.role.dataByName("Pessoa");

    const id = await app.api.user.insertStudent(trainer._id, { ...body, role: role?._id });
    res.status(201).send(app.api.user.filter(await app.api.user.data(id)));
  });

  app.put("/students/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const body = req.body || {};
    const target = await app.api.user.dataStudent(trainer._id, req.params.id);

    if (!target) {
      res.status(404).send({ msg: "Pessoa não encontrada." });
      return;
    }

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome da pessoa." });
      return;
    }
    if (body.email && !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: "E-mail inválido." });
      return;
    }
    if (body.password) {
      const finalEmail = body.email !== undefined ? body.email : target.email;
      if (!finalEmail) {
        res.status(400).send({ msg: "Informe o e-mail para liberar o acesso." });
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

  // Revokes the person's login while keeping the profile.
  app.delete("/students/:id/access", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.access");
    if (trainer === false) return;

    const target = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Pessoa não encontrada." });
      return;
    }

    // Only whoever created the profile can take the login away. Getting access
    // by request must never come with the power to lock the person out of an
    // account that is theirs.
    const ok = await app.api.user.revokeStudentAccess(trainer._id, req.params.id);
    if (!ok) {
      res.status(409).send({
        msg: "Essa conta é da própria pessoa — só ela pode mudar o acesso dela.",
      });
      return;
    }

    await app.api.auth.deleteAllTokensByUser(req.params.id);
    res.send({ msg: "Acesso revogado." });
  });

  // "Remove from my list" and "erase this person" are the same button to the
  // professional, but they must not be the same operation: with several
  // professionals per person, deleting the document would wipe someone else's
  // patient. So the row only really disappears when this professional is the
  // last one and the profile never became an account of its own.
  app.delete("/students/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.delete");
    if (trainer === false) return;

    const target = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Pessoa não encontrada." });
      return;
    }

    const others = (await app.api.link.countProfessionalsOf(target._id)) - 1;
    const ownsItself = !!target.password;

    if (others > 0 || ownsItself) {
      await app.api.user.unlinkStudent(trainer._id, req.params.id);
      res.send({ msg: "Pessoa removida da sua lista.", removed: "unlinked" });
      return;
    }

    await app.api.user.deleteStudent(trainer._id, req.params.id);
    await app.api.auth.deleteAllTokensByUser(req.params.id);

    res.send({ msg: "Pessoa excluída.", removed: "deleted" });
  });
};
