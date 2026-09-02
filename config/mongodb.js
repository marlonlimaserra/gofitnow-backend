const { MongoClient } = require("mongodb");

const instanceContext = require("../lib/instance.js");
const escopo = require("../lib/escopo.js");
const destinos = require("../lib/destinos.js");

// A conexão do backend, com DOIS destinos.
//
// O .env carrega só MONGODB_URI, e o nome do banco vem da própria URI
// (mongodb://host:port/<db>).
//
//   dados     → `gofitnow`. TUDO o que é de cliente, de todos os clientes, com o
//               campo `instance` em cada documento.
//   central   → `gofitnow_center`. O que é IGUAL PARA TODO MUNDO: o registro dos
//               clientes (`instances`) e o catálogo de exercícios e alimentos. É o
//               mesmo banco do painel — ele controla justamente as coisas
//               compartilhadas, e separar "compartilhado do app" de
//               "compartilhado do painel" seria uma fronteira sem dono.
//
// ── ERA UM BANCO POR CLIENTE ─────────────────────────────────────────────────
//
// Até 24/08/2026 cada cliente tinha o próprio banco (`gofitnow_marlon`,
// `gofitnow_bruna`). Aquilo comprava uma garantia real: uma query sem filtro não
// alcançava dado alheio porque ele não estava ali.
//
// E não escalava. São 35 collections e ~99 índices por cliente, e o WiredTiger
// cria um arquivo para cada um — ~134 arquivos por cliente. Com mil clientes são
// 35 mil collections e ~134 mil arquivos; com cem mil, milhões. O catálogo do
// Mongo mora em RAM e cada collection custa um descritor: o servidor deixa de
// subir muito antes da meta de cem mil. O teto prático aparece por volta de mil.
//
// Trocamos com 5 clientes e 3.359 documentos no total, que é a hora barata.
//
// A garantia perdida foi RECONSTRUÍDA em `lib/escopo.js`: `connectToServer()`
// devolve um banco escopado, cujo `.collection()` injeta o cliente em todo filtro,
// documento e agregação. Os 45 modelos não mudaram de linha, e um método que o
// escopo não conheça estoura em vez de rodar sem cliente.
//
// Os dois bancos saem do MESMO MongoClient: `client.db(nome)` não abre conexão
// nova, compartilha o pool.
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
// Ele é lido antes de qualquer conexão de propósito: `nomeDoBanco()` é chamado
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

// O banco CENTRAL — o do compartilhado, que é também o do painel.
//
// A divisão de DONO do schema continua clara, e é por collection: o painel cria e
// indexa `instances`, `admins`, `sessions`, `plans` e `groups`; este backend cria
// e indexa `exercises`. Duas fontes criando o mesmo índice daria dois lugares
// para manter, um sempre atrasado.
const centerName = `${baseName}_center`;

let conectado;
let connecting;

