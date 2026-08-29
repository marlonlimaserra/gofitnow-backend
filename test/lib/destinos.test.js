const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const destinos = require("../../lib/destinos.js");

// PARA QUAL BANCO VAI CADA CLIENTE.
//
// O que este arquivo protege é uma coisa, e ela é mais importante que todas as
// outras juntas: quando o destino de um cliente não pode ser resolvido, o sistema
// tem de PARAR — nunca cair no banco padrão.
//
// Cair no padrão parece gentil e é o pior desfecho possível: o cliente veria uma
// conta vazia (o dado está no outro banco) e ESCREVERIA ali. Meia hora depois há
// dado do mesmo cliente em dois bancos e nenhum dos dois está certo. Uma tela de
// erro é recuperável; isso não é.
const URI_PADRAO = "mongodb://127.0.0.1:27017/gofitnow";
const URI_DEDICADA = "mongodb://u:p@10.0.0.9:27017/gofitnow_grandao";

function centralFalsa({ bancos = [], instances = [] } = {}) {
  const cols = {
    databases: [...bancos],
    instances: [...instances],
  };

  const colecao = (nome) => ({
    async findOne(filtro = {}) {
      return cols[nome].find((d) => {
        for (const [k, v] of Object.entries(filtro)) {
          const valor = k === "_id" ? String(d._id) : d[k];
          if (String(valor) !== String(v)) return false;
        }
        return true;
      });
    },
    async countDocuments() {
      return cols[nome].length;
    },
    find() {
      return { toArray: async () => cols[nome] };
    },
    async updateOne(filtro, mudanca, opcoes = {}) {
      const achado = cols[nome].find((d) => String(d.nome) === String(filtro.nome));
      if (!achado && opcoes.upsert && mudanca.$setOnInsert) {
        cols[nome].push({ _id: new ObjectId(), ...mudanca.$setOnInsert });
      }
      return {};
    },
  });

  return { collection: colecao, _cols: cols };
}

test.beforeEach(() => destinos.esquecer());

// ── FALHA FECHADA ─────────────────────────────────────────────────────────

test("cliente que aponta para um banco inexistente ESTOURA", async () => {
  // O caso real: o painel apagou um registro de banco (ou alguém mexeu no
  // documento à mão) e um cliente ficou apontando para o vazio.
  const perdido = new ObjectId();
  const central = centralFalsa({
    bancos: [{ _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true }],
    instances: [{ instance: "grandao", database: String(perdido) }],
  });

  await assert.rejects(
    () => destinos.destinoDe("grandao", central, URI_PADRAO),
    /banco_nao_encontrado/
  );
});

test("cliente não registrado ESTOURA — não ganha banco", async () => {
  const central = centralFalsa({
    bancos: [{ _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true }],
  });

  await assert.rejects(
    () => destinos.destinoDe("ninguem", central, URI_PADRAO),
    /instancia_nao_registrada/
  );
});

test("bancos registrados e NENHUM padrão ESTOURA — não escolho por conta", async () => {
  // Estado inconsistente feito à mão. Escolher um por conta própria esconderia o
  // problema num lugar onde ele custa dado.
  const central = centralFalsa({
    bancos: [{ _id: new ObjectId(), nome: "A", uri: URI_PADRAO, padrao: false }],
    instances: [{ instance: "marlon" }],
  });

  await assert.rejects(
    () => destinos.destinoDe("marlon", central, URI_PADRAO),
    /nenhum_banco_padrao/
  );
});

test("URI registrada sem nome de banco ESTOURA", async () => {
  const central = centralFalsa({
    bancos: [{ _id: new ObjectId(), nome: "Torto", uri: "mongodb://10.0.0.9:27017", padrao: true }],
    instances: [{ instance: "marlon" }],
  });

  await assert.rejects(() => destinos.destinoDe("marlon", central, URI_PADRAO), /banco_sem_nome/);
});

// ── O CAMINHO NORMAL ──────────────────────────────────────────────────────

test("cliente sem banco escolhido usa o PADRÃO", async () => {
  // É o caso de todo mundo que existia antes desta tela: sem o campo `database`.
  const central = centralFalsa({
    bancos: [{ _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true }],
    instances: [{ instance: "marlon" }],
  });

  const d = await destinos.destinoDe("marlon", central, URI_PADRAO);
  assert.equal(d.banco, "gofitnow");
  assert.equal(d.nome, "Principal");
});

test("cliente com banco escolhido vai para o DEDICADO", async () => {
  const dedicado = new ObjectId();
  const central = centralFalsa({
    bancos: [
      { _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true },
      { _id: dedicado, nome: "Grandão", uri: URI_DEDICADA, padrao: false },
    ],
    instances: [{ instance: "grandao", database: String(dedicado) }],
  });

  const d = await destinos.destinoDe("grandao", central, URI_DEDICADA);
  assert.equal(d.banco, "gofitnow_grandao");
  assert.equal(d.nome, "Grandão");
});

