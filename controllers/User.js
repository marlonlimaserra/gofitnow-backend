module.exports = function (app) {
  // Perfil do próprio usuário — vale pros dois types. No student, devolve
  // junto quem é o trainer dele (a tela mostra isso).
  app.get("/me", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const resposta = { ...user };

    if (user.type === "student" && user.trainer) {
      const trainer = await app.api.user.data(user.trainer);
      if (trainer) {
        resposta.trainerInfo = {
          _id: trainer._id,
          name: trainer.name,
          email: trainer.email,
        };
      }
    }

    res.send(resposta);
  });

  app.put("/me", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { name, email } = req.body || {};

    if (name !== undefined && String(name).trim().length < 2) {
      res.status(400).send({ msg: "Informe seu nome." });
      return;
    }

    if (email !== undefined) {
      if (!app.validator.isEmail(String(email).trim())) {
        res.status(400).send({ msg: "E-mail inválido." });
        return;
      }
      const existe = await app.api.user.dataByEmail(email);
      if (existe && String(existe._id) !== String(user._id)) {
        res.status(409).send({ msg: "Esse e-mail já está em uso." });
        return;
      }
    }

    // Só name e email. Senha tem rota própria (/auth/senha); `type`, `admin`
    // e `active` ninguém muda em si mesmo por aqui.
    await app.api.user.updateSelf(user._id, { name, email });

    const atualizado = await app.api.user.data(user._id);
    res.send(app.api.user.filter(atualizado));
  });
};