async function connect() {
  if (conectado) return conectado;

  if (!connecting) {
    connecting = client
      .connect()
      .then((c) => {
        conectado = c;
        console.log(`[mongo] conectado — central em ${centerName}`);
        return c;
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
  // O banco CENTRAL: o que é igual para todo mundo. Um só, e é o mesmo do painel.
  //
  // NÃO é escopado, de propósito: aqui nada pertence a um cliente. Quem chama
  // este método está dizendo, em voz alta, que a leitura é compartilhada.
  centralDb: async function () {
    const c = await connect();
    return c.db(centerName);
  },

  // ── O QUE OS MODELOS CHAMAM ────────────────────────────────────────────────
  //
  // O banco de dados do cliente da requisição atual, ESCOPADO nele. É o caminho
  // de 45 modelos e ~399 pontos que pegam collection, e nenhum deles precisa
  // saber que existe escopo nem que existe mais de um banco.
  //
  // QUAL banco é decisão de `lib/destinos.js`: o padrão para quase todo mundo, um
  // dedicado para quem o painel apontou. Cliente sem banco resolvido ESTOURA — o
  // cabeçalho de lá explica por que nunca cair no padrão.
  //
  // Sem instância no contexto, também estoura (`no_instance_in_context`). Antes
  // isso significaria ler um banco vazio; hoje significaria ler TODOS os
  // clientes de um banco.
  connectToServer: async function () {
    const nome = instanceContext.required();
    return module.exports.comoCliente(nome);
  },

  // ── AGIR EM NOME DE OUTRO CLIENTE ──────────────────────────────────────────
  //
  // O mesmo banco escopado, num cliente DITO por nome em vez do contexto.
  //
  // Existe para as rotas `/internal/`, que são do painel: contar o uso de um
  // cliente, provisionar, olhar de fora. Elas atendem uma requisição que não é de
  // cliente nenhum e precisam falar de um.
  //
  // Método separado e com nome comprido de propósito: um argumento opcional no
  // `connectToServer()` deixaria "esqueci de passar" e "quis o do contexto" com a
  // mesma aparência.
  comoCliente: async function (instance) {
    const nome = instanceContext.normalize(instance);
    if (!nome) throw new Error("invalid_instance");

    const central = (await connect()).db(centerName);
    const destino = await destinos.destinoDe(nome, central, connectionString);
    const cliente = await destinos.clienteDe(destino.uri);

    return escopo.escopar(cliente.db(destino.banco), nome);
  },

  // EM QUE BANCO um cliente mora — nome e URI, sem abrir conexão com ele.
  //
  // `comoCliente` já perguntava isso por dentro; o que faltava era perguntar de
  // fora, e quem precisa é a rota que prepara UM banco: para saber quais clientes
  // tocar, ela precisa saber quais moram ali. Sem isto ela teria de reimplementar
  // a regra do padrão — o cliente sem `database` cai no banco padrão —, e duas
  // cópias dessa regra é como um cliente vai parar no banco errado.
  destinoDe: async function (instance) {
    const nome = instanceContext.normalize(instance);
    if (!nome) throw new Error("invalid_instance");

    const central = (await connect()).db(centerName);
    return destinos.destinoDe(nome, central, connectionString);
  },

  // ── O BANCO CRU DE UM DESTINO, SEM ESCOPO ──────────────────────────────────
  //
  // Vê os dados de TODOS os clientes que moram naquele banco. Só duas coisas têm
  // motivo para usá-lo:
  //
  //   1. `database/schema.js`, que cria collections e índices — e todo índice
  //      precisa do `instance` como primeiro campo, decisão que tem de ficar
  //      VISÍVEL lá e não escondida num proxy;
  //   2. mover um cliente de banco, que por definição lê de um e escreve no outro.
  //
  // Sem argumento, é o banco PADRÃO. O nome é feio porque o uso é excepcional, e
  // `test/lib/dbRouting.test.js` lista quem pode chamá-lo.
  bancoCruSemEscopo: async function (uri) {
    const central = (await connect()).db(centerName);

    if (uri) {
      const cliente = await destinos.clienteDe(uri);
      return cliente.db(destinos.nomeDoBancoNaUri(uri));
    }

    const padrao = await destinos.padraoOuSemente(central, connectionString);
    const cliente = await destinos.clienteDe(padrao.uri);
    return cliente.db(destinos.nomeDoBancoNaUri(padrao.uri));
  },

  // Todos os bancos registrados. O schema cria collections e índices em CADA um:
  // um banco novo sem as collections é um cliente que não abre.
  bancosRegistrados: async function () {
    const central = (await connect()).db(centerName);
    return destinos.todosOsBancos(central, connectionString);
  },

  // O painel mudou o banco de um cliente: esquece o que estava guardado, para a
  // mudança valer na próxima requisição e não em até 30 segundos.
  esquecerDestino: function (instance) {
    destinos.esquecer(instance ? instanceContext.normalize(instance) : undefined);
  },

  // O nome do banco que a URI do AMBIENTE aponta. É a semente do padrão, e o que
  // o painel mostra como "onde isto está rodando".
  //
  // Já não é "o banco de todos": desde os bancos registrados, quem responde isso
  // por cliente é `lib/destinos.js`.
  nomeDoBanco: function () {
    return baseName;
  },

  centralName: function () {
    return centerName;
  },

  client: function () {
    return client;
  },

  close: async function () {
    // Os clientes de conexão dos bancos registrados também: sem isto um teste que
    // fecha o mongo deixaria sockets abertos e o processo não terminaria.
    await destinos.fechar();
    await client.close();
    conectado = undefined;
    connecting = undefined;
  },
};
