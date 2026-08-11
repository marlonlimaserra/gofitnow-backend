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
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    const notes = await app.api.link.notesOf(trainer._id, req.params.id);
    const active = await app.api.link.activeOf(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "view_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: student.name },
    });

    res.send({ ...app.api.user.filter(student), notes, active });
  });

  app.post("/people", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (trainer === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requirePersonName") });
      return;
    }
    // The e-mail is REQUIRED, always. It is the identity of a person across
    // professionals: a record without one cannot be found by anyone else, so
    // the same human would end up registered twice — the exact duplication
    // this app exists to remove.
    if (!body.email || !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: req.t("errors.requirePersonEmail") });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }
    {
      const exists = await app.api.user.dataByEmail(body.email);
      if (exists) {
        // Registering a second copy of someone who is already here is exactly
        // what this app exists to stop. The way in is to ask them.
        res.status(409).send({
          msg: req.t("errors.accountExistsAskAccess"),
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
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requirePersonName") });
      return;
    }
    // Sending the field at all means it has to be valid: a person cannot be
    // left without an e-mail, because that is what makes their record findable
    // by the other professionals who care for them. Not sending it keeps
    // whatever is stored, so a partial update still works.
    if (body.email !== undefined && !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: req.t("errors.requirePersonEmail") });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }
    // O e-mail de uma pessoa que JÁ existe não se troca por aqui.
    //
    // Ele é a identidade dela entre profissionais: é por ele que outro
    // profissional a encontra em vez de cadastrar tudo de novo, e é com ele que
    // ela entra no app. Deixar um profissional trocá-lo permitiria apontar a
    // ficha para outra pessoa — ou reivindicar o endereço de quem já tem conta.
    // Quem troca é a própria pessoa, em Meu perfil (PUT /me).
    //
    // Mandar o e-mail ATUAL continua valendo: o formulário envia a ficha inteira,
    // e recusar um valor igual ao que já está gravado só quebraria o salvar.
    if (body.email !== undefined) {
      const enviado = String(body.email).trim().toLowerCase();
      const atual = String(target.email || "").trim().toLowerCase();
      if (enviado !== atual) {
        res.status(403).send({
          msg: req.t("errors.emailNotEditable"),
          code: "email_not_editable",
        });
        return;
      }
    }

    // Sai do corpo em vez de só ser recusado acima: o modelo não deve nem ter a
    // chance de gravar o campo.
    const { email, ...semEmail } = body;

    await app.api.user.updateStudent(trainer._id, req.params.id, semEmail);

    // Observação e status são do VÍNCULO, não da pessoa: cada profissional tem
    // os seus. Marcar inativo aqui não bloqueia o login de ninguém — isso é o
    // `active` da conta, alterado em Usuários.
    if (body.notes !== undefined) {
      await app.api.link.setNotes(trainer._id, req.params.id, body.notes);
    }
    if (body.active !== undefined) {
      await app.api.link.setActive(trainer._id, req.params.id, body.active);
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
      active: await app.api.link.activeOf(trainer._id, req.params.id),
    });
  });

  // Revokes the person's login while keeping the profile.
  app.delete("/people/:id/access", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.access");
    if (trainer === false) return;

    const target = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!target) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    // Only whoever created the profile can take the login away. Getting access
    // by request must never come with the power to lock the person out of an
    // account that is theirs.
    const ok = await app.api.user.revokeStudentAccess(trainer._id, req.params.id);
    if (!ok) {
      res.status(409).send({
        msg: req.t("errors.ownAccountAccess"),
      });
      return;
    }

    await app.api.auth.deleteAllTokensByUser(req.params.id);

    app.insertUserActionHistory(req, trainer, "revoke_person_access", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: target.name },
    });

    res.send({ msg: req.t("ok.accessRevoked") });
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
      res.status(404).send({ msg: req.t("errors.personNotFound") });
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

      res.send({ msg: req.t("ok.personUnlinked"), removed: "unlinked" });
      return;
    }

    await app.api.user.deleteStudent(trainer._id, req.params.id);
    await app.api.auth.deleteAllTokensByUser(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: target.name, email: target.email },
    });

    res.send({ msg: req.t("ok.personDeleted"), removed: "deleted" });
  });
};
