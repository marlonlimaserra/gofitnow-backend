require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");

const { fromAcceptLanguage, translator } = require("./lib/i18n");
const instanceContext = require("./lib/instance.js");
const clientIp = require("./lib/clientIp.js");
const clusterLib = require("./lib/cluster.js");
const instanceGate = require("./lib/instanceGate.js");
const rateLimit = require("./lib/rateLimit.js");
const appRoutes = require("./appRoutes.js");
const appModels = require("./appModels.js");
const appHelpers = require("./appHelpers.js");
const defaultModules = require("./defaultModules.js");
const ensureSchema = require("./database/schema.js");

// The .env carries ONLY MONGODB_URI. The port defaults in code so nothing else
// is needed in the environment.
const PORT = process.env.EXPRESS_PORT || 3030;

// In production nginx is what talks to the internet, so node listens on
// 127.0.0.1 only (HOST comes from systemd) and port 3030 is never exposed. In
// development the 0.0.0.0 default keeps it reachable from the local network.
const HOST = process.env.HOST || "0.0.0.0";

const app = express();

app.mongodb = require("./config/mongodb.js");

// ── Wiring ───────────────────────────────────────────────────────────────
// Default modules (moment, crypto, validator, uuidv4…) → app.*
for (const k in defaultModules) app[k] = defaultModules[k];

// Models → app.api.*
app.api = {};
for (const k in appModels) app.api[k] = new appModels[k](app);

// Helpers → app.helpers.*
app.helpers = {};
for (const k in appHelpers) app.helpers[k] = new appHelpers[k](app);

// Audit trail, on `app` directly so the call sites read the same as in
// sprinthub-backend:
//
//   app.insertUserActionHistory(req, user, "create_person", { local, extra })
//
// It never rejects — see ActionHistory_model — so callers do not have to await
// it or guard it. Left un-awaited on purpose: a log must not add a database
// round trip to the critical path of a write.
app.insertUserActionHistory = function (req, user, action, data) {
  return app.api.actionHistory.record(req, user, action, data);
};

// ── Middleware ───────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE, PATCH");
  res.setHeader(
    "Access-Control-Allow-Headers",
    // X-Instance e X-Instance-Host TÊM de estar aqui: sem eles o navegador barra a
    // requisição no preflight e a tela não fala com a API — o erro apareceria como
    // "falha de CORS", sem dizer qual cabeçalho faltou.
    "session,Authorization,X-API-Key,X-Instance,X-Instance-Host,Accept-Language,Origin,Accept,X-Requested-With,Content-Type,Access-Control-Request-Method,Access-Control-Request-Headers"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  // Sem isto o navegador recebe os cabeçalhos de limite mas não deixa o JS lê-los.
  res.setHeader("Access-Control-Expose-Headers", "X-RateLimit-Limit,X-RateLimit-Remaining,Retry-After");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).send("GET,POST,PUT,DELETE,PATCH");
  next();
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

// Idioma da resposta, resolvido do Accept-Language que o frontend manda a partir
// do idioma escolhido na tela.
//
// Vale para o que a PESSOA DA REQUISIÇÃO lê: mensagens de erro, confirmações e
// os catálogos que a tela renderiza. E-mail é outro caso — quem lê é o
// destinatário, então lá o tradutor é criado a partir do `lang` da conta dele.
app.use((req, res, next) => {
  req.lang = fromAcceptLanguage(req.headers["accept-language"]);
  req.t = translator(req.lang);
  next();
});

// De qual INSTÂNCIA é esta requisição — ver lib/instanceGate.js.
app.use(instanceGate(app));

// De onde a requisição veio de verdade. Resolvido uma vez por requisição
// porque o histórico e o log de chamadas por chave precisam do MESMO valor.
app.use((req, res, next) => {
  req.clientIp = clientIp(req);
  next();
});

// Registro de saída das chamadas feitas com CHAVE de API.
//
// No `finish` da resposta, e não dentro de cada rota: aqui o status final já é
// conhecido, e nenhuma rota precisa lembrar de registrar. Só grava quando a
// requisição foi mesmo autenticada por chave — o que entrou pelo app já tem o
// histórico de auditoria, e duplicar viraria ruído.
//
// As recusas (401 de chave inválida, 429 de limite) são gravadas no próprio
// ApiKeyAuth, porque ali ainda se sabe o motivo.
app.use((req, res, next) => {
  const inicio = Date.now();

  res.on("finish", () => {
    if (!req._apiKey) return;
    app.api.apiCall.record({
      user: req._apiKey.user,
      apiKey: req._apiKey._id,
      prefix: req._apiKey.prefix,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      ip: req.clientIp,
      userAgent: req.headers["user-agent"],
      ms: Date.now() - inicio,
    });
  });

  next();
});

// Wraps every handler so an async throw reaches the error handler — without
// this a rejection inside an async handler leaves the request hanging.
const asyncWrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

["get", "post", "put", "patch", "delete"].forEach((m) => {
  const original = app[m].bind(app);
  app[m] = (path, ...handlers) =>
    original(path, ...handlers.map((h) => (typeof h === "function" ? asyncWrap(h) : h)));
});

// ── Routes ───────────────────────────────────────────────────────────────
for (const k in appRoutes) appRoutes[k](app);

app.use((req, res) => {
  if (res.headersSent) return;
  res.status(404).send({ msg: (req.t || translator())("errors.routeNotFound") });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Route error:", req && req.method, req && req.originalUrl, err);
  if (res.headersSent) return;

  // A mensagem crua do erro só vai para o cliente com DEBUG_ERRORS; caso
  // contrário sai o texto traduzido, porque `err.message` é inglês de biblioteca
  // e às vezes vaza caminho de arquivo.
  const t = req.t || translator();
  const body = { msg: process.env.DEBUG_ERRORS == "1" && err?.message ? err.message : t("errors.internal") };
  if (process.env.DEBUG_ERRORS == "1" && err && err.stack) body.stack = err.stack;

  res.status(500).send(body);
});

// ── Boot ─────────────────────────────────────────────────────────────────
//
// Em dois passos, porque com o cluster eles rodam em processos diferentes.
//
// `preparar` roda UMA vez, em quem coordena: conecta e garante coleções e
// índices antes de existir worker. Subir com o banco fora do ar só empurraria a
// falha para a primeira requisição, e criar os mesmos índices de N processos ao
// mesmo tempo é o mesmo trabalho feito N vezes.
//
// `servir` roda em cada processo que atende. Ele também conecta — o custo é uma
// conexão que ele vai precisar de todo jeito, e é o que mantém a garantia de que
// nenhum processo começa a aceitar requisição com o banco inalcançável.
const preparar = async () => {
  try {
    await app.mongodb.centralDb();
    await ensureSchema(app);
  } catch (error) {
    console.error("[boot] could not prepare MongoDB:", error.message);
    process.exit(1);
  }
};

const servir = async () => {
  try {
    await app.mongodb.centralDb();
  } catch (error) {
    console.error("[boot] could not reach MongoDB:", error.message);
    process.exit(1);
  }

  return app.listen(PORT, HOST, () => {
    console.log(`GoFitNow API running on ${HOST}:${PORT} (pid ${process.pid})`);
  });
};

clusterLib.start({
  nome: "gofitnow",
  preparar,
  servir,
  // O primário é o dono do contador de limite de chamadas: um por worker faria o
  // limite valer N vezes o prometido.
  aoNascerWorker: (worker) => rateLimit.atenderWorker(worker),
});

process.on("uncaughtException", function (error) {
  console.error("uncaughtException:", error);
});
