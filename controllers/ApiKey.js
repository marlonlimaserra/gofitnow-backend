const ApiKeyModel = require("../model/ApiKey_model.js");
const apiDocs = require("../lib/apiDocs.js");
const rateLimit = require("../lib/rateLimit.js");

// As chaves de API da própria conta, o log de uso delas e a documentação.
//
// Tudo aqui é da PRÓPRIA pessoa: não há rota para um admin ver a chave de
// outro. A chave é uma credencial dela, e uma tela que lista credencial alheia
// é um alvo.
module.exports = function (app) {
  // ── As chaves ───────────────────────────────────────────────────────────

  app.get("/api-keys", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({
      rows: await app.api.apiKey.list(user._id),
      max: ApiKeyModel.MAXIMO_POR_CONTA,
      rateLimit: rateLimit.LIMITE_PADRAO,
    });
  });

  app.post("/api-keys", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // Criar chave com chave seria uma credencial se multiplicando sozinha: quem
    // vazasse uma poderia fabricar outras e sobreviver à revogação da primeira.
    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const name = String(req.body?.name || "").trim();
    if (name.length < 2) {
      res.status(400).send({ msg: req.t("errors.requireApiKeyName") });
      return;
    }

    if ((await app.api.apiKey.countActive(user._id)) >= ApiKeyModel.MAXIMO_POR_CONTA) {
      res.status(400).send({
        msg: req.t("errors.tooManyApiKeys", { max: ApiKeyModel.MAXIMO_POR_CONTA }),
        code: "too_many_api_keys",
      });
      return;
    }

    const { doc, key } = await app.api.apiKey.create(user._id, name);

    app.insertUserActionHistory(req, user, "create_api_key", {
      category: "admin",
      local: { target_type: "api_keys", target_id: String(doc._id) },
      extra: { name: doc.name, prefix: doc.prefix },
    });

    // `key` sai UMA vez. Depois daqui nem o dono recupera — só cria outra.
    res.send({ ...app.api.apiKey.filter(doc), key });
  });

  app.delete("/api-keys/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const doc = await app.api.apiKey.data(user._id, req.params.id);
    if (!doc) {
      res.status(404).send({ msg: req.t("errors.apiKeyNotFound") });
      return;
    }

    await app.api.apiKey.revoke(user._id, req.params.id);

    app.insertUserActionHistory(req, user, "revoke_api_key", {
      category: "admin",
      local: { target_type: "api_keys", target_id: String(doc._id) },
      extra: { name: doc.name, prefix: doc.prefix },
    });

    res.send({ msg: req.t("ok.apiKeyRevoked") });
  });

  // ── O log de uso ────────────────────────────────────────────────────────

  app.get("/api-keys/calls", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { rows, total } = await app.api.apiCall.list(user._id, req.query);
    res.send({ rows, total });
  });

  app.get("/api-keys/calls/summary", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send(await app.api.apiCall.summary(user._id));
  });

  // ── A documentação ──────────────────────────────────────────────────────

  app.get("/api-docs", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({
      baseUrl: process.env.PUBLIC_API_URL || "https://backend.gofitnow.fit",
      rateLimit: rateLimit.LIMITE_PADRAO,
      groups: apiDocs.localized(req.t),
      // O que a conta REALMENTE pode: a tela marca o que está fora do alcance
      // dela em vez de deixar a pessoa descobrir por 403.
      permissions: user.permissions || [],
    });
  });
};
