const domainLib = require("../lib/domain.js");
const themeLib = require("../lib/theme.js");
const cloudflare = require("../lib/cloudflare.js");
const dnscheck = require("../lib/dnscheck.js");

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

    // Um host, dois jeitos de ser de alguém: subdomínio nosso ou domínio dele.
    const tenant = await app.api.tenant.dataByHost(host);
    if (!tenant) return res.send({ ...padrao, custom: false });

    res.send({ ...app.api.tenant.publicTheme(tenant), custom: true });
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
      logoSizes: themeLib.LOGO_SIZES,
      speedRange: { min: themeLib.MIN_SPEED, max: themeLib.MAX_SPEED },
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
