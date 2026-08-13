const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const Workout_model = require("../../model/Workout_model.js");

// A ordem da lista de treinos, escolhida arrastando os cards.
//
// Duas garantias moram aqui. A primeira é a migração: quem já tinha treinos
// antes de `order` existir não pode ver a lista embaralhar sozinha — a primeira
// listagem congela a sequência que a tela mostrava. A segunda é o isolamento:
// mandar o id de um treino que não é seu não pode movê-lo.
function fakeWorkouts(docs) {
  const col = {
    docs,
    escritas: [],
    find(query) {
      const achados = docs.filter((d) =>
        Object.entries(query).every(([k, v]) => String(d[k]) === String(v))
      );
      return {
        sort(spec) {
          const [campo, dir] = Object.entries(spec)[0];
          achados.sort((a, b) => (String(a[campo]) < String(b[campo]) ? 1 : -1) * dir * -1);
          return this;
        },
        async toArray() {
          return achados;
        },
      };
    },
    async countDocuments(query) {
      return docs.filter((d) => Object.entries(query).every(([k, v]) => String(d[k]) === String(v)))
        .length;
    },
    async insertOne(doc) {
      const _id = new ObjectId();
      docs.push({ ...doc, _id });
      return { insertedId: _id };
    },
    async bulkWrite(ops) {
      col.escritas.push(ops);
      for (const { updateOne } of ops) {
        const alvo = docs.find((d) =>
          Object.entries(updateOne.filter).every(([k, v]) => String(d[k]) === String(v))
        );
        if (alvo) Object.assign(alvo, updateOne.update.$set);
      }
      return { modifiedCount: ops.length };
    },
  };

  return col;
}

const TRAINER = new ObjectId();
const OUTRO_TRAINER = new ObjectId();
const PESSOA = new ObjectId();

function monta(docs = []) {
  const col = fakeWorkouts(docs);
  const model = new Workout_model({ crypto });
  model.workoutsCollection = async () => col;
  return { model, col };
}

// Um treino como o banco guardava ANTES de `order` existir: sem o campo.
function antigo(name, startDate) {
  return {
    _id: new ObjectId(),
    trainer: TRAINER,
    student: PESSOA,
    name,
    startDate,
    exercises: [],
  };
}

test("treino novo nasce no fim da fila", async () => {
  const { model, col } = monta();

  await model.insert(TRAINER, PESSOA, { name: "A" });
  await model.insert(TRAINER, PESSOA, { name: "B" });
  await model.insert(TRAINER, PESSOA, { name: "C" });

  assert.deepEqual(
    col.docs.map((d) => [d.name, d.order]),
    [
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ]
  );
});

test("a fila é por pessoa: outro profissional não empurra a posição", async () => {
  const OUTRA_PESSOA = new ObjectId();
  const { model, col } = monta();

  await model.insert(TRAINER, PESSOA, { name: "A" });
  await model.insert(OUTRO_TRAINER, OUTRA_PESSOA, { name: "de outro" });
  await model.insert(TRAINER, PESSOA, { name: "B" });

  const meus = col.docs.filter((d) => String(d.trainer) === String(TRAINER));
  assert.deepEqual(
    meus.map((d) => d.order),
    [0, 1]
  );
});

test("a primeira listagem congela a ordem que a tela já mostrava", async () => {
  // Sem `order` no banco, a lista saía por data decrescente. É essa sequência
  // que vira 0,1,2 — e não a ordem de criação, nem a do banco.
  const { model, col } = monta([
    antigo("velho", "2026-01-10"),
    antigo("novo", "2026-08-10"),
    antigo("meio", "2026-05-10"),
  ]);

  const lista = await model.list(TRAINER, PESSOA);

  assert.deepEqual(
    lista.map((w) => [w.name, w.order]),
    [
      ["novo", 0],
      ["meio", 1],
      ["velho", 2],
    ]
  );

  // E ficou gravado: a segunda listagem não depende mais da data.
  assert.equal(col.escritas.length, 1);
  assert.deepEqual(
    col.docs.map((d) => typeof d.order),
    ["number", "number", "number"]
  );
});

test("com todo mundo já numerado, a listagem não grava nada", async () => {
  const docs = [antigo("a", "2026-01-10"), antigo("b", "2026-08-10")];
  docs[0].order = 0;
  docs[1].order = 1;

  const { model, col } = monta(docs);
  const lista = await model.list(TRAINER, PESSOA);

  // Manda `order`, não a data: "a" é mais antigo e mesmo assim vem primeiro.
  assert.deepEqual(
    lista.map((w) => w.name),
    ["a", "b"]
  );
  assert.equal(col.escritas.length, 0);
});

test("saveOrder numera na sequência recebida", async () => {
  const docs = [antigo("a", "2026-01-10"), antigo("b", "2026-02-10"), antigo("c", "2026-03-10")];
  docs.forEach((d, i) => {
    d.order = i;
  });

  const { model, col } = monta(docs);
  const [a, b, c] = docs;

  await model.saveOrder(TRAINER, PESSOA, [c._id, a._id, b._id]);

  assert.equal(c.order, 0);
  assert.equal(a.order, 1);
  assert.equal(b.order, 2);
});

test("saveOrder não move treino de outro profissional", async () => {
  const alheio = antigo("alheio", "2026-01-10");
  alheio.trainer = OUTRO_TRAINER;
  alheio.order = 7;

  const { model } = monta([alheio]);

  await model.saveOrder(TRAINER, PESSOA, [alheio._id]);

  assert.equal(alheio.order, 7);
});

test("saveOrder recusa lista vazia ou só com id inválido", async () => {
  const { model, col } = monta([]);

  assert.equal(await model.saveOrder(TRAINER, PESSOA, []), false);
  assert.equal(await model.saveOrder(TRAINER, PESSOA, undefined), false);
  assert.equal(await model.saveOrder(TRAINER, PESSOA, ["não-é-id"]), false);
  assert.equal(col.escritas.length, 0);
});
