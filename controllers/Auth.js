const { passwordReset } = require("../lib/emailTemplates.js");
const { enderecoDaInstancia } = require("../lib/enderecoDaInstancia.js");
const travaDeEnvio = require("../lib/travaDeEnvio.js");
const clientIp = require("../lib/clientIp.js");
const desafio = require("../lib/desafio.js");
const avisar = require("../lib/avisar.js");
const tentativas = require("../lib/tentativasDeLogin.js");

// ── O APP ID DO ONESIGNAL VAI JUNTO COM O LOGIN ──────────────────────────
//
// O app é um binário só para todos os clientes, e o App ID mora na central — ele
// não pode estar embutido no pacote. A alternativa seria uma rota só para
// buscá-lo, e uma viagem de rede a mais em toda abertura do app para um dado que
// nunca muda entre uma abertura e a outra.
//
// Não é segredo: ele viaja dentro de todo aplicativo publicado, à vista de quem
// abrir o pacote. O que autoriza DISPARAR é a REST API Key, e ela nunca sai do
// servidor.
//
// Devolve `null` quando o push está desligado — e é assim que o app sabe que não
// deve nem pedir a permissão de notificação. Pedir e não usar é gastar o único
// "sim" que a pessoa dá.
async function appIdDoPush(app) {
  const config = await avisar.configuracao(app);
  return config.ligado ? config.appId : null;
}

