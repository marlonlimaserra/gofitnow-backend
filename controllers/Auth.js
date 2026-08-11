const { passwordReset } = require("../lib/emailTemplates.js");

module.exports = function (app) {
  // Self-signup — always creates a plain PROFISSIONAL. The role is looked up
  // here and never read from the body: otherwise anyone could sign up asking
  // to be an Administrador.
  app.post("/auth/register", async function (req, res) {
    const { name, email, password } = req.body || {};

    if (!name || String(name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireOwnName") });
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
      res.status(409).send({ msg: req.t("errors.accountWithEmailExists") });
      return;
    }

    const role = await app.api.role.dataByName("Profissional");

    const id = await app.api.user.insertTrainer({
      name,
      email,
      password,
      role: role ? role._id : null,
    });
    const token = await app.api.auth.registerToken(id);
    const user = await app.api.user.data(id);

    app.insertUserActionHistory(req, user, "register", {
      category: "auth",
      local: { target_type: "users", target_id: id + "" },
      extra: { name: user.name, email: user.email, self_signup: true },
    });

    res.status(201).send({ session: token, user: await app.api.user.withRole(user) });
  });

  // Login — professional and person come through the same door; the frontend
  // decides what to show from `type` and the permission list.
  app.post("/auth", async function (req, res) {
    const { email, password } = req.body || {};

    if (!email || !password) {
      res.status(400).send({ msg: req.t("errors.requireEmailAndPassword") });
      return;
    }

    const user = await app.api.user.authenticate(email, password);

    // Deliberately generic message: saying "this e-mail does not exist" would
    // reveal which addresses have an account. Same for a student whose access
    // has not been granted yet.
    if (!user) {
      // A tentativa que falha e a mais interessante do log: e ela que mostra
      // ataque de senha. O e-mail vai como digitado, sem confirmar se existe.
      app.insertUserActionHistory(req, null, "login_failed", {
        category: "auth",
        extra: { email: String(email).trim().toLowerCase() },
      });

      res.status(401).send({ msg: req.t("errors.badCredentials") });
      return;
    }

    const token = await app.api.auth.registerToken(user._id);

    app.insertUserActionHistory(req, user, "login", { category: "auth" });

    res.send({ session: token, user: await app.api.user.withRole(user) });
  });

  // Revalidates the session when the frontend boots.
  app.get("/auth/verify", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({ user: user });
  });

  app.post("/auth/logout", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    await app.api.auth.deleteToken(req._token);

    app.insertUserActionHistory(req, user, "logout", { category: "auth" });

    res.send({ msg: req.t("ok.signedOut") });
  });

  // ── Forgot password ─────────────────────────────────────────────────────
  // Always answers 200, even when the e-mail has no account. A different
  // answer would turn this into a way to discover which addresses exist.
  app.post("/auth/forgot-password", async function (req, res) {
    const { email } = req.body || {};

    const generic = {
      msg: req.t("ok.resetLinkSent"),
    };

    if (!email || !app.validator.isEmail(String(email).trim())) {
      res.send(generic);
      return;
    }

    const user = await app.api.user.dataByEmail(email);

    // A student registered as a profile only (no password yet) has nothing to
    // reset — their trainer grants access first.
    if (!user || user.active === 0 || !user.password) {
      res.send(generic);
      return;
    }

    const token = await app.api.passwordReset.create(user._id);
    const url = `${app.helpers.mailer.appUrl()}/reset-password?token=${token}`;

    app.insertUserActionHistory(req, user, "forgot_password", {
      category: "auth",
      local: { target_type: "users", target_id: user._id + "" },
    });

    const mail = passwordReset({
      // Idioma de QUEM RECEBE: quem lê o e-mail é o dono da conta, não quem
      // disparou o pedido — que, aqui, é a mesma pessoa, mas nos outros dois
      // e-mails não é.
      lang: user.lang,
      name: user.name,
      url: url,
      minutes: app.api.passwordReset.validityMinutes,
    });

    try {
      const sent = await app.helpers.mailer.send({ to: user.email, ...mail });
      // In test mode the preview URL is the only way to read the message, so
      // it rides along in the response. Never in production.
      if (sent.preview) generic.preview = sent.preview;
    } catch (error) {
      // The token is already stored; failing to e-mail is an infrastructure
      // problem, not something the caller can act on. Log it and keep the
      // answer generic.
      console.error("[forgot-password] could not send e-mail:", error.message);
    }

    res.send(generic);
  });

  // Checks the link before showing the form, so the user is not asked to type
  // a new password only to be told the token expired.
  app.get("/auth/reset-password/:token", async function (req, res) {
    const reset = await app.api.passwordReset.verify(req.params.token);
    if (!reset) {
      res.status(400).send({ msg: req.t("errors.invalidOrExpiredLink") });
      return;
    }

    const user = await app.api.user.data(reset.user);
    if (!user) {
      res.status(400).send({ msg: req.t("errors.invalidOrExpiredLink") });
      return;
    }

    res.send({ valid: true, name: user.name, email: user.email });
  });

  app.post("/auth/reset-password", async function (req, res) {
    const { token, password } = req.body || {};

    if (!password || String(password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }

    const reset = await app.api.passwordReset.verify(token);
    if (!reset) {
      res.status(400).send({ msg: req.t("errors.invalidOrExpiredLink") });
      return;
    }

    const user = await app.api.user.data(reset.user);
    if (!user) {
      res.status(400).send({ msg: req.t("errors.invalidOrExpiredLink") });
      return;
    }

    await app.api.user.updateSelf(user._id, { password });
    await app.api.passwordReset.consume(reset._id);

    // Whoever asked for the reset may be recovering a hijacked account, so
    // every existing session is dropped and a fresh one is issued.
    await app.api.auth.deleteAllTokensByUser(user._id);
    const session = await app.api.auth.registerToken(user._id);

    app.insertUserActionHistory(req, user, "reset_password", {
      category: "auth",
      local: { target_type: "users", target_id: user._id + "" },
      extra: { via: "link_email", sessions_revoked: true },
    });

    res.send({
      msg: req.t("ok.passwordChanged"),
      session: session,
      user: await app.api.user.withRole(await app.api.user.data(user._id)),
    });
  });

  // Password change for the signed-in user.
  app.put("/auth/password", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 6) {
      res.status(400).send({ msg: req.t("errors.newPasswordTooShort") });
      return;
    }

    const check = await app.api.user.authenticate(user.email, currentPassword);
    if (!check) {
      res.status(401).send({ msg: req.t("errors.wrongCurrentPassword") });
      return;
    }

    await app.api.user.updateSelf(user._id, { password: newPassword });

    // Changing the password drops the other sessions and re-issues this one —
    // otherwise a stolen token would keep working after the change.
    await app.api.auth.deleteAllTokensByUser(user._id);
    const token = await app.api.auth.registerToken(user._id);

    app.insertUserActionHistory(req, user, "change_password", {
      category: "auth",
      local: { target_type: "users", target_id: user._id + "" },
      extra: { sessions_revoked: true },
    });

    res.send({ msg: req.t("ok.passwordChanged"), session: token });
  });
};
