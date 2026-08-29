const { MongoClient } = require("mongodb");

// PARA QUAL BANCO VAI CADA CLIENTE.
//
// ── A história em três passos ─────────────────────────────────────────────
//
//   1. um banco por cliente. Isolamento de graça, e não passa de mil clientes:
//      35 collections e ~99 índices por cliente, um arquivo do WiredTiger para
//      cada, e o catálogo do Mongo mora em RAM.
//   2. um banco só, com `instance` em cada documento. Escala, e põe o cliente
//      grande no mesmo ferro que os pequenos — um relatório dele entra na fila de
//      todo mundo.
//   3. este arquivo: N bancos REGISTRADOS no painel, cada cliente aponta para um,
//      e um deles é o padrão. O cliente que cresce ganha ferro só dele sem que
//      nenhum modelo mude de linha.
//
// ── O `instance` continua, mesmo no banco dedicado ───────────────────────
//
// Um banco com um cliente só dispensaria o campo. Não dispensa, e a razão é
// prática: mover um cliente passaria a exigir reescrever todos os documentos
// dele, e `lib/escopo.js` precisaria de dois modos — um filtrado e um não. Um
// caminho só, sempre filtrado, é o que faz "mover" ser copiar e "voltar atrás"
// ser apontar de volta.
//
// ── FALHA FECHADA, sempre ─────────────────────────────────────────────────
//
// Cliente cujo banco não está registrado, ou cujo registro aponta para um id que
// já não existe: ESTOURA. Nunca cai no padrão.
//
// Cair no padrão parece gentil e é a pior coisa possível: o cliente veria uma
// conta vazia (o dado está no outro banco) e, pior, ESCREVERIA ali. Meia hora
// depois há dado do mesmo cliente em dois bancos e nenhum dos dois está certo.
// Uma tela de erro é recuperável; isso não é.
const TTL_MS = 30_000;

// Um MongoClient por URI, para sempre. Abrir conexão por requisição derrubaria o
// pool — o ganho do driver é justamente manter as conexões vivas.
const clientes = new Map();

// De qual banco é cada cliente, por pouco tempo. Cada requisição precisa disto
// antes de qualquer consulta; ir ao central toda vez dobraria a ida ao banco.
// TTL curto porque "mover para dedicado" tem de valer rápido.
const cache = new Map();

function guardar(chave, valor) {
  cache.set(chave, { valor, vale: Date.now() + TTL_MS });
  return valor;
}

function lido(chave) {
  const g = cache.get(chave);
  if (!g || Date.now() >= g.vale) return undefined;
  return g.valor;
}

// Esquecer é chamado quando o painel muda o banco de um cliente. Sem isto, a
// mudança levaria até 30s para valer — e nesses 30s as escritas iriam para o
// banco antigo.
function esquecer(instancia) {
  if (instancia) cache.delete("d:" + instancia);
  else cache.clear();
}

