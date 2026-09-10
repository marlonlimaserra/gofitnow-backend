// The version comes from package.json — single source of truth, not a
// constant somebody forgets to bump on release.
const { version } = require("../package.json");

module.exports = function (app) {
  app.get("/", async function (req, res) {
    res.send({ app: "GoFitNow API", version: version, status: "ok" });
  });

  // Health check: confirma que a API responde E que o Mongo está de pé.
  //
  // ── ELE PINGA O BANCO CENTRAL, E NÃO O DO CLIENTE (07/09/2026) ───────────
  //
  // Era `connectToServer()`, que é o banco DO CLIENTE — e ele exige a instância
  // no contexto assíncrono. Funcionava enquanto a rota só era chamada com o
  // cabeçalho de host de um cliente.
  //
  // No dia em que `/health` entrou na lista de rotas sem instância (para uma
  // sonda conseguir chamá-lo de fora), ele passou a responder **503
  // `no_instance_in_context`** — alcançável e quebrado, que para uma sonda é
  // pior que o 400 de antes: um monitor leria "fora do ar" para sempre.
  //
  // O central não precisa de instância e prova a mesma coisa: se o Mongo
  // responde, ele responde. "Qual banco de cliente" é pergunta de requisição,
  // não de saúde.
  app.get("/health", async function (req, res) {
    try {
      const db = await app.mongodb.centralDb();
      await db.command({ ping: 1 });
      res.send({ status: "ok", version: version, mongodb: "ok", database: db.databaseName });
    } catch (error) {
      res.status(503).send({ status: "erro", version: version, mongodb: error.message });
    }
  });
};
