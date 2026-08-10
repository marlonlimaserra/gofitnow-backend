module.exports = function (app) {
  // The people a professional follows — professional only.
  //
  // The professional id never comes from the body or the query: it always
  // comes from the session, and every read goes through the link, so one
  // professional can never reach a person who did not let them in.
  //
  // The routes are /people. The MODELS and the database still say student,
  // because that is what workouts and sessions point at. The screens say the
  // word each professional chose — aluno, paciente, cliente — for the same
  // record.

  app.get("/people", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    res.send(
      await app.api.user.listStudents(trainer._id, {
        search: req.query.search,
        active: req.query.active,
      })
    );
  });

  app.get("/people/summary", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    res.send(await app.api.user.studentsSummary(trainer._id));
  });

  app.get("/people/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    const student = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!student) {
      res.status(404).send({ msg: "Pessoa não encontrada." });
      return;
    }

    const notes = await app.api.link.notesOf(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "view_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: student.name },
    });

    res.send({ ...app.api.user.filter(student), notes });
  });

  app.post("/people", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (trainer === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome da pessoa." });
      return;
    }
    // The e-mail is REQUIRED, always. It is the identity of a person across
    // professionals: a record without one cannot be found by anyone else, so
    // the same human would end up registered twice — the exact duplication
    // this app exists to remove.
    if (!body.email || !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: "Informe o e-mail da pessoa." });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
      return;
    }
    {
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

    // A observacao e do profissional, nao da pessoa: fica no vinculo.
    if (body.notes) await app.api.link.setNotes(trainer._id, id, body.notes);

    const created = await app.api.user.data(id);

    app.insertUserActionHistory(req, trainer, "create_person", {
      category: "people",
      local: { target_type: "people", target_id: id + "" },
      extra: { name: created.name, email: created.email, hasAccess: !!created.password },
    });

    res.status(201).send(app.api.user.filter(created));
  });

  app.put("/people/:id", async function (req, res) {
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
    // Sending the field at all means it has to be valid: a person cannot be
    // left without an e-mail, because that is what makes their record findable
    // by the other professionals who care for them. Not sending it keeps
    // whatever is stored, so a partial update still works.
    if (body.email !== undefined && !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: "Informe o e-mail da pessoa." });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
      return;
    }
    if (body.email) {
      const exists = await app.api.user.dataByEmail(body.email);
      if (exists && String(exists._id) !== String(target._id)) {
        res.status(409).send({ msg: "Já existe um usuário com esse e-mail." });
        return;
      }
    }

    await app.api.user.updateStudent(trainer._id, req.params.id, body);

    if (body.notes !== undefined) {
      await app.api.link.setNotes(trainer._id, req.params.id, body.notes);
    }

    const updated = await app.api.user.data(req.params.id);

    app.insertUserActionHistory(req, trainer, "update_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: updated.name },
      diff: app.api.actionHistory.diff(target, updated),
    });

    res.send({
      ...app.api.user.filter(updated),
      notes: await app.api.link.notesOf(trainer._id, req.params.id),
    });
  });

  // Revokes the person's login while keeping the profile.
  app.delete("/people/:id/access", async function (req, res) {
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

    app.insertUserActionHistory(req, trainer, "revoke_person_access", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: target.name },
    });

    res.send({ msg: "Acesso revogado." });
  });

  // "Remove from my list" and "erase this person" are the same button to the
  // professional, but they must not be the same operation: with several
  // professionals per person, deleting the document would wipe someone else's
  // patient. So the row only really disappears when this professional is the
  // last one and the profile never became an account of its own.
  app.delete("/people/:id", async function (req, res) {
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

      app.insertUserActionHistory(req, trainer, "unlink_person", {
        category: "people",
        local: { target_type: "people", target_id: req.params.id + "" },
        extra: { name: target.name, reason: others > 0 ? "outros_profissionais" : "conta_propria" },
      });

      res.send({ msg: "Pessoa removida da sua lista.", removed: "unlinked" });
      return;
    }

    await app.api.user.deleteStudent(trainer._id, req.params.id);
    await app.api.auth.deleteAllTokensByUser(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: target.name, email: target.email },
    });

    res.send({ msg: "Pessoa excluída.", removed: "deleted" });
  });
};
