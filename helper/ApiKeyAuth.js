const rateLimit = require("../lib/rateLimit.js");

// Autenticação por chave de API, alternativa ao cabeçalho `session`.
//
// A chave age COMO A PESSOA que a criou: mesmas permissões, nem mais nem menos.
// Sem isso seria preciso um segundo sistema de autorização em paralelo ao dos
// tipos de usuário, e dois lugares para conceder poder é onde o furo aparece.
//
// O contrato é o mesmo do AuthSession: devolve o usuário, ou false depois de já
// ter respondido. Assim o ReqProtected não precisa saber por qual porta a
// requisição entrou.
function ApiKeyAuth(app) {
  this.app = app;
}

// Aceita as duas formas comuns, para quem integra não ter de descobrir qual é:
//   Authorization: Bearer gfn_...
//   X-API-Key: gfn_...
ApiKeyAuth.prototype.readKey = function (req) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return null;
};

ApiKeyAuth.prototype.present = function (req) {
  return this.readKey(req) !== null;
};

ApiKeyAuth.prototype.protect = async function (req, res) {
  const key = this.readKey(req);
  if (!key) {
    res.status(401).send({ msg: req.t("errors.noApiKey"), code: "no_api_key" });
    return false;
  }

  const doc = await this.app.api.apiKey.verify(key);
  if (!doc) {
    // Registra a tentativa: chave errada ou revogada é exatamente o que o dono
    // precisa ver no log. Sem `user` porque não sabemos de quem é.
    this.app.api.apiCall.record({
      method: req.method,
      path: req.originalUrl || req.url,
      status: 401,
      ip: req.clientIp,
      userAgent: req.headers["user-agent"],
    });
    res.status(401).send({ msg: req.t("errors.invalidApiKey"), code: "invalid_api_key" });
    return false;
  }

  // O limite é POR CHAVE, não por conta: uma integração com defeito não pode
  // derrubar as outras chaves da mesma pessoa.
  // `checkShared` e não `check`: com o cluster ligado, quem tem o contador é o
  // primário. Um Map por worker faria o limite valer N vezes o prometido.
  const limite = await rateLimit.checkShared(String(doc._id));
  res.setHeader("X-RateLimit-Limit", limite.limit);
  res.setHeader("X-RateLimit-Remaining", limite.remaining);

  if (!limite.allowed) {
    res.setHeader("Retry-After", limite.retryAfter);
    this.app.api.apiCall.record({
      user: doc.user,
      apiKey: doc._id,
      prefix: doc.prefix,
      method: req.method,
      path: req.originalUrl || req.url,
      status: 429,
      ip: req.clientIp,
      userAgent: req.headers["user-agent"],
    });
    res.status(429).send({
      msg: req.t("errors.rateLimited", { limit: limite.limit, seconds: limite.retryAfter }),
      code: "rate_limited",
      retryAfter: limite.retryAfter,
    });
    return false;
  }

  const user = await this.app.api.user.data(doc.user);
  if (!user || user.active === 0) {
    res.status(401).send({ msg: req.t("errors.unavailableAccount") });
    return false;
  }

  // Pendurados no req para o log de saída saber o que registrar, e para as
  // rotas poderem distinguir a porta de entrada quando precisarem.
  req._apiKey = doc;
  req._viaApiKey = true;

  this.app.api.apiKey.touch(doc._id);

  return await this.app.api.user.withRole(user);
};

module.exports = ApiKeyAuth;
