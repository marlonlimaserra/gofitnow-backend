const domainLib = require("../lib/domain.js");
const themeLib = require("../lib/theme.js");
const cloudflare = require("../lib/cloudflare.js");

// O domínio e a aparência do profissional.
//
// Uma das rotas é PÚBLICA por necessidade: a tela de login precisa do tema
// antes de existir sessão, e o host é a única coisa que diz de quem ela é.
module.exports = function (app) {
  // ── Público ─────────────────────────────────────────────────────────────

  // Devolve SÓ aparência. Sem dono, sem e-mail, sem id: um endereço aberto não
  // pode entregar de quem ele é, nem servir para descobrir quem existe.
  //
  // Host desconhecido não é 404: é o tema padrão. A tela de login tem de abrir
  // bonita em qualquer endereço, inclusive num digitado errado.
  app.get("/public/theme", async function (req, res) {
    const host = String(req.query.host || req.headers["x-forwarded-host"] || req.headers.host || "");
    const sub = domainLib.subdomainOf(host);

    const padrao = { theme: themeLib.defaults(), scale: themeLib.scale(themeLib.defaults().brand) };
    if (!sub) return res.send({ ...padrao, custom: false });

    const tenant = await app.api.tenant.dataBySubdomain(sub);
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
      theme: tema,
      scale: themeLib.scale(tema.brand),
      baseDomain: domainLib.BASE_DOMAIN,
      layouts: themeLib.LAYOUTS,
      presets: themeLib.PRESETS,
      maxPhotos: themeLib.MAX_PHOTOS,
      // A tela precisa saber se dá para registrar antes de oferecer o botão.
      dnsReady: cloudflare.isConfigured(),
      dnsMissing: cloudflare.missingConfig(),
    });
  });

  app.get("/me/tenant/available", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

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
    if (!cloudflare.isConfigured()) {
      await app.api.tenant.setStatus(user._id, "pending", "cloudflare_not_configured");
      return res.send({
        ...reserva,
        status: "pending",
        dnsReady: false,
        dnsMissing: cloudflare.missingConfig(),
      });
    }

    const criado = await cloudflare.createSubdomain(reserva.host);
    await app.api.tenant.setStatus(user._id, criado.ok ? "active" : "failed", criado.ok ? null : criado.erro);

    res.send({ ...reserva, status: criado.ok ? "active" : "failed", error: criado.erro || null });
  });

  app.put("/me/tenant/theme", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const salvo = await app.api.tenant.saveTheme(user._id, req.body);

    app.insertUserActionHistory(req, user, "update_theme", {
      category: "admin",
      local: { target_type: "tenants", target_id: String(user._id) },
      extra: { brand: salvo.brand, layout: salvo.layout },
    });

    res.send({ theme: salvo, scale: themeLib.scale(salvo.brand) });
  });
};
