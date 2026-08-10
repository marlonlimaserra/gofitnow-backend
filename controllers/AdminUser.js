module.exports = function (app) {
  // The "Users" menu — admin only. Everything the platform has, in one list,
  // with no ownership filter: professionals, people, admins.
  //
  // The Clients screen still exists and is narrower on purpose (it registers
  // professionals). This one is the full view for whoever runs the platform.

  app.get("/users", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.view");
    if (admin === false) return;

    res.send(
      await app.api.user.listAll({
        search: req.query.search,
        type: req.query.type,
        active: req.query.active,
        role: req.query.role,
      })
    );
  });

  app.get("/users/summary", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.view");
    if (admin === false) return;

    res.send(await app.api.user.platformSummary());
  });

  app.get("/users/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.view");
    if (admin === false) return;

    const user = await app.api.user.data(req.params.id);
    if (!user) {
      res.status(404).send({ msg: "Usuário não encontrado." });
      return;
    }

    res.send({
      ...(await app.api.user.withRole(user)),
      totalStudents: await app.api.link.countPeopleOf(user._id),
      totalProfessionals: await app.api.link.countProfessionalsOf(user._id),
    });
  });

  app.put("/users/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (admin === false) return;

    const target = await app.api.user.data(req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Usuário não encontrado." });
      return;
    }

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome." });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: "A senha precisa ter no mínimo 6 caracteres." });
      return;
    }
    if (body.type !== undefined && !["trainer", "student"].includes(String(body.type))) {
      res.status(400).send({ msg: "Tipo inválido." });
      return;
    }
    if (body.email !== undefined && String(body.email).trim() !== "") {
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

    // The one door that must never close: somebody active has to keep the
    // power to hand permissions out. Changing the type, dropping the master
    // switch or deactivating can each take the last one away, so the check
    // looks at what the account will be able to do AFTER the change.
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

    // Turning a professional into a person would leave the people they follow
    // attached to someone who no longer has a professional's screens.
    if (body.type === "student" && target.type === "trainer") {
      const following = await app.api.link.countPeopleOf(target._id);
      if (following > 0) {
        res.status(409).send({
          msg:
            "Este profissional acompanha " +
            following +
            (following === 1 ? " pessoa" : " pessoas") +
            ". Remova esses vínculos antes de mudar o tipo.",
        });
        return;
      }
    }

    await app.api.user.updateAny(req.params.id, body);

    // A deactivated user must not keep browsing with the session they already
    // had — the guard only runs on the next request, so drop the tokens now.
    if (body.active !== undefined && !Number(body.active)) {
      await app.api.auth.deleteAllTokensByUser(req.params.id);
    }

    res.send(await app.api.user.withRole(await app.api.user.data(req.params.id)));
  });

  app.delete("/users/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (admin === false) return;

    if (String(req.params.id) === String(admin._id)) {
      res.status(409).send({ msg: "Você não pode excluir a própria conta." });
      return;
    }

    const target = await app.api.user.data(req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Usuário não encontrado." });
      return;
    }

    if (await app.api.user.hasPermission(target, "roles.manage")) {
      const others = await app.api.role.countActiveUsersWith("roles.manage", target._id);
      if (others === 0) {
        res.status(409).send({ msg: "Esta é a última conta ativa que gerencia permissões." });
        return;
      }
    }

    // Deleting a professional who still follows people would silently cut
    // those links. Make the decision explicit instead.
    const following = await app.api.link.countPeopleOf(target._id);
    if (following > 0) {
      res.status(409).send({
        msg:
          "Este profissional acompanha " +
          following +
          (following === 1 ? " pessoa" : " pessoas") +
          ". Desative a conta ou remova os vínculos antes de excluir.",
      });
      return;
    }

    await app.api.user.deleteAny(req.params.id);
    await app.api.auth.deleteAllTokensByUser(req.params.id);

    res.send({ msg: "Usuário removido." });
  });
};
