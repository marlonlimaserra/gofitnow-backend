const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const Workout_model = require("../../model/Workout_model.js");

// Os dias da semana de um treino.
//
// O que o modelo garante, e o que estes testes seguram: a lista chega do
// formulário na ordem em que os botões foram clicados, e sai SEMPRE na ordem da
// semana, sem repetição e sem nada que não seja um dia. Assim nenhuma tela
// precisa ordenar de novo antes de exibir, e um cliente mal-comportado não
// consegue gravar lixo no documento.
function fakeWorkouts(docs) {
  return {
    docs,
    async findOne(query) {
      return (
        docs.find((d) => Object.entries(query).every(([k, v]) => String(d[k]) === String(v))) || null
      );
    },
    // O insert consulta quantos treinos a pessoa já tem para pôr o novo no fim
    // da fila (ver workoutOrder.test.js). Aqui a contagem não importa, mas o
    // dublê precisa responder.
    async countDocuments(query) {
      return docs.filter((d) => Object.entries(query).every(([k, v]) => String(d[k]) === String(v)))
        .length;
    },
    async insertOne(doc) {
      const _id = new ObjectId();
      docs.push({ ...doc, _id });
      return { insertedId: _id };
    },
    async updateOne(query, update) {
      const doc = await this.findOne(query);
      if (doc) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },
  };
}

const TRAINER = new ObjectId();
const PESSOA = new ObjectId();

function monta(docs = []) {
  const col = fakeWorkouts(docs);
  const model = new Workout_model({ crypto });
  model.workoutsCollection = async () => col;
  return { model, col };
}

async function criaCom(weekdays) {
  const { model, col } = monta();
  const id = await model.insert(TRAINER, PESSOA, { name: "Treino A", weekdays });
  return col.docs.find((d) => String(d._id) === String(id));
}

test("grava na ordem da semana, não na ordem em que foram clicados", async () => {
  const treino = await criaCom(["friday", "monday", "wednesday"]);
  assert.deepEqual(treino.weekdays, ["monday", "wednesday", "friday"]);
});

test("dia repetido entra uma vez só", async () => {
  const treino = await criaCom(["monday", "monday", "friday"]);
  assert.deepEqual(treino.weekdays, ["monday", "friday"]);
});

test("o que não é dia da semana é descartado", async () => {
  const treino = await criaCom(["monday", "caturday", "", null, 7]);
  assert.deepEqual(treino.weekdays, ["monday"]);
});

test("aceita maiúscula e espaço em volta", async () => {
  const treino = await criaCom([" Monday ", "TUESDAY"]);
  assert.deepEqual(treino.weekdays, ["monday", "tuesday"]);
});

test("sem dias nenhum, nasce lista vazia — nunca undefined", async () => {
  const treino = await criaCom(undefined);
  assert.deepEqual(treino.weekdays, []);

  // Toda leitura poder confiar que o campo é um array é o que evita espalhar
  // `(w.weekdays || [])` por cada tela que exibe os dias.
  assert.ok(Array.isArray(treino.weekdays));
});

test("editar sem mandar weekdays não apaga os dias que já estavam lá", async () => {
  // O PUT do modal manda o formulário inteiro, mas outros clientes (e o app)
  // mandam só o que mudou. Campo ausente tem de significar "não mexe".
  const W1 = new ObjectId();
  const { model, col } = monta([
    { _id: W1, trainer: TRAINER, student: PESSOA, name: "Treino A", weekdays: ["monday"] },
  ]);

  await model.update(TRAINER, W1, { name: "Treino B" });

  const treino = col.docs[0];
  assert.equal(treino.name, "Treino B");
  assert.deepEqual(treino.weekdays, ["monday"]);
});

test("editar mandando lista vazia limpa os dias", async () => {
  const W1 = new ObjectId();
  const { model, col } = monta([
    { _id: W1, trainer: TRAINER, student: PESSOA, name: "Treino A", weekdays: ["monday"] },
  ]);

  await model.update(TRAINER, W1, { weekdays: [] });

  assert.deepEqual(col.docs[0].weekdays, []);
});
