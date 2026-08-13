const userModel = require("../model/User_model.js");

module.exports = function (app) {
  // The signed-in user's own profile — works for both types. For a student it
  // also returns who their trainer is, which the screen shows.
  app.get("/me", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const payload = { ...user };

    if (user.type === "student" && user.trainer) {
      const trainer = await app.api.user.data(user.trainer);
      if (trainer) {
        payload.trainerInfo = {
          _id: trainer._id,
          name: trainer.name,
          email: trainer.email,
        };
      }
    }

    res.send(payload);
  });

  // As preferências de tela, gravadas à parte do PUT /me de propósito.
  //
  // Elas mudam a cada clique num cabeçalho de coluna. Passar por lá arrastaria
  // junto a validação de nome, e-mail e nome de usuário, devolveria a conta
  // inteira a cada clique e encheria a auditoria de "usuário alterado" — para
  // registrar que alguém preferiu ver a lista por ordem de nome.
  app.put("/me/preferences", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const ok = await app.api.user.savePreferences(user._id, req.body || {});
    if (!ok) {
      res.status(400).send({ msg: req.t("errors.invalidPreferences") });
      return;
    }

    const atual = await app.api.user.data(user._id);
    res.send({ preferences: atual.preferences || {} });
  });

  app.put("/me", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { name, email, username, peopleSingular, peoplePlural, lang } = req.body || {};

    if (name !== undefined && String(name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireOwnName") });
      return;
    }

    // Free text, but bounded: this word lands in menus, titles and buttons, so
    // an empty one would leave blanks on screen and a long one would break the
    // layout everywhere at once.
    for (const [value, field] of [
      [peopleSingular, "singular"],
      [peoplePlural, "plural"],
    ]) {
      if (value === undefined) continue;
      const clean = String(value).trim();
      if (clean.length < 3 || clean.length > 20) {
        res.status(400).send({
          msg: req.t("errors.vocabularyLength", { field }),
        });
        return;
      }
    }

    if (email !== undefined) {
      if (!app.validator.isEmail(String(email).trim())) {
        res.status(400).send({ msg: req.t("errors.invalidEmail") });
        return;
      }
      const exists = await app.api.user.dataByEmail(email);
      if (exists && String(exists._id) !== String(user._id)) {
        res.status(409).send({ msg: req.t("errors.emailInUse") });
        return;
      }
    }

    // Nome de usuário: a outra forma de entrar.
    //
    // Validado ANTES de gravar para a mensagem dizer o motivo. O modelo recusa de
    // novo — ele é a garantia — mas de lá só volta um código, e a pessoa que
    // digitou "marlon@" merece ouvir que não pode ter arroba, não "inválido".
    if (username !== undefined) {
      const conferido = userModel.checkUsername(username);
      if (!conferido.ok) {
        res.status(400).send({
          msg: req.t("errors.username." + conferido.reason),
          code: "invalid_username",
        });
        return;
      }

      if (conferido.value) {
        const livre = await app.api.user.usernameAvailable(conferido.value, user._id);
        if (!livre) {
          res.status(409).send({ msg: req.t("errors.usernameInUse"), code: "username_in_use" });
          return;
        }
      }
    }

    // Name, e-mail and the vocabulary. The password has its own route
    // (/auth/password); `type`, `role`, `admin` and `active` are not something
    // you change on yourself — that would make every permission optional.
    const before = await app.api.user.data(user._id);
    await app.api.user.updateSelf(user._id, {
      name,
      email,
      username,
      peopleSingular,
      peoplePlural,
      lang,
    });

    const updated = await app.api.user.data(user._id);

    app.insertUserActionHistory(req, user, "update_profile", {
      category: "auth",
      local: { target_type: "users", target_id: user._id + "" },
      diff: app.api.actionHistory.diff(before, updated),
    });

    res.send(await app.api.user.withRole(updated));
  });
};
