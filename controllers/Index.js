// The version comes from package.json — single source of truth, not a
// constant somebody forgets to bump on release.
const { version } = require("../package.json");

module.exports = function (app) {
  app.get("/", async function (req, res) {
    res.send({ app: "GoFitNow API", version: version, status: "ok" });
  });

  // Health check: confirms the API answers AND that Mongo is up.
  app.get("/health", async function (req, res) {
    try {
      const db = await app.mongodb.connectToServer();
      await db.command({ ping: 1 });
      res.send({ status: "ok", version: version, mongodb: "ok", database: db.databaseName });
    } catch (error) {
      res.status(503).send({ status: "erro", version: version, mongodb: error.message });
    }
  });
};
