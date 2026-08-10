module.exports = function (app) {
  // The "Clients" menu — admin only. Here the admin registers and manages the
  // platform's TRAINERS, who in turn register their own students.

  app.get("/clients", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "clients.view");
    if (admin === false) return;

    res.send(await app.api.user.listTrainers({ search: req.query.search, active: req.query.active }));
  });

  app.get("/clients/summary", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "clients.view");
    if (admin === false) return;

    res.send(await app.api.user.platformSummary());
  });

  app.get("/clients/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "clients.view");
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
    const admin = await app.helpers.ReqProtected.can(req, res, "clients.manage");
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

    // The type comes from the body but is CHECKED here: an id that is not a
    // real role would create an account with no permissions at all, and one
    // that is not sent at all falls back to the plain professional type.
    let role = req.body.role ? await app.api.role.data(req.body.role) : undefined;
    if (req.body.role && !role) {
      res.status(400).send({ msg: "Tipo de usuário inválido." });
      return;
    }
    if (!role) role = await app.api.role.dataByName("Profissional");

    const id = await app.api.user.insertTrainer({
      name,
      email,
      password,
      phone,
      active,
      role: role ? role._id : null,
      admin: req.body.admin === true,
    });

    const created = await app.api.user.data(id);

    app.insertUserActionHistory(req, admin, "create_professional", {
      category: "admin",
      local: { target_type: "users", target_id: id + "" },
      extra: { name: created.name, email: created.email, role: role ? role.name : null },
    });

    res.status(201).send(await app.api.user.withRole(created));
  });

  app.put("/clients/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "clients.manage");
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

    if (body.role !== undefined && !(await app.api.role.data(body.role))) {
      res.status(400).send({ msg: "Tipo de usuário inválido." });
      return;
    }

    // Somebody active must keep the power to hand permissions out. A type
    // change, dropping the master switch or a deactivation can each take the
    // last one away, so the check looks at what this account will be able to
    // do AFTER the change.
    const wasManager = await app.api.user.hasPermission(target, "roles.manage");
    const staysAdmin = body.admin !== undefined ? body.admin === true : target.admin === true;
    const willManage =
      staysAdmin ||
      (body.role !== undefined
        ? await app.api.role.grants(body.role, "roles.manage")
        : await app.api.role.grants(target.role, "roles.manage"));
    const staysActive = body.active !== undefined ? !!Number(body.active) : target.active === 1;

    if (wasManager && (!willManage || !staysActive)) {
      const others = await app.api.role.countActiveUsersWith("roles.manage", target._id);
      if (others === 0) {
        res.status(409).send({
          msg: "Esta é a última conta ativa que gerencia permissões — promova outra antes de alterar esta.",
        });
        return;
      }
    }

    await app.api.user.updateTrainer(req.params.id, body);

    // A deactivated professional must not keep browsing with the session they
    // already had — the guard only runs on the next request.
    if (body.active !== undefined && !Number(body.active)) {
      await app.api.auth.deleteAllTokensByUser(req.params.id);
    }

    const updated = await app.api.user.data(req.params.id);

    app.insertUserActionHistory(req, admin, "update_professional", {
      category: "admin",
      local: { target_type: "users", target_id: req.params.id + "" },
      extra: { name: updated.name },
      diff: app.api.actionHistory.diff(target, updated),
    });

    res.send(await app.api.user.withRole(updated));
  });

  app.delete("/clients/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "clients.manage");
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

    if (await app.api.user.hasPermission(target, "roles.manage")) {
      const others = await app.api.role.countActiveUsersWith("roles.manage", target._id);
      if (others === 0) {
        res.status(409).send({ msg: "Esta é a última conta ativa que gerencia permissões." });
        return;
      }
    }

    // Deleting a professional who still follows people would cut those links
    // silently. Make the decision explicit: deactivate them or unlink first.
    const people = await app.api.user.countStudentsOfTrainer(target._id);
    if (people > 0) {
      res.status(409).send({
        msg:
          "Este profissional acompanha " +
          people +
          (people === 1 ? " pessoa" : " pessoas") +
          ". Desative a conta ou remova os vínculos antes de excluir.",
      });
      return;
    }

    await app.api.user.deleteTrainer(req.params.id);
    await app.api.auth.deleteAllTokensByUser(req.params.id);

    app.insertUserActionHistory(req, admin, "delete_professional", {
      category: "admin",
      local: { target_type: "users", target_id: req.params.id + "" },
      extra: { name: target.name, email: target.email },
    });

    res.send({ msg: "Personal removido." });
  });
};
