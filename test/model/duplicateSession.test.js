const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const Workout_model = require("../../model/Workout_model.js");

// Uma collection de sessões de mentira, com o suficiente do driver do Mongo
// para o método rodar: find().sort().toArray(), findOne com sort e insertOne.
function fakeSessions(docs) {
  const inseridos = [];

  const col = {
    docs,
    inseridos,
    find(query) {
      const filtrados = docs.filter((d) => String(d.workout) === String(query.workout));
      return {
        sort(spec) {
          const campo = Object.keys(spec)[0];
          filtrados.sort((a, b) => (a[campo] - b[campo]) * spec[campo]);
          return this;
        },
        toArray: async () => filtrados,
      };
    },
    // Honra TODOS os campos do filtro. Um dublê que ignorasse `trainer`
    // deixaria o teste de isolamento entre profissionais passar por engano.
    async findOne(query, opts) {
      const casa = (d) =>
        Object.entries(query).every(([k, v]) => String(d[k]) === String(v));

      const filtrados = docs.filter(casa);
      if (opts?.sort?.order === -1) {
        return [...filtrados].sort((a, b) => b.order - a.order)[0];
      }
      return filtrados[0];
    },
    async insertOne(doc) {
      const _id = new ObjectId();
      inseridos.push({ ...doc, _id });
      docs.push({ ...doc, _id });
      return { insertedId: _id };
    },
  };

  return col;
}

const TRAINER = new ObjectId();
const W1 = new ObjectId();
const W2 = new ObjectId();
const S1 = new ObjectId();

function monta() {
  const sessao = {
    _id: S1,
    workout: W1,
    trainer: TRAINER,
    name: "Segunda-feira",
    order: 0,
    calories: 300,
    exercises: [
      { exerciseId: "e1", name: "Supino", muscleGroup: "Peito", sets: [{ unit: "reps", quantity: "12" }] },
      { exerciseId: "e2", name: "Rosca", muscleGroup: "Bíceps", sets: [{ unit: "reps", quantity: "10" }] },
    ],
    createdAt: new Date("2020-01-01"),
    updatedAt: new Date("2020-01-01"),
  };

  // Uma sessão já existente no treino de destino, para provar a ordem.
  const outra = { _id: new ObjectId(), workout: W2, trainer: TRAINER, name: "Já existia", order: 7, exercises: [] };

  const col = fakeSessions([sessao, outra]);
  const model = new Workout_model({ crypto });
  model.sessionsCollection = async () => col;

  return { model, col, sessao };
}

test("copia a sessão com os exercícios e as séries", async () => {
  const { model, col } = monta();
  const novoId = await model.duplicateSession(TRAINER, S1, undefined, "Segunda-feira (cópia)");

  assert.ok(novoId);
  const copia = col.inseridos.at(-1);
  assert.equal(copia.exercises.length, 2);
  assert.equal(copia.exercises[0].name, "Supino");
  assert.equal(copia.exercises[0].sets[0].quantity, "12");
});

test("a cópia é INDEPENDENTE: mexer nela não mexe na original", async () => {
  const { model, col, sessao } = monta();
  await model.duplicateSession(TRAINER, S1, undefined, "Cópia");

  const copia = col.inseridos.at(-1);
  copia.exercises[0].sets[0].quantity = "99";

  assert.equal(sessao.exercises[0].sets[0].quantity, "12", "a original foi alterada junto");
});

test("sem treino de destino, a cópia fica no MESMO treino", async () => {
  const { model, col } = monta();
  await model.duplicateSession(TRAINER, S1, undefined, "Cópia");
  assert.equal(String(col.inseridos.at(-1).workout), String(W1));
});

test("com treino de destino, a cópia vai para ele", async () => {
  const { model, col } = monta();
  await model.duplicateSession(TRAINER, S1, W2, "Cópia");
  assert.equal(String(col.inseridos.at(-1).workout), String(W2));
});

test("a cópia entra no FIM da fila do treino de destino", async () => {
  // O destino já tem uma sessão em order 7.
  const { model, col } = monta();
  await model.duplicateSession(TRAINER, S1, W2, "Cópia");
  assert.equal(col.inseridos.at(-1).order, 8);
});

test("num treino vazio, a cópia começa em zero", async () => {
  const { model, col } = monta();
  const vazio = new ObjectId();
  await model.duplicateSession(TRAINER, S1, vazio, "Cópia");
  assert.equal(col.inseridos.at(-1).order, 0);
});

test("o nome vem de quem pediu", async () => {
  const { model, col } = monta();
  await model.duplicateSession(TRAINER, S1, undefined, "  Terça-feira  ");
  assert.equal(col.inseridos.at(-1).name, "Terça-feira");
});

test("sem nome, herda o da original com o sufixo", async () => {
  const { model, col } = monta();
  await model.duplicateSession(TRAINER, S1, undefined, undefined);
  assert.match(col.inseridos.at(-1).name, /Segunda-feira \(c[óo]pia\)/);
});

test("a cópia nasce com datas próprias e sem o _id da original", async () => {
  const { model, col } = monta();
  await model.duplicateSession(TRAINER, S1, undefined, "Cópia");

  const copia = col.inseridos.at(-1);
  assert.notEqual(String(copia._id), String(S1));
  assert.ok(copia.createdAt.getTime() > new Date("2020-01-02").getTime());
});

test("sessão que não é do profissional não é copiada", async () => {
  const { model } = monta();
  const outroTrainer = new ObjectId();
  assert.equal(await model.duplicateSession(outroTrainer, S1, undefined, "Cópia"), undefined);
});

test("id inválido devolve undefined em vez de estourar", async () => {
  const { model } = monta();
  assert.equal(await model.duplicateSession(TRAINER, "nao-e-id", undefined, "x"), undefined);
});
