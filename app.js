require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");

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

// ── Middleware ───────────────────────────────────────────────────────────
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
  res.status(404).send({ msg: "Rota não encontrada." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Route error:", req && req.method, req && req.originalUrl, err);
  if (res.headersSent) return;

  const body = { msg: (err && err.message) || "Erro interno." };
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
