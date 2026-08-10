module.exports = function (app) {
  // Self-signup — always creates a plain TRAINER. A student is created by
  // their trainer (/students) and an admin trainer by an admin (/clients);
  // neither is born here.
  app.post("/auth/register", async function (req, res) {
    const { name, email, password } = req.body || {};

    if (!name || String(name).trim().length < 2) {
      res.status(400).send({ msg: "Informe seu nome." });
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
      res.status(409).send({ msg: "Já existe uma conta com esse e-mail." });
      return;
    }

    const id = await app.api.user.insertTrainer({ name, email, password });
    const token = await app.api.auth.registerToken(id);
    const user = await app.api.user.data(id);

    res.status(201).send({ session: token, user: app.api.user.filter(user) });
  });

  // Login — trainer and student come through the same door; the frontend
  // decides what to show from `type` and `admin`.
  app.post("/auth", async function (req, res) {
    const { email, password } = req.body || {};

    if (!email || !password) {
      res.status(400).send({ msg: "Informe e-mail e senha." });
      return;
    }

    const user = await app.api.user.authenticate(email, password);

    // Deliberately generic message: saying "this e-mail does not exist" would
    // reveal which addresses have an account. Same for a student whose access
    // has not been granted yet.
    if (!user) {
      res.status(401).send({ msg: "E-mail ou senha inválidos." });
      return;
    }

    const token = await app.api.auth.registerToken(user._id);

    res.send({ session: token, user: app.api.user.filter(user) });
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
    res.send({ msg: "Sessão encerrada." });
  });

  // Password change for the signed-in user.
  app.put("/auth/password", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 6) {
      res.status(400).send({ msg: "A nova senha precisa ter no mínimo 6 caracteres." });
      return;
    }

    const check = await app.api.user.authenticate(user.email, currentPassword);
    if (!check) {
      res.status(401).send({ msg: "Senha atual incorreta." });
      return;
    }

    await app.api.user.updateSelf(user._id, { password: newPassword });

    // Changing the password drops the other sessions and re-issues this one —
    // otherwise a stolen token would keep working after the change.
    await app.api.auth.deleteAllTokensByUser(user._id);
    const token = await app.api.auth.registerToken(user._id);

    res.send({ msg: "Senha alterada.", session: token });
  });
};
