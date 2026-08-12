const { MongoClient } = require("mongodb");

const instanceContext = require("../lib/instance.js");

// A conexão do backend, agora com DOIS destinos.
//
// O .env carrega só MONGODB_URI, e o nome do banco vem da própria URI
// (mongodb://host:port/<db>). Esse nome é o do banco CENTRAL.
//
//   central                → `gofitnow`. Guarda a collection `center` (o
//                            registro das instâncias) e o catálogo de
//                            exercícios, que é igual para todo mundo.
//   por instância          → `gofitnow_marlon`, `gofitnow_outro`. Guarda tudo o
//                            que é de um cliente só: contas, treinos, vínculos.
//
// Um banco por cliente, e não um campo `instance` em cada documento, porque o
// isolamento passa a ser do banco e não da disciplina de quem escreve a
// consulta: uma query sem filtro não alcança dados alheios porque eles não
// estão ali. E dá para exportar ou apagar um cliente inteiro sozinho.
//
// Os dois saem do MESMO MongoClient: `client.db(nome)` não abre conexão nova,
// compartilha o pool.
const connectionString = process.env.MONGODB_URI;

if (!connectionString) {
  console.error("[mongo] MONGODB_URI is not set in .env");
  process.exit(1);
}

// Short serverSelectionTimeoutMS: with a local Mongo down, the 30s default
// would hang the boot for half a minute before stating the obvious.
const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 8000 });

// O nome do banco central sai da URI SEM conectar.
//
// Ele é lido antes de qualquer conexão de propósito: `dbNameFor()` é chamado
// pelo schema e pelos testes, e depender de "já conectou" criaria uma ordem
// implícita que quebra em silêncio quando alguém chama fora de hora.
function baseFromUri(uri) {
  // mongodb://host:27017/gofitnow?opts  →  gofitnow
  const semEsquema = String(uri).replace(/^mongodb(\+srv)?:\/\//, "");
  const caminho = semEsquema.split("/").slice(1).join("/");
  const nome = caminho.split("?")[0].trim();
  return nome || "gofitnow";
}

const baseName = baseFromUri(connectionString);

let central;
let connecting;

async function connect() {
  if (central) return central;

  if (!connecting) {
    connecting = client
      .connect()
      .then((c) => {
        // db() with no argument uses the database from the URI.
        central = c.db();
        console.log("[mongo] connected, central db is " + central.databaseName);
        return central;
      })
      .catch((err) => {
        connecting = undefined;
        console.error("[mongo] connection failed:", err.message);
        throw err;
      });
  }

  return connecting;
}

module.exports = {
  // O banco CENTRAL. Só quem é compartilhado entre clientes usa: `center` e o
  // catálogo de exercícios.
  centralDb: connect,

  // O banco da instância da requisição atual.
  //
  // Sem instância no contexto, ESTOURA — e é o ponto do desenho. Se caísse no
  // central, uma rota que esquecesse o middleware leria dados de alguém sem dar
  // sinal nenhum.
  instanceDb: async function (instance) {
    // A instância é resolvida ANTES de conectar, de propósito. Conectar
    // primeiro trocaria o erro: sem banco de pé, "faltou instância" sairia como
    // "não consegui conectar" — e é o oposto do que quem lê precisa saber.
    const nome = instance ? instanceContext.normalize(instance) : instanceContext.required();
    if (!nome) throw new Error("invalid_instance");

    await connect();
    return client.db(`${baseName}_${nome}`);
  },

  // O que os modelos chamam. Aponta para o banco da INSTÂNCIA — que é o caso da
  // esmagadora maioria deles. Quem é central chama `centralDb()` de propósito,
  // e essa diferença fica visível no modelo.
  connectToServer: function () {
    return module.exports.instanceDb();
  },

  // Nome do banco de uma instância, sem abrir nada. O schema usa para criar.
  dbNameFor: function (instance) {
    const nome = instanceContext.normalize(instance);
    return nome ? `${baseName}_${nome}` : null;
  },

  centralName: function () {
    return baseName;
  },

  client: function () {
    return client;
  },

  close: async function () {
    await client.close();
    central = undefined;
    connecting = undefined;
  },
};
