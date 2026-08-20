const userModel = require("../model/User_model.js");

module.exports = function (app) {
  // The signed-in user's own profile — works for both types. For a student it
  // also returns who their trainer is, which the screen shows.
  app.get("/me", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const payload = { ...user };

    // ── VOCABULÁRIO e IDIOMA vêm da CONTA, e entram no payload como se fossem
    //    do usuário ────────────────────────────────────────────────────────
    //
    // Isto é de propósito, e é o que evita mexer em quarenta telas.
    //
    // O vocabulário morava em `user.peopleSingular`, e toda a interface lê dali
    // (`peopleWords(user)` no menuConfig). Ao mudar a fonte para a conta, a opção
    // barata seria trocar o leitor em cada tela; a certa é trocar a FONTE e manter
    // a forma. Quem lê continua lendo `user.peopleSingular` e passa a receber a
    // palavra da conta sem saber que ela mudou de lugar.
    //
    // O idioma é diferente do vocabulário: a conta define o PADRÃO e cada pessoa
    // pode ter o dela. Então aqui o pessoal GANHA do padrão, e o padrão só aparece
    // para quem nunca escolheu — a pessoa nova da equipe.
    try {
      const [palavras, idiomaDaConta] = await Promise.all([
        app.api.tenant.wordsOfInstance(),
        app.api.tenant.languageOfInstance(),
      ]);

      payload.peopleSingular = palavras.singular;
      payload.peoplePlural = palavras.plural;

      // O padrão da conta viaja separado para a tela de Preferências poder mostrar
      // "o padrão daqui é português" ao lado da escolha pessoal.
      payload.accountLanguage = idiomaDaConta || null;
      payload.lang = user.lang || idiomaDaConta || undefined;
    } catch (error) {
      // Falhar aqui não pode derrubar o `/me`: sem ele a pessoa não entra em nada.
      // Sem as palavras, a interface cai no padrão "pessoa/pessoas", que é feio e
      // funciona.
      console.error("[me] não consegui ler a configuração da conta:", error.message);
    }

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

    const { name, email, username, peopleSingular, peoplePlural, lang, bio } = req.body || {};

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
      // A apresentação que a página pública de agendamento mostra. É sobre a
      // pessoa, então quem a escreve é ela — não o admin por ela.
      bio,
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
