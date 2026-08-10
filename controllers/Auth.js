module.exports = function (app) {
  // Auto-cadastro — cria sempre um TRAINER comum. Student é criado pelo seu
  // trainer (/alunos) e trainer com admin é criado pelo admin (/clientes);
  // nenhum dos dois nasce por aqui.
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

    const existe = await app.api.user.dataByEmail(email);
    if (existe) {
      res.status(409).send({ msg: "Já existe uma conta com esse e-mail." });
      return;
    }

    const id = await app.api.user.insertTrainer({ name, email, password });
    const token = await app.api.auth.registerToken(id);
    const user = await app.api.user.data(id);

    res.status(201).send({ session: token, user: app.api.user.filter(user) });
  });

  // Login — trainer e student entram pela mesma porta; o front decide o que
  // mostrar pelo `type` e pelo `admin`.
  app.post("/auth", async function (req, res) {
    const { email, password } = req.body || {};

    if (!email || !password) {
      res.status(400).send({ msg: "Informe e-mail e senha." });
      return;
    }

    const user = await app.api.user.autenticar(email, password);

    // Mensagem genérica de propósito: dizer "e-mail não existe" entregaria
    // quais e-mails têm conta. Vale também pro student sem acesso liberado.
    if (!user) {
      res.status(401).send({ msg: "E-mail ou senha inválidos." });
      return;
    }

    const token = await app.api.auth.registerToken(user._id);

    res.send({ session: token, user: app.api.user.filter(user) });
  });

  // Revalida a sessão no boot do frontend.
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

  // Troca de senha do próprio usuário logado.
  app.put("/auth/senha", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 6) {
      res.status(400).send({ msg: "A nova senha precisa ter no mínimo 6 caracteres." });
      return;
    }

    const confere = await app.api.user.autenticar(user.email, currentPassword);
    if (!confere) {
      res.status(401).send({ msg: "Senha atual incorreta." });
      return;
    }

    await app.api.user.updateSelf(user._id, { password: newPassword });

    // Trocar a senha derruba as outras sessões e reemite a atual — senão um
    // token roubado continuaria valendo depois da troca.
    await app.api.auth.deleteAllTokensByUser(user._id);
    const token = await app.api.auth.registerToken(user._id);

    res.send({ msg: "Senha alterada.", session: token });
  });
};