function nomeDoBancoNaUri(uri) {
  const semEsquema = String(uri || "").replace(/^mongodb(\+srv)?:\/\//, "");
  const caminho = semEsquema.split("/").slice(1).join("/");
  return caminho.split("?")[0].trim();
}

// O cliente de conexão de uma URI. Criado na primeira vez, reusado depois.
//
// `connect()` é chamado sempre: o driver o trata como idempotente, e chamá-lo
// evita a corrida de duas requisições pegarem o cliente antes de ele estar de pé.
async function clienteDe(uri) {
  const chave = String(uri);
  if (!clientes.has(chave)) {
    clientes.set(
      chave,
      new MongoClient(chave, { serverSelectionTimeoutMS: 8000 })
    );
  }
  const c = clientes.get(chave);
  await c.connect();
  return c;
}

// ── O PADRÃO, e a semente ─────────────────────────────────────────────────
//
// Sem nenhum banco registrado, o sistema não sabe onde pôr ninguém. Em vez de
// exigir um passo manual depois do deploy (que alguém esqueceria, e o sintoma
// seria "o cadastro não funciona"), o primeiro boot REGISTRA o banco que já está
// em uso, tirado do próprio `MONGODB_URI`.
//
// É a única escrita que este arquivo faz no registro, e ela é idempotente.
async function padraoOuSemente(central, uriDoAmbiente) {
  const col = central.collection("databases");

  const padrao = await col.findOne({ padrao: true });
  if (padrao) return padrao;

  // Já há bancos registrados, mas nenhum padrão: não invento um. Isto é estado
  // inconsistente feito à mão, e escolher por conta própria esconderia o
  // problema num lugar onde ele custa dado.
  const quantos = await col.countDocuments({});
  if (quantos > 0) {
    throw new Error("nenhum_banco_padrao: há bancos registrados e nenhum marcado como padrão");
  }

  const doc = {
    nome: "Principal",
    uri: String(uriDoAmbiente),
    padrao: true,
    criadoEm: new Date(),
    atualizadoEm: new Date(),
    // Fica dito que ninguém digitou isto: veio do ambiente, no primeiro boot.
    semeadoDoAmbiente: true,
  };

  // `upsert` pelo nome e não `insertOne`: dois processos subindo juntos (o
  // cluster tem mais de um worker) tentariam inserir os dois.
  await col.updateOne({ nome: doc.nome }, { $setOnInsert: doc }, { upsert: true });
  return await col.findOne({ nome: doc.nome });
}

// O destino de um cliente: `{ uri, banco }`.
//
// `central` é o banco do painel (de onde saem `instances` e `databases`), e
// `uriDoAmbiente` é o `MONGODB_URI` — usado só para semear o padrão.
async function destinoDe(instancia, central, uriDoAmbiente) {
  const guardado = lido("d:" + instancia);
  if (guardado) return guardado;

  const registro = await central.collection("instances").findOne({ instance: instancia });

  // Cliente não registrado NÃO ganha banco. Quem barra isso antes é o
  // `instanceGate`; aqui é a segunda tranca, porque este caminho também é
  // chamado por rotas internas.
  if (!registro) throw new Error(`instancia_nao_registrada: ${instancia}`);

  let escolhido;
  if (registro.database) {
    const { ObjectId } = require("mongodb");
    escolhido = ObjectId.isValid(String(registro.database))
      ? await central.collection("databases").findOne({ _id: new ObjectId(String(registro.database)) })
      : undefined;

    // Aponta para um banco que não existe mais. Falha fechada — ver o cabeçalho.
    if (!escolhido) {
      throw new Error(
        `banco_nao_encontrado: o cliente "${instancia}" aponta para o banco ` +
          `${registro.database}, que não está registrado`
      );
    }
  } else {
    escolhido = await padraoOuSemente(central, uriDoAmbiente);
  }

  const banco = nomeDoBancoNaUri(escolhido.uri);
  if (!banco) throw new Error(`banco_sem_nome: a URI do banco "${escolhido.nome}" não diz o banco`);

  return guardar("d:" + instancia, { uri: escolhido.uri, banco, nome: escolhido.nome });
}

// Todos os bancos registrados, para o schema criar collections e índices em cada
// um. Um banco novo sem as 37 collections é um cliente que não abre.
async function todosOsBancos(central, uriDoAmbiente) {
  await padraoOuSemente(central, uriDoAmbiente);
  const docs = await central.collection("databases").find({}).toArray();
  return docs.map((d) => ({ nome: d.nome, uri: d.uri, banco: nomeDoBancoNaUri(d.uri) }));
}

async function fechar() {
  for (const c of clientes.values()) await c.close().catch(() => {});
  clientes.clear();
  cache.clear();
}

module.exports = {
  clienteDe,
  destinoDe,
  todosOsBancos,
  padraoOuSemente,
  nomeDoBancoNaUri,
  esquecer,
  fechar,
  TTL_MS,
};
