const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const Workout_model = require("../../model/Workout_model.js");

// Duplicar um treino, com os exercícios dentro.
//
// Este arquivo era `duplicateSession.test.js`: copiava a SESSÃO de um treino para
// outro. As sessões deixaram de existir — cada dia virou um treino — e o que era
// "copiar a segunda-feira para outro plano" é agora "copiar o treino para outra
// pessoa". A garantia que importava continua a mesma, e é a razão de o arquivo
// sobreviver: a cópia tem de ser INDEPENDENTE da original.
function fakeWorkouts(docs) {
  const inseridos = [];

  return {
    docs,
    inseridos,
    // Honra TODOS os campos do filtro. Um dublê que ignorasse `trainer` deixaria
    // o teste de isolamento entre profissionais passar por engano.
    async findOne(query) {
      return (
        docs.find((d) => Object.entries(query).every(([k, v]) => String(d[k]) === String(v))) || null
      );
    },
    // O insert conta os treinos da pessoa para pôr o novo no fim da fila — é
    // por isso que a cópia não divide a posição com a original.
    async countDocuments(query) {
      return docs.filter((d) => Object.entries(query).every(([k, v]) => String(d[k]) === String(v)))
        .length;
    },
    async insertOne(doc) {
      const _id = new ObjectId();
      inseridos.push({ ...doc, _id });
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
const OUTRO_TRAINER = new ObjectId();
const PESSOA = new ObjectId();
const OUTRA_PESSOA = new ObjectId();
const W1 = new ObjectId();

function monta() {
  const treino = {
    _id: W1,
    trainer: TRAINER,
    student: PESSOA,
    name: "Segunda-feira",
    goal: "Hipertrofia",
    teacherName: "Marlon",
    startDate: "2026-08-12",
    endDate: "2026-09-12",
    calories: 300,
    totalSessions: null,
    tip: "",
    kind: "individual",
    exercises: [
      {
        exerciseId: "e1",
        name: "Supino",
        muscleGroup: "Peito",
        sets: [{ unit: "reps", quantity: "12" }],
      },
      {
        exerciseId: "e2",
        name: "Rosca",
        muscleGroup: "Bíceps",
        sets: [{ unit: "reps", quantity: "10" }],
      },
    ],
    createdAt: new Date("2020-01-01"),
    updatedAt: new Date("2020-01-01"),
  };

  const col = fakeWorkouts([treino]);
  const model = new Workout_model({ crypto });
  model.workoutsCollection = async () => col;

  return { model, col, treino };
}

test("copia o treino com os exercícios e as séries", async () => {
  const { model, col } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, "Segunda-feira (cópia)");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.equal(copia.name, "Segunda-feira (cópia)");
  assert.equal(copia.exercises.length, 2);
  assert.equal(copia.exercises[0].name, "Supino");
  assert.equal(copia.exercises[0].sets[0].quantity, "12");
});

test("a cópia é INDEPENDENTE: mexer nela não mexe na original", async () => {
  // `structuredClone`, e não uma atribuição: sem ele as séries das duas
  // apontariam para os mesmos objetos, e editar a cópia mudaria a original — o
  // pior tipo de defeito para descobrir depois.
  const { model, col, treino } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, "Cópia");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  copia.exercises[0].sets[0].quantity = "999";
  copia.exercises[0].name = "Trocado";

  assert.equal(treino.exercises[0].sets[0].quantity, "12", "a original não podia mudar");
  assert.equal(treino.exercises[0].name, "Supino");
});

test("os dados do plano vão junto", async () => {
  // Período, professor e objetivo são do treino agora. Copiar sem eles obrigaria
  // a redigitar tudo, que é o oposto do ponto de copiar.
  const { model, col } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, "Cópia");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.equal(copia.goal, "Hipertrofia");
  assert.equal(copia.teacherName, "Marlon");
  assert.equal(copia.startDate, "2026-08-12");
  assert.equal(copia.endDate, "2026-09-12");
  assert.equal(copia.calories, 300);
});

test("a cópia nasce com datas próprias e sem o _id da original", async () => {
  const { model, col, treino } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, "Cópia");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.notEqual(String(copia._id), String(treino._id));
  assert.ok(copia.createdAt > treino.createdAt, "createdAt tinha de ser de agora");
});

test("com outra pessoa, a cópia vai para ela", async () => {
  const { model, col } = monta();

  const novoId = await model.duplicate(TRAINER, W1, OUTRA_PESSOA, "Cópia");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.equal(String(copia.student), String(OUTRA_PESSOA));
});

test("sem pessoa de destino, fica com a mesma", async () => {
  const { model, col } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, "Cópia");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.equal(String(copia.student), String(PESSOA));
});

test("o nome vem de quem pediu", async () => {
  const { model, col } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, "  Terça-feira  ");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.equal(copia.name, "Terça-feira", "espaço em volta não é nome");
});

test("sem nome, herda o da original com o sufixo", async () => {
  const { model, col } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, undefined);
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.equal(copia.name, "Segunda-feira (cópia)");
});

test("nome só de espaços cai no sufixo, não vira vazio", async () => {
  const { model, col } = monta();

  const novoId = await model.duplicate(TRAINER, W1, undefined, "   ");
  const copia = col.docs.find((d) => String(d._id) === String(novoId));

  assert.equal(copia.name, "Segunda-feira (cópia)");
});

test("treino que não é do profissional não é copiado", async () => {
  const { model } = monta();
  assert.equal(await model.duplicate(OUTRO_TRAINER, W1, undefined, "Cópia"), undefined);
});

test("id inválido devolve undefined em vez de estourar", async () => {
  const { model } = monta();
  assert.equal(await model.duplicate(TRAINER, "nao-e-id", undefined, "x"), undefined);
});
