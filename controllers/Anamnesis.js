const instanceContext = require("../lib/instance.js");
const clientIp = require("../lib/clientIp.js");
const tempoReal = require("../lib/tempoReal.js");
const rateLimit = require("../lib/rateLimit.js");
const { anamnesisInvite } = require("../lib/emailTemplates.js");
const { BASE_DOMAIN } = require("../lib/domain.js");

module.exports = function (app) {
  // A anamnese de uma pessoa. Duas rotas, e não cinco: o documento é único por
  // pessoa, então não há lista para paginar nem id para apagar um entre vários.
  //
  //   GET  /people/:personId/anamnesis   → o documento (ou null) e as listas
  //   PUT  /people/:personId/anamnesis   → grava (cria ou atualiza)
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  app.get("/people/:personId/anamnesis", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "anamnesis.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const doc = await app.api.anamnesis.data(trainer._id, student._id);

    res.send({
      // `null` quando nunca foi preenchida: é o que faz a tela convidar a
      // preencher em vez de mostrar um formulário que parece já respondido.
      anamnesis: doc,
      // As listas fechadas vêm do servidor, como nas outras abas: opção nova
      // aparece em toda tela de uma vez, e a tela com cache não oferece o que o
      // servidor recusa.
      options: app.api.anamnesis.ENUMS,
    });
  });

  app.put("/people/:personId/anamnesis", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "anamnesis.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const antes = await app.api.anamnesis.data(trainer._id, student._id);

    const { criou } = await app.api.anamnesis.save(trainer._id, student._id, req.body || {});
    const depois = await app.api.anamnesis.data(trainer._id, student._id);

    // Criar e atualizar são ações DIFERENTES no histórico, e a diferença
    // importa: "preencheu a anamnese" é o primeiro atendimento, "alterou" é
    // acompanhamento. Quem lê o log procura uma coisa ou a outra.
    app.insertUserActionHistory(req, trainer, criou ? "create_anamnesis" : "update_anamnesis", {
      category: "anamnesis",
      local: { target_type: "anamnesis", target_id: String(student._id) },
      extra: { person: student.name, personId: String(student._id) },
      // Sem `diff` na criação: comparar contra nada devolveria o documento
      // inteiro como "mudança", e o log da primeira consulta viraria um muro.
      diff: criou ? undefined : app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  // ── O LINK PARA A PESSOA RESPONDER ────────────────────────────────────────
  //
  // Anamnese preenchida pelo profissional durante a consulta é o caso comum. Mas
  // metade dela — o que a pessoa toma, o que não come, como dorme — ela responde
  // melhor em casa, com a caixa de remédio na mão, do que de memória na frente
  // de alguém.
  //
  // Então existe um endereço público, com token, que abre um formulário para ela.
  // O que ele pode e o que não pode está em model/AnamnesisLink_model.js.
  //
  // O ENDEREÇO é montado aqui, no servidor, a partir do host registrado da
  // instância — e não recebido da tela. Um link que sai por e-mail com um domínio
  // que o cliente mandou é uma página de phishing assinada por nós.
  async function enderecoDoFormulario(token) {
    const instancia = instanceContext.required();
    const registro = await app.api.center.byInstance(instancia);
    const host = (registro?.hosts || [])[0] || `${instancia}.${BASE_DOMAIN}`;
    return `https://${host}/anamnese/${token}`;
  }

  function comEndereco(doc, url) {
    if (!doc) return null;
    return {
      token: doc.token,
      url,
      expiresAt: doc.expiresAt,
      submittedAt: doc.submittedAt || null,
      createdAt: doc.createdAt,
    };
  }

  // O link ATIVO, se existir. A tela abre com ele em vez de gerar outro: gerar
  // invalidaria o que a pessoa recebeu ontem só porque o profissional abriu o
  // dialog hoje.
  app.get("/people/:personId/anamnesis/link", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "anamnesis.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const doc = await app.api.anamnesisLink.doStudent(trainer._id, student._id);

    res.send({
      link: doc ? comEndereco(doc, await enderecoDoFormulario(doc.token)) : null,
      // O e-mail da pessoa decide se o botão de enviar existe. Vem daqui e não do
      // documento da pessoa que a tela já tem, porque a tela pode estar aberta há
      // uma hora — e um botão que promete enviar para um e-mail que não existe é
      // pior que um botão ausente.
      email: student.email || "",
      days: app.api.anamnesisLink.diasDeValidade,
    });
  });

  app.post("/people/:personId/anamnesis/link", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "anamnesis.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const { token } = await app.api.anamnesisLink.create(trainer._id, student._id);
    const doc = await app.api.anamnesisLink.doStudent(trainer._id, student._id);

    app.insertUserActionHistory(req, trainer, "create_anamnesis_link", {
      category: "anamnesis",
      local: { target_type: "anamnesis", target_id: String(student._id) },
      extra: { person: student.name, personId: String(student._id) },
    });

    res.status(201).send({
      link: comEndereco(doc, await enderecoDoFormulario(token)),
      email: student.email || "",
      days: app.api.anamnesisLink.diasDeValidade,
    });
  });

  // Manda o link por e-mail. O endereço vai montado do servidor; o corpo da
  // requisição não escolhe nada.
  app.post("/people/:personId/anamnesis/link/email", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "anamnesis.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    if (!student.email) {
      return res.status(400).send({ msg: req.t("errors.personWithoutEmail"), code: "no_email" });
    }

    let doc = await app.api.anamnesisLink.doStudent(trainer._id, student._id);
    // Sem link ativo, cria: quem clicou em "enviar por e-mail" quer que a pessoa
    // receba, não uma mensagem dizendo que falta um passo.
    if (!doc) {
      await app.api.anamnesisLink.create(trainer._id, student._id);
      doc = await app.api.anamnesisLink.doStudent(trainer._id, student._id);
    }

    const url = await enderecoDoFormulario(doc.token);

    const mail = anamnesisInvite({
      // O idioma é o de QUEM LÊ: a pessoa, não quem disparou. É a mesma regra dos
      // outros e-mails do sistema.
      lang: student.lang || req.lang,
      name: student.name,
      professional: trainer.name,
      url,
      days: app.api.anamnesisLink.diasDeValidade,
    });

    try {
      await app.helpers.mailer.send({ to: student.email, ...mail });
    } catch (error) {
      console.error("[anamnese] o e-mail do link não saiu:", error.message);
      return res.status(503).send({ msg: req.t("errors.mailFailed"), code: "mail_failed" });
    }

    app.insertUserActionHistory(req, trainer, "send_anamnesis_link", {
      category: "anamnesis",
      local: { target_type: "anamnesis", target_id: String(student._id) },
      extra: { person: student.name, email: student.email },
    });

    res.send({ ok: true, email: student.email });
  });

  // ── A TELA DA PESSOA ──────────────────────────────────────────────────────
  //
  // Pública, com token. Fora do portão de instância (`/public/`), então quem
  // resolve o cliente é o HOST — mesmo desenho da agenda pública.
  async function instanciaDoHost(req, res) {
    const host = String(
      req.headers["x-instance-host"] ||
        req.query.host ||
        req.headers["x-forwarded-host"] ||
        req.headers.host ||
        ""
    );

    const registro = await app.api.center.byHost(host);
    if (!registro || registro.active === false || registro.active === 0) {
      res.status(404).send({ code: "unknown_domain" });
      return false;
    }
    return registro.instance;
  }

  // O que a página mostra ANTES de a pessoa responder.
  //
  // Só o primeiro nome dela e o nome do espaço. Nada do que já foi respondido: se
  // o link cair num grupo de WhatsApp, ninguém lê a anamnese de ninguém.
  app.get("/public/anamnesis/:token", async function (req, res) {
    const limite = await rateLimit.checkShared("anamnesisForm:" + clientIp(req), 60);
    if (!limite.allowed) return res.status(429).send({ code: "too_many_requests" });

    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const dados = await instanceContext.run(instancia, async () => {
      const link = await app.api.anamnesisLink.byToken(req.params.token);
      if (!link) return null;

      const person = await app.api.user.data(link.student);
      const tenant = await app.api.tenant.dataOfInstance();

      return {
        // Primeiro nome só: o formulário abre com "Olá, Marlon" e não com o nome
        // completo de alguém numa página que qualquer um com o endereço abre.
        firstName: String(person?.name || "").split(" ")[0] || "",
        // O nome do ESPAÇO como ele aparece na tela de entrada: é o que diz à
        // pessoa que o formulário é da nutricionista dela, e não de um site
        // qualquer que chegou por link.
        space: tenant?.theme?.tabName || tenant?.theme?.metaSiteName || "",
        options: app.api.anamnesis.ENUMS,
        // "Você já respondeu em tal dia" — para quem clica no link duas vezes
        // saber que o primeiro envio chegou.
        submittedAt: link.submittedAt || null,
        expiresAt: link.expiresAt,
      };
    });

    if (!dados) return res.status(404).send({ code: "invalid_link" });
    res.send(dados);
  });

  app.put("/public/anamnesis/:token", async function (req, res) {
    const limite = await rateLimit.checkShared("anamnesisSend:" + clientIp(req), 20);
    if (!limite.allowed) return res.status(429).send({ code: "too_many_requests" });

    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const ok = await instanceContext.run(instancia, async () => {
      const link = await app.api.anamnesisLink.byToken(req.params.token);
      if (!link) return false;

      // A resposta da pessoa PREENCHE, não sobrescreve.
      //
      // O profissional pode ter escrito "hipertensão controlada, ver exame de
      // março" no campo de doenças. Se a pessoa manda esse campo vazio — porque
      // não soube responder —, apagar o que ele escreveu seria perder informação
      // clínica por causa de um campo em branco.
      //
      // Então só o que veio COM CONTEÚDO entra, e o resto fica como estava.
      const limpos = app.api.anamnesis.limpar(req.body || {});
      const comConteudo = {};
      for (const [campo, valor] of Object.entries(limpos)) {
        const vazio = valor === "" || valor === null || valor === undefined;
        if (!vazio) comConteudo[campo] = valor;
      }

      await app.api.anamnesis.save(link.trainer, link.student, {
        ...comConteudo,
        // A marca de que foi a PESSOA que respondeu, e quando. É o que a tela do
        // profissional usa para dizer "respondida pelo paciente em tal dia" — e o
        // que evita ele achar que a colega preencheu.
        answeredByPersonAt: new Date(),
      });
      await app.api.anamnesisLink.markSubmitted(link._id);

      // A tela do profissional que estava vendo a pessoa digitar precisa saber
      // que acabou: até aqui ela mostrava um ESPELHO (nada gravado), e agora o
      // documento existe. Sem este aviso, ela continuaria mostrando o espelho e
      // um F5 traria "outra" anamnese — a de verdade.
      tempoReal.avisar(instancia, String(link.trainer), "anamnese:enviada", {
        student: String(link.student),
      });

      return true;
    });

    if (!ok) return res.status(404).send({ code: "invalid_link" });
    res.send({ ok: true });
  });
};