test("dois clientes em bancos diferentes não se confundem", async () => {
  const dedicado = new ObjectId();
  const central = centralFalsa({
    bancos: [
      { _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true },
      { _id: dedicado, nome: "Grandão", uri: URI_DEDICADA, padrao: false },
    ],
    instances: [{ instance: "marlon" }, { instance: "grandao", database: String(dedicado) }],
  });

  assert.equal((await destinos.destinoDe("marlon", central, URI_PADRAO)).banco, "gofitnow");
  assert.equal((await destinos.destinoDe("grandao", central, URI_PADRAO)).banco, "gofitnow_grandao");
});

// ── A SEMENTE ─────────────────────────────────────────────────────────────

test("sem banco nenhum registrado, o primeiro boot registra o do ambiente", async () => {
  // Em vez de exigir um passo manual depois do deploy — que alguém esquece, e o
  // sintoma seria "o cadastro não funciona".
  const central = centralFalsa({ bancos: [], instances: [{ instance: "marlon" }] });

  const d = await destinos.destinoDe("marlon", central, URI_PADRAO);
  assert.equal(d.banco, "gofitnow");
  assert.equal(central._cols.databases.length, 1);
  assert.equal(central._cols.databases[0].padrao, true);
  assert.equal(central._cols.databases[0].semeadoDoAmbiente, true);
});

// ── O CACHE ───────────────────────────────────────────────────────────────

test("o destino é guardado, mas ESQUECER o traz de volta do central", async () => {
  // Sem o esquecer, mudar o banco de um cliente no painel levaria até 30s para
  // valer — e nesses 30s as escritas iriam para o banco antigo.
  const dedicado = new ObjectId();
  const central = centralFalsa({
    bancos: [
      { _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true },
      { _id: dedicado, nome: "Grandão", uri: URI_DEDICADA, padrao: false },
    ],
    instances: [{ instance: "grandao" }],
  });

  assert.equal((await destinos.destinoDe("grandao", central, URI_PADRAO)).banco, "gofitnow");

  // O painel aponta o cliente para o dedicado.
  central._cols.instances[0].database = String(dedicado);

  // Sem esquecer, continua no antigo — é o cache funcionando.
  assert.equal((await destinos.destinoDe("grandao", central, URI_PADRAO)).banco, "gofitnow");

  destinos.esquecer("grandao");
  assert.equal((await destinos.destinoDe("grandao", central, URI_PADRAO)).banco, "gofitnow_grandao");
});

test("esquecer um cliente não esquece os outros", async () => {
  const central = centralFalsa({
    bancos: [{ _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true }],
    instances: [{ instance: "a" }, { instance: "b" }],
  });

  await destinos.destinoDe("a", central, URI_PADRAO);
  await destinos.destinoDe("b", central, URI_PADRAO);

  destinos.esquecer("a");

  // `b` continua guardado: se o esquecer limpasse tudo, uma troca de banco num
  // cliente jogaria fora o cache de todos e faria todo mundo ir ao central.
  let idas = 0;
  const espiao = {
    collection: (n) => {
      const real = central.collection(n);
      return { ...real, findOne: async (f) => { idas++; return real.findOne(f); } };
    },
  };
  await destinos.destinoDe("b", espiao, URI_PADRAO);
  assert.equal(idas, 0, "b foi ao central mesmo estando guardado");
});

// ── A LISTA PARA O SCHEMA ─────────────────────────────────────────────────

test("todosOsBancos devolve cada destino, para o schema preparar todos", async () => {
  // Banco recém-registrado sem as collections é um cliente que não abre, e o erro
  // apareceria como "sumiu tudo", longe da causa.
  const central = centralFalsa({
    bancos: [
      { _id: new ObjectId(), nome: "Principal", uri: URI_PADRAO, padrao: true },
      { _id: new ObjectId(), nome: "Grandão", uri: URI_DEDICADA, padrao: false },
    ],
  });

  const todos = await destinos.todosOsBancos(central, URI_PADRAO);
  assert.deepEqual(
    todos.map((t) => t.banco).sort(),
    ["gofitnow", "gofitnow_grandao"]
  );
});

test("nomeDoBancoNaUri entende as formas que aparecem de verdade", () => {
  assert.equal(destinos.nomeDoBancoNaUri("mongodb://h:27017/abc"), "abc");
  assert.equal(destinos.nomeDoBancoNaUri("mongodb://u:p@h:27017/abc?retryWrites=true"), "abc");
  assert.equal(destinos.nomeDoBancoNaUri("mongodb+srv://u:p@c.mongodb.net/abc"), "abc");
  assert.equal(destinos.nomeDoBancoNaUri("mongodb://h:27017"), "");
});
