module.exports = function (app) {
  // The "Users" menu — admin only. Everything the platform has, in one list,
  // with no ownership filter: professionals, people, admins.
  //
  // This replaced the old Clients screen, which listed the same professionals
  // with a narrower filter and a different permission. The only thing it could
  // do that this one could not was CREATE, so creating moved here (POST below)
  // and the screen was retired instead of kept as a near-duplicate.

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
      res.status(404).send({ msg: req.t("errors.userNotFound") });
      return;
    }

    res.send({
      ...(await app.api.user.withRole(user)),
      totalStudents: await app.api.link.countPeopleOf(user._id),
      totalProfessionals: await app.api.link.countProfessionalsOf(user._id),
    });
  });

  // Creating an account here always makes a PROFESSIONAL. Someone being
  // followed is added by a professional through the e-mail flow, which is what
  // creates the link — one made here would exist with nobody following them,
  // which is not a state any screen can act on.
  app.post("/users", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (admin === false) return;

    const { name, email, password, phone, active } = req.body || {};

    if (!name || String(name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireName") });
      return;
    }
    if (!email || !app.validator.isEmail(String(email).trim())) {
      res.status(400).send({ msg: req.t("errors.invalidEmail") });
      return;
    }
    if (!password || String(password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }

    const exists = await app.api.user.dataByEmail(email);
    if (exists) {
      res.status(409).send({ msg: req.t("errors.userWithEmailExists") });
      return;
    }

    // The type comes from the body but is CHECKED here: an id that is not a
    // real role would create an account with no permissions at all, and one
    // not sent at all falls back to the plain professional type.
    let role = req.body.role ? await app.api.role.data(req.body.role) : undefined;
    if (req.body.role && !role) {
      res.status(400).send({ msg: req.t("errors.invalidRole") });
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
      extra: {
        name: created.name,
        email: created.email,
        role: role ? role.name : null,
        admin: created.admin === true,
      },
    });

    res.status(201).send(await app.api.user.withRole(created));
  });

  app.put("/users/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (admin === false) return;

    const target = await app.api.user.data(req.params.id);
    if (!target) {
      res.status(404).send({ msg: req.t("errors.userNotFound") });
      return;
    }

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireName") });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }
    if (body.type !== undefined && !["trainer", "student"].includes(String(body.type))) {
      res.status(400).send({ msg: req.t("errors.invalidType") });
      return;
    }
    if (body.email !== undefined && String(body.email).trim() !== "") {
      if (!app.validator.isEmail(String(body.email).trim())) {
        res.status(400).send({ msg: req.t("errors.invalidEmail") });
        return;
      }
      const exists = await app.api.user.dataByEmail(body.email);
      if (exists && String(exists._id) !== String(target._id)) {
        res.status(409).send({ msg: req.t("errors.emailInUse") });
        return;
      }
    }

    if (body.role !== undefined && !(await app.api.role.data(body.role))) {
      res.status(400).send({ msg: req.t("errors.invalidRole") });
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
          msg: req.t("errors.lastAccountManagingRolesEdit"),
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

    const updated = await app.api.user.data(req.params.id);

    app.insertUserActionHistory(req, admin, "update_user", {
      category: "admin",
      local: { target_type: "users", target_id: req.params.id + "" },
      extra: { name: updated.name, email: updated.email },
      diff: app.api.actionHistory.diff(target, updated),
    });

    res.send(await app.api.user.withRole(updated));
  });

  app.delete("/users/:id", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (admin === false) return;

    if (String(req.params.id) === String(admin._id)) {
      res.status(409).send({ msg: req.t("errors.cannotDeleteSelf") });
      return;
    }

    const target = await app.api.user.data(req.params.id);
    if (!target) {
      res.status(404).send({ msg: req.t("errors.userNotFound") });
      return;
    }

    if (await app.api.user.hasPermission(target, "roles.manage")) {
      const others = await app.api.role.countActiveUsersWith("roles.manage", target._id);
      if (others === 0) {
        res.status(409).send({ msg: req.t("errors.lastAccountManagingRoles") });
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

    app.insertUserActionHistory(req, admin, "delete_user", {
      category: "admin",
      local: { target_type: "users", target_id: req.params.id + "" },
      extra: { name: target.name, email: target.email, type: target.type },
    });

    res.send({ msg: req.t("ok.userRemoved") });
  });
};
