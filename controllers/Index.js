// A versão sai do package.json — fonte única, não uma constante que alguém
// esquece de subir junto com o release.
const { version } = require("../package.json");

module.exports = function (app) {
  app.get("/", async function (req, res) {
    res.send({ app: "GoFitNow API", version: version, status: "ok" });
  });

  // Health check: confirma que a API responde E que o Mongo está de pé.
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
