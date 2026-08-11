require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");

const { fromAcceptLanguage, translator } = require("./lib/i18n");
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
    "session,Accept-Language,Origin,Accept,X-Requested-With,Content-Type,Access-Control-Request-Method,Access-Control-Request-Headers"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
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
// Connect to Mongo and ensure the collections/indexes BEFORE accepting any
// request: booting with the database down would only push the failure onto the
// first request.
(async () => {
  try {
    await app.mongodb.connectToServer();
    await ensureSchema(app);
  } catch (error) {
    console.error("[boot] could not prepare MongoDB:", error.message);
    process.exit(1);
  }

  app.listen(PORT, HOST, () => {
    console.log("GoFitNow API running on " + HOST + ":" + PORT);
  });
})();

process.on("uncaughtException", function (error) {
  console.error("uncaughtException:", error);
});
