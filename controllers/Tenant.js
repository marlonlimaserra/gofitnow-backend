const domainLib = require("../lib/domain.js");
const themeLib = require("../lib/theme.js");
const cloudflare = require("../lib/cloudflare.js");
const dnscheck = require("../lib/dnscheck.js");
const instanceContext = require("../lib/instance.js");

// O domínio e a aparência do profissional.
//
// Uma das rotas é PÚBLICA por necessidade: a tela de login precisa do tema
// antes de existir sessão, e o host é a única coisa que diz de quem ela é.
module.exports = function (app) {
  // As duas integrações que saem da máquina ficam num ponto só, para o teste
  // poder trocá-las por dublês. Em produção são os módulos de verdade.
  const cf = app.cloudflare || cloudflare;
  const dns = app.dnscheck || dnscheck;

  // ── Público ─────────────────────────────────────────────────────────────

  // Devolve SÓ aparência. Sem dono, sem e-mail, sem id: um endereço aberto não
  // pode entregar de quem ele é, nem servir para descobrir quem existe.
  //
  // Host desconhecido não é 404: é o tema padrão. A tela de login tem de abrir
  // bonita em qualquer endereço, inclusive num digitado errado.
  app.get("/public/theme", async function (req, res) {
    const host = String(req.query.host || req.headers["x-forwarded-host"] || req.headers.host || "");

    const padrao = { theme: themeLib.defaults(), scale: themeLib.scale(themeLib.defaults().brand) };

    // Esta rota é aberta e chega SEM instância — é o caso que existe antes de
    // qualquer sessão. Então o host é resolvido no CENTRAL, que é a única coisa
    // que sabe de quem é cada endereço, e só depois se abre o banco daquele
    // cliente para ler o tema.
    const registro = await app.api.center.byHost(host);

    // `known` é o que a tela de login espera antes de se desenhar.
    //
    // Antes daqui a resposta era sempre 200 com o tema padrão, e a tela não tinha
    // como distinguir "cliente sem tema escolhido" de "endereço que não é de
    // ninguém" — então desenhava o formulário nos dois casos, e um subdomínio
    // qualquer apontado para nós virava uma porta de entrada com cara de oficial.
    //
    // `known` é um booleano de propósito, e o nome da instância NÃO vai na
    // resposta. Dizer "este endereço é de alguém" é o que a tela precisa; dizer
    // "é do cliente marlon" seria entregar, numa rota sem autenticação, o mapa de
    // qual domínio próprio pertence a qual cliente nosso. Quem precisa saber a
    // instância é o servidor, e ele descobre sozinho pelo endereço da tela
    // (cabeçalho X-Instance-Host, ver app.js).
    if (!registro || registro.active === false || registro.active === 0) {
      return res.send({ ...padrao, custom: false, known: false });
    }

    const conhecido = { known: true };

    // Um host, três jeitos de chegar à aparência, nesta ordem:
    //
    //   1. um profissional que reivindicou ESTE endereço (subdomínio ou domínio
    //      próprio) — é o caso de quem quer aparência só sua;
    //   2. a aparência da INSTÂNCIA, que é a do profissional mais antigo dela.
    //
    // O (2) existe porque o endereço pertence à instância, e não ao profissional:
    // quem registra `marlon.gofitnow.fit` é o painel. Sem ele, a pessoa salvava a
    // tela de entrada e continuava vendo a original, porque a busca por host não
    // achava nada e caía no padrão.
    const tenant = await instanceContext.run(registro.instance, async () => {
      return (await app.api.tenant.dataByHost(host)) || (await app.api.tenant.dataOfInstance());
    });
    // Registrado mas sem tema escolhido: o endereço é de alguém, o visual é o
    // padrão. São coisas diferentes e a resposta diz as duas.
    if (!tenant) return res.send({ ...padrao, custom: false, ...conhecido });

    res.send({ ...app.api.tenant.publicTheme(tenant), custom: true, ...conhecido });
  });

  // ── Do profissional ─────────────────────────────────────────────────────

  app.get("/me/tenant", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const tenant = await app.api.tenant.dataByUser(user._id);
    const tema = themeLib.sanitize(tenant?.theme);

    res.send({
      subdomain: tenant?.subdomain || "",
      host: tenant?.subdomain ? domainLib.hostOf(tenant.subdomain) : "",
      status: tenant?.status || "none",
      lastError: tenant?.lastError || null,
      // O domínio próprio é outro endereço, com outro estado: ele espera o DNS
      // do profissional, não a credencial nossa.
      customDomain: tenant?.customDomain || "",
      customStatus: tenant?.customStatus || "none",
      customError: tenant?.customError || null,
      cnameTarget: domainLib.CNAME_TARGET,
      theme: tema,
      scale: themeLib.scale(tema.brand),
      baseDomain: domainLib.BASE_DOMAIN,
      layouts: themeLib.LAYOUTS,
      backgrounds: themeLib.BACKGROUNDS,
      effects: themeLib.EFFECTS,
      motions: themeLib.MOTIONS,
      logoRange: { min: themeLib.MIN_LOGO, max: themeLib.MAX_LOGO },
      menuLogoRange: { min: themeLib.MIN_MENU_LOGO, max: themeLib.MAX_MENU_LOGO },
      speedRange: { min: themeLib.MIN_SPEED, max: themeLib.MAX_SPEED },
      motionSpeedRange: { min: themeLib.MIN_MOTION_SPEED, max: themeLib.MAX_MOTION_SPEED },
      overlayRange: { min: themeLib.MIN_OVERLAY, max: themeLib.MAX_OVERLAY },
      presets: themeLib.PRESETS,
      maxPhotos: themeLib.MAX_PHOTOS,
      // A tela precisa saber se dá para registrar antes de oferecer o botão.
      dnsReady: cf.isConfigured(),
      dnsMissing: cf.missingConfig(),
      pagesReady: cf.isPagesConfigured(),
    });
  });

  app.get("/me/tenant/available", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // Domínio próprio e subdomínio têm regras diferentes de validade; o que a
    // tela pergunta é que decide qual delas responde.
    if (req.query.domain !== undefined) {
      const host = domainLib.normalizeDomain(req.query.domain);
      if (!host) return res.send({ free: false, reason: "invalid" });
      if (domainLib.isOwnDomain(host)) return res.send({ free: false, reason: "ours" });

      const livre = await app.api.tenant.isDomainFree(host, user._id);
      return res.send({ free: livre, reason: livre ? null : "taken", host });
    }

    const nome = domainLib.normalize(req.query.subdomain);
    if (!nome) return res.send({ free: false, reason: "invalid" });
    if (!domainLib.isAvailableName(nome)) return res.send({ free: false, reason: "reserved" });

    const livre = await app.api.tenant.isFree(nome, user._id);
    res.send({ free: livre, reason: livre ? null : "taken", host: domainLib.hostOf(nome) });
  });

  app.post("/me/tenant/domain", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // Uma chave de API não escolhe domínio: é decisão de marca, e o dono está
    // na tela quando toma.
    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const nome = domainLib.normalize(req.body?.subdomain);
    if (!nome) return res.status(400).send({ msg: req.t("errors.invalidSubdomain") });
    if (!domainLib.isAvailableName(nome)) {
      return res.status(400).send({ msg: req.t("errors.reservedSubdomain") });
    }

    // Reserva PRIMEIRO, fala com a Cloudflare depois: o índice único do banco é
    // o que decide quem chegou antes quando dois pedem o mesmo nome junto.
    const reserva = await app.api.tenant.claim(user._id, nome);
    if (!reserva.ok) {
      const chave = reserva.erro === "taken" ? "errors.subdomainTaken" : "errors.invalidSubdomain";
      return res.status(409).send({ msg: req.t(chave), code: reserva.erro });
    }

    // O endereço entra no REGISTRO CENTRAL.
    //
    // Sem esta linha o subdomínio existiria só por dentro da instância, e o portão
    // (lib/instanceGate.js) o barraria: ele resolve host → instância consultando
    // `instances.hosts`, e um endereço que não está lá é "domínio não
    // identificado". A pessoa registraria o próprio endereço e o receberia
    // trancado.
    await app.api.center.addHost(instanceContext.required(), reserva.host);

    app.insertUserActionHistory(req, user, "claim_domain", {
      category: "admin",
      local: { target_type: "tenants", target_id: String(user._id) },
      extra: { host: reserva.host },
    });

    // Sem credencial de DNS o nome fica reservado assim mesmo: quem escolheu não
    // perde o nome porque a integração ainda não está ligada.
    if (!cf.isConfigured()) {
      await app.api.tenant.setStatus(user._id, "pending", "cloudflare_not_configured");
      return res.send({
        ...reserva,
        status: "pending",
        dnsReady: false,
        dnsMissing: cf.missingConfig(),
      });
    }

    const criado = await cf.createSubdomain(reserva.host);
    await app.api.tenant.setStatus(user._id, criado.ok ? "active" : "failed", criado.ok ? null : criado.erro);

    res.send({ ...reserva, status: criado.ok ? "active" : "failed", error: criado.erro || null });
  });

  // ── Domínio próprio ─────────────────────────────────────────────────────
  //
  // Aqui a gente NÃO cria registro de DNS: a zona é do profissional. O que
  // acontece do nosso lado é ligar o host ao projeto Pages — que é o que faz o
  // certificado sair. O resto é ele apontar o CNAME e a gente conferir.

  // Um endereço só está no ar quando as DUAS pontas fecham: o CNAME dele
  // apontando para cá e o host aceito pelo Pages. Conferir só uma diria "no ar"
  // para quem ainda vê erro de SSL.
  async function conferir(host) {
    const apontamento = await dns.pointsTo(host, domainLib.CNAME_TARGET);
    if (!apontamento.ok) {
      return { status: "pending", erro: apontamento.erro, apontado: apontamento.found || null };
    }

    const pages = await cf.domainStatus(host);
    if (!pages.ok) {
      return { status: "pending", erro: pages.erro, apontado: apontamento.found || null };
    }

    return {
      status: pages.status === "active" ? "active" : "pending",
      erro: pages.status === "active" ? null : "certificate_pending",
      apontado: apontamento.found || null,
    };
  }

  app.post("/me/tenant/custom-domain", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const host = domainLib.normalizeDomain(req.body?.domain);
    if (!host) return res.status(400).send({ msg: req.t("errors.invalidDomain") });
    if (domainLib.isOwnDomain(host)) {
      const msg = req.t("errors.ourDomain", { base: domainLib.BASE_DOMAIN });
      return res.status(400).send({ msg, code: "ours" });
    }

    const reserva = await app.api.tenant.claimCustomDomain(user._id, host);
    if (!reserva.ok) {
      const chave = reserva.erro === "taken" ? "errors.domainTaken" : "errors.invalidDomain";
      return res.status(409).send({ msg: req.t(chave), code: reserva.erro });
    }

    app.insertUserActionHistory(req, user, "claim_custom_domain", {
      category: "admin",
      local: { target_type: "tenants", target_id: String(user._id) },
      extra: { host },
    });

    // No registro central antes de qualquer conversa com a Cloudflare: o
    // endereço precisa resolver para esta instância mesmo enquanto o certificado
    // não sai, senão a tela abriria em "domínio não identificado" durante toda a
    // espera do DNS.
    await app.api.center.addHost(instanceContext.required(), host);

    if (!cf.isPagesConfigured()) {
      await app.api.tenant.setCustomStatus(user._id, "pending", "cloudflare_not_configured");
      return res.send({ customDomain: host, customStatus: "pending", customError: "cloudflare_not_configured" });
    }

    const ligado = await cf.addPagesDomain(host);
    if (!ligado.ok) {
      await app.api.tenant.setCustomStatus(user._id, "failed", ligado.erro);
      return res.send({ customDomain: host, customStatus: "failed", customError: ligado.erro });
    }

    // A conferência logo em seguida quase sempre dá "pending" — ninguém cria o
    // CNAME antes de a tela pedir. Ela vai junto assim mesmo porque quem já
    // tinha apontado (recadastro, troca de conta) vê "no ar" na hora.
    const estado = await conferir(host);
    await app.api.tenant.setCustomStatus(user._id, estado.status, estado.erro);

    res.send({
      customDomain: host,
      customStatus: estado.status,
      customError: estado.erro,
      pointedAt: estado.apontado,
      cnameTarget: domainLib.CNAME_TARGET,
    });
  });

  // Conferir de novo, a pedido. É a rota que a pessoa aperta depois de mexer no
  // DNS dela — esperar a próxima visita à tela seria pior.
  app.post("/me/tenant/custom-domain/verify", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const tenant = await app.api.tenant.dataByUser(user._id);
    if (!tenant?.customDomain) {
      return res.status(404).send({ msg: req.t("errors.noCustomDomain"), code: "no_domain" });
    }

    // Ligar de novo é de propósito: se o cadastro no Pages falhou lá atrás, a
    // pessoa apertando "verificar" tem de conseguir sair do buraco sozinha.
    if (cf.isPagesConfigured()) await cf.addPagesDomain(tenant.customDomain);

    const estado = await conferir(tenant.customDomain);
    await app.api.tenant.setCustomStatus(user._id, estado.status, estado.erro);

    res.send({
      customDomain: tenant.customDomain,
      customStatus: estado.status,
      customError: estado.erro,
      pointedAt: estado.apontado,
      cnameTarget: domainLib.CNAME_TARGET,
    });
  });

  app.delete("/me/tenant/custom-domain", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const tenant = await app.api.tenant.dataByUser(user._id);
    if (!tenant?.customDomain) return res.send({ customDomain: "", customStatus: "none" });

    // O banco primeiro: se a Cloudflare estiver fora do ar, o endereço tem de
    // sair do nome dele assim mesmo — senão fica preso a um domínio que ele já
    // não quer, e ninguém mais pode usar.
    await app.api.tenant.removeCustomDomain(user._id);

    // E sai do registro central junto. Deixá-lo lá manteria o endereço resolvendo
    // para esta instância depois de ela já não o querer — e, pior, impediria outro
    // cliente de registrar o mesmo domínio, porque o índice é único.
    await app.api.center.removeHost(instanceContext.required(), tenant.customDomain);
    if (cf.isPagesConfigured()) await cf.removePagesDomain(tenant.customDomain);

    app.insertUserActionHistory(req, user, "remove_custom_domain", {
      category: "admin",
      local: { target_type: "tenants", target_id: String(user._id) },
      extra: { host: tenant.customDomain },
    });

    res.send({ customDomain: "", customStatus: "none" });
  });

  app.put("/me/tenant/theme", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const salvo = await app.api.tenant.saveTheme(user._id, req.body);

    // O tema salvo é o dono da verdade sobre quais imagens ainda importam, e é
    // por isso que o lixo é recolhido AQUI e não num botão de "remover imagem":
    // trocar a logo, ou enviar uma e não usar, não pode deixar arquivo pendurado.
    //
    // Nunca derruba a rota: o tema já está gravado, e falhar a resposta por
    // causa da faxina faria a tela dizer que não salvou o que salvou.
    try {
      await app.api.brandImage.pruneUnused(user._id, [salvo.logo, salvo.photo, ...salvo.photos]);
    } catch (error) {
      // Fica para a próxima gravação.
    }

    app.insertUserActionHistory(req, user, "update_theme", {
      category: "admin",
      local: { target_type: "tenants", target_id: String(user._id) },
      extra: { brand: salvo.brand, layout: salvo.layout },
    });

    res.send({ theme: salvo, scale: themeLib.scale(salvo.brand) });
  });
};
