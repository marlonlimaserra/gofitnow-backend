const { MongoClient } = require("mongodb");

// Única fonte de conexão do backend. O .env carrega só a MONGODB_URI — o nome
// do banco sai da própria URI (mongodb://host:porta/<banco>), então trocar de
// banco é trocar a URI, sem mexer em código.
const connectionString = process.env.MONGODB_URI;

if (!connectionString) {
  console.error("[mongo] MONGODB_URI não definida no .env");
  process.exit(1);
}

// serverSelectionTimeoutMS curto: com o Mongo local fora do ar, o default de
// 30s deixaria o boot pendurado meio minuto antes de dizer o óbvio.
const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 8000 });

let dbConnection;
let connecting;

module.exports = {
  // Devolve sempre a MESMA instância de db. A primeira chamada abre a conexão;
  // as concorrentes esperam a mesma Promise (por isso o `connecting`), senão N
  // requisições simultâneas no boot abririam N conexões.
  connectToServer: async function () {
    if (dbConnection) return dbConnection;

    if (!connecting) {
      connecting = client
        .connect()
        .then((c) => {
          // db() sem argumento usa o banco que veio na URI.
          dbConnection = c.db();
          console.log("[mongo] conectado em " + dbConnection.databaseName);
          return dbConnection;
        })
        .catch((err) => {
          connecting = undefined;
          console.error("[mongo] falha ao conectar:", err.message);
          throw err;
        });
    }

    return connecting;
  },

  close: async function () {
    await client.close();
    dbConnection = undefined;
    connecting = undefined;
  },
};