module.exports = function (app) {
  // Self-signup — always creates a plain PROFISSIONAL. The role is looked up
  // here and never read from the body: otherwise anyone could sign up asking
  // to be an Administrador.
  app.post("/auth/register", async function (req, res) {
    const { name, email, password, captchaToken } = req.body || {};

    // No cadastro o desafio é liga-desliga: não há "errar N vezes" que faça
    // sentido — um robô que cria contas acerta de primeira.
    const configCadastro = await desafio.configuracao(app);
    if (configCadastro.ligado && configCadastro.noCadastro) {
      const recusa = await desafio.conferir(app, {
        config: configCadastro,
        token: captchaToken,
        ip: clientIp(req),
      });
      if (recusa) {
        res.status(recusa.status).send({
          msg: req.t("errors." + recusa.code),
          code: recusa.code,
          siteKey: configCadastro.siteKey,
        });
        return;
      }
    }

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

    const role = await app.api.role.dataByName(app.api.role.defaultName);

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

    res.status(201).send({
      session: token,
      // Vestido com a conta (vocabulário, idioma padrão): esta resposta vira o
      // `user` do app inteiro até o próximo boot — ver Tenant_model.
      user: await app.api.tenant.vestirComAConta(await app.api.user.withRole(user)),
    });
  });

  // Login — professional and person come through the same door; the frontend
  // decides what to show from `type` and the permission list.
  app.post("/auth", async function (req, res) {
    const { email, password, captchaToken } = req.body || {};

    if (!email || !password) {
      res.status(400).send({ msg: req.t("errors.requireEmailAndPassword") });
      return;
    }

    const ip = clientIp(req);
    const chaves = tentativas.chavesDe(email, ip);

    // ── O DESAFIO, quando as falhas passam do limiar ────────────────────
    //
    // Ele vem ANTES de conferir a senha, e isso é o ponto: depois de N erros, a
    // senha só é testada de novo por quem provou não ser um robô. Conferir
    // primeiro e desafiar depois deixaria a força bruta seguir funcionando — o
    // atacante saberia que acertou pela resposta, e o desafio só atrasaria a
    // comemoração.
    const { exigido, config } = await desafio.exigidoNoLogin(app, { email, ip });

    if (exigido) {
      const recusa = await desafio.conferir(app, { config, token: captchaToken, ip });
      if (recusa) {
        res.status(recusa.status).send({
          msg: req.t("errors." + recusa.code),
          code: recusa.code,
          // A tela precisa da chave para desenhar o widget. Ela é pública por
          // natureza — vai no HTML de qualquer página que use Turnstile.
          siteKey: config.siteKey,
        });
        return;
      }
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

      // Conta a falha — é ela que faz o desafio aparecer na próxima.
      tentativas.registrarFalha(chaves);

      // `captchaNext` diz à tela se o PRÓXIMO envio vai precisar do widget, para
      // ele já aparecer junto com a mensagem de senha errada. Sem isto, a pessoa
      // erraria de novo só para descobrir que agora tem um desafio.
      const proxima = await desafio.exigidoNoLogin(app, { email, ip });

      res.status(401).send({
        msg: req.t("errors.badCredentials"),
        captchaNext: proxima.exigido,
        siteKey: proxima.exigido ? proxima.config.siteKey : undefined,
      });
      return;
    }

    const token = await app.api.auth.registerToken(user._id);

    // Entrou: zera a contagem. Sem isto, quem errou duas vezes, acertou, e
    // voltou dez minutos depois pegaria o desafio sem ter errado nada.
    tentativas.limparFalhas(chaves);

    app.insertUserActionHistory(req, user, "login", { category: "auth" });

    res.send({
      session: token,
      user: await app.api.tenant.vestirComAConta(await app.api.user.withRole(user)),
      pushAppId: await appIdDoPush(app),
    });
  });

  // ── O QUE A TELA DE ENTRADA PRECISA SABER ANTES DE DESENHAR ───────────
  //
  // Pública, e tem de ser: acontece antes de existir sessão. Não vaza nada — a
  // `siteKey` é feita para ficar no HTML, e a `secretKey` nunca sai daqui.
  //
  // `email` é opcional: com ele a resposta diz se AQUELA conta já passou do
  // limiar, e a tela desenha o widget de saída. Sem ele, responde só a
  // configuração geral.
  app.get("/auth/challenge", async function (req, res) {
    const ip = clientIp(req);
    const email = req.query?.email;

    const { exigido, config } = await desafio.exigidoNoLogin(app, { email, ip });

    // Sem cache: a resposta depende de quantas vezes ESTE ip errou agora há
    // pouco. Guardada num proxy, ela mentiria para a próxima pessoa.
    res.setHeader("Cache-Control", "no-store");
    res.send({
      ligado: Boolean(config.ligado),
      siteKey: config.ligado ? config.siteKey : "",
      exigidoAgora: exigido,
      noCadastro: Boolean(config.ligado && config.noCadastro),
      noEsqueci: Boolean(config.ligado && config.noEsqueci),
    });
  });

  // Revalidates the session when the frontend boots.
  app.get("/auth/verify", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // Vestido com a conta, como o login e o /me. É ESTA rota que o app usa para
    // botar — era aqui que o F5 ressuscitava o vocabulário fóssil do documento.
    res.send({
      user: await app.api.tenant.vestirComAConta(user),
      pushAppId: await appIdDoPush(app),
    });
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
    const { email, captchaToken } = req.body || {};

    const generic = {
      msg: req.t("ok.resetLinkSent"),
    };

    // Aqui o desafio protege uma coisa específica: esta rota MANDA E-MAIL, e sem
    // freio ela vira uma máquina de encher a caixa de alguém — ou de queimar a
    // cota da Resend. Também é liga-desliga: a resposta é genérica de propósito,
    // então não há "falha" para contar.
    const configEsqueci = await desafio.configuracao(app);
    if (configEsqueci.ligado && configEsqueci.noEsqueci) {
      const recusa = await desafio.conferir(app, {
        config: configEsqueci,
        token: captchaToken,
        ip: clientIp(req),
      });
      if (recusa) {
        res.status(recusa.status).send({
          msg: req.t("errors." + recusa.code),
          code: recusa.code,
          siteKey: configEsqueci.siteKey,
        });
        return;
      }
    }

    if (!email || !app.validator.isEmail(String(email).trim())) {
      res.send(generic);
      return;
    }

    // ── A TRAVA, e por que ela é MARCADA ANTES DE SABER SE A CONTA EXISTE ──
    //
    // Esta rota manda e-mail, e sem freio ela é uma máquina de encher a caixa de
    // alguém — basta saber o endereço da pessoa.
    //
    // O detalhe que importa: a resposta desta rota é genérica DE PROPÓSITO, para
    // não dizer quais e-mails têm conta aqui. Se a trava só fosse marcada quando
    // o envio acontece, um 429 passaria a significar "esta conta existe" — e a
    // trava, criada para conter abuso, viraria o oráculo que a resposta genérica
    // existe para negar.
    //
    // Por isso ela é marcada para QUALQUER endereço bem formado, exista conta ou
    // não. E a recusa também responde `generic`: nem o código de status muda.
    const alvo = `senha:${String(email).trim().toLowerCase()}`;
    const configDaTrava = await travaDeEnvio.configuracao(app);

    if (configDaTrava.ligada) {
      if ((await travaDeEnvio.faltamSegundos(alvo, configDaTrava.janela)) > 0) {
        res.send(generic);
        return;
      }
      travaDeEnvio.marcarEnvio(alvo);
    }

    const user = await app.api.user.dataByEmail(email);

    // A student registered as a profile only (no password yet) has nothing to
    // reset — their trainer grants access first.
    if (!user || user.active === 0 || !user.password) {
      res.send(generic);
      return;
    }

    const token = await app.api.passwordReset.create(user._id);
    // O endereço da CASA que pediu, e não o portal. Quem pede a senha em
    // `marlon.gofitnow.fit` tem de voltar para lá — `app.gofitnow.fit` é o
    // portal, que não é a casa de ninguém.
    const url = `${await enderecoDaInstancia(app)}/reset-password?token=${token}`;

    app.insertUserActionHistory(req, user, "forgot_password", {
      category: "auth",
      local: { target_type: "users", target_id: user._id + "" },
    });

    // A MARCA DA CASA vai no e-mail. Sem ela a mensagem chega com a cor de
    // fábrica, e um e-mail com a cor de outra pessoa denuncia que o sistema é
    // alugado — que é justamente o que o produto vende ao contrário.
    const casa = await app.api.tenant.dataOfInstance();

    const mail = passwordReset({
      // Idioma de QUEM RECEBE: quem lê o e-mail é o dono da conta, não quem
      // disparou o pedido — que, aqui, é a mesma pessoa, mas nos outros dois
      // e-mails não é.
      lang: user.lang,
      name: user.name,
      url: url,
      minutes: app.api.passwordReset.validityMinutes,
      tema: casa?.theme,
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
