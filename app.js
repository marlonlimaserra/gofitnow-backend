require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");

const appRoutes = require("./appRoutes.js");
const appModels = require("./appModels.js");
const appHelpers = require("./appHelpers.js");
const defaultModules = require("./defaultModules.js");
const ensureSchema = require("./database/schema.js");

// O .env carrega SÓ a MONGODB_URI. A porta fica com default no código pra não
// precisar de mais nada no ambiente.
const PORT = process.env.EXPRESS_PORT || 3030;

// Em produção o nginx é quem fala com a internet, então o node escuta só em
// 127.0.0.1 (HOST vem do systemd) e a porta 3030 não fica exposta. Em
// desenvolvimento o default 0.0.0.0 mantém o acesso pela rede local.
const HOST = process.env.HOST || "0.0.0.0";

const app = express();

app.mongodb = require("./config/mongodb.js");

// ── Wiring do app ────────────────────────────────────────────────────────
// Módulos padrão (moment, crypto, validator, uuidv4…) → app.*
for (const k in defaultModules) app[k] = defaultModules[k];

// Models → app.api.*
app.api = {};
for (const k in appModels) app.api[k] = new appModels[k](app);

// Helpers → app.helpers.*
app.helpers = {};
for (const k in appHelpers) app.helpers[k] = new appHelpers[k](app);

// ── Middlewares ──────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE, PATCH");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "session,Origin,Accept,X-Requested-With,Content-Type,Access-Control-Request-Method,Access-Control-Request-Headers"
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

// Envolve cada handler pra capturar throw async e mandar pro error handler —
// sem isso uma rejeição dentro de um handler async vira request pendurada.
const asyncWrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

["get", "post", "put", "patch", "delete"].forEach((m) => {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) =>
    orig(path, ...handlers.map((h) => (typeof h === "function" ? asyncWrap(h) : h)));
});

// ── Rotas ────────────────────────────────────────────────────────────────
for (const k in appRoutes) appRoutes[k](app);

app.use((req, res) => {
  if (res.headersSent) return;
  res.status(404).send({ msg: "Rota não encontrada." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Erro ao processar rota:", req && req.method, req && req.originalUrl, err);
  if (res.headersSent) return;

  const body = { msg: (err && err.message) || "Erro interno." };
  if (process.env.DEBUG_ERRORS == "1" && err && err.stack) body.stack = err.stack;

  res.status(500).send(body);
});

// ── Boot ─────────────────────────────────────────────────────────────────
// Conecta no Mongo e garante as coleções/índices ANTES de aceitar requisição:
// subir com o banco fora do ar só empurraria a falha pro primeiro request.
(async () => {
  try {
    await app.mongodb.connectToServer();
    await ensureSchema(app);
  } catch (error) {
    console.error("[boot] não foi possível preparar o MongoDB:", error.message);
    process.exit(1);
  }

  app.listen(PORT, HOST, () => {
    console.log("GoFitNow API rodando em " + HOST + ":" + PORT);
  });
})();

process.on("uncaughtException", function (error) {
  console.error("uncaughtException:", error);
});
