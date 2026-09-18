const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Checkin = require(path.join(__dirname, "..", "..", "model", "GroupClassCheckin_model.js"));

// O CHECK-IN DE UMA AULA COLETIVA.
//
// *"se por não, o usuário só pode se inscrever uma vez por dia"*.
//
// A regra não mora num `if`: ela mora em DOIS ÍNDICES ÚNICOS, e é por isso que
// estes casos falam tanto do erro 11000. Um `findOne` antes de inserir perde a
// corrida entre dois pedidos simultâneos — e dois pedidos simultâneos é
// exatamente o que um toque duplo num celular lento produz.

const AULA = "6a80de570056d24c09f5da61";
const PESSOA = "6a80de570056d24c09f5da62";

// O dobro do Mongo: guarda o que foi inserido e sabe estourar 11000 quando
// mandarem, para os casos exercitarem os dois lados do índice.
function monta({ duplicado = false, jaTem = null } = {}) {
  const inseridos = [];

  const col = {
    insertOne: async (doc) => {
      if (duplicado) {
        const e = new Error("dup");
        e.code = 11000;
        throw e;
      }
      inseridos.push(doc);
      return { insertedId: "novo" };
    },
    findOne: async () => jaTem,
    deleteMany: async () => ({ deletedCount: 1 }),
  };

  const model = new Checkin({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
  });

  return { model, inseridos };
}

test("a presença guarda o HORÁRIO, e não só a aula", async () => {
  // A mesma aula acontece às 07:00 e às 18:00. Sem o horário, as duas
  // presenças seriam a mesma linha.
  const { model, inseridos } = monta();

  await model.entrar(AULA, "2026-09-21", PESSOA, { inicio: 420 });

  assert.equal(inseridos[0].inicio, 420);
});

test("sem horário, não entra", async () => {
  const { model } = monta();
  const r = await model.entrar(AULA, "2026-09-21", PESSOA, {});

  assert.equal(r.ok, false);
  assert.equal(r.erro, "horario");
});

test("dia que não é data não entra", async () => {
  const { model } = monta();
  const r = await model.entrar(AULA, "hoje", PESSOA, { inicio: 420 });

  assert.equal(r.ok, false);
});

test("na aula de UM POR DIA, a linha leva a marca do índice parcial", async () => {
  // É a marca, e não um `if` no meio do caminho, que segura a regra: o índice
  // parcial só vale nas linhas que a têm.
  const { model, inseridos } = monta();

  await model.entrar(AULA, "2026-09-21", PESSOA, { inicio: 420 });

  assert.equal(inseridos[0].unico, true);
});

test("na aula que PERMITE vários, a marca não é escrita", async () => {
  const { model, inseridos } = monta();

  await model.entrar(AULA, "2026-09-21", PESSOA, { inicio: 420, variosHorarios: true });

  assert.ok(!("unico" in inseridos[0]));
});

test("o segundo clique no MESMO horário não é falha", async () => {
  // Já estava dentro. É a resposta certa para um toque duplo, e não um erro na
  // cara de quem já fez o que queria.
  const { model } = monta({ duplicado: true, jaTem: { _id: "x" } });

  const r = await model.entrar(AULA, "2026-09-21", PESSOA, { inicio: 420 });

  assert.equal(r.ok, true);
  assert.equal(r.novo, false);
});

test("OUTRO horário numa aula de um por dia é RECUSA, com motivo", async () => {
  // A tela precisa saber o porquê para dizer "você já entrou na aula das
  // 07:00" — e não um "não foi possível" que não ensina nada.
  const { model } = monta({ duplicado: true, jaTem: null });

  const r = await model.entrar(AULA, "2026-09-21", PESSOA, { inicio: 1080 });

  assert.equal(r.ok, false);
  assert.equal(r.erro, "ja_entrou_hoje");
});

test("a contagem é por AULA E HORÁRIO — a vaga é do horário", async () => {
  // A de 07:00 lotar não fecha a de 18:00, e uma contagem por aula diria que
  // sim.
  const linhas = [
    { _id: { class: "c1", inicio: 420 }, n: 12 },
    { _id: { class: "c1", inicio: 1080 }, n: 3 },
  ];

  const model = new Checkin({
    mongodb: {
      async connectToServer() {
        return { collection: () => ({ aggregate: () => ({ toArray: async () => linhas }) }) };
      },
    },
  });

  assert.deepEqual(await model.contagemDoDia("2026-09-21"), { "c1:420": 12, "c1:1080": 3 });
});
