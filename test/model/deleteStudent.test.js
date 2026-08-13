const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const User_model = require("../../model/User_model.js");
const Workout_model = require("../../model/Workout_model.js");

// Excluir uma pessoa apaga TUDO dela.
//
// O que este arquivo segura é o vazamento que existiu até 13/08/2026: o
// cadastro sumia e os treinos ficavam no banco apontando para um `student`
// apagado. Nenhuma tela os alcançava e nada os apagava depois — lixo
// permanente, crescendo a cada exclusão.
function fakeCollection(docs) {
  return {
    docs,
    async deleteOne(query) {
      const i = docs.findIndex((d) =>
        Object.entries(query).every(([k, v]) => String(d[k]) === String(v))
      );
      if (i < 0) return { deletedCount: 0 };
      docs.splice(i, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(query) {
      const ficam = docs.filter(
        (d) => !Object.entries(query).every(([k, v]) => String(d[k]) === String(v))
      );
      const apagados = docs.length - ficam.length;
      docs.length = 0;
      docs.push(...ficam);
      return { deletedCount: apagados };
    },
  };
}

const TRAINER = new ObjectId();
const PESSOA = new ObjectId();
const OUTRA_PESSOA = new ObjectId();

function monta({ vinculado = true } = {}) {
  const users = fakeCollection([
    { _id: PESSOA, name: "Bruna Sampaio", type: "student" },
    { _id: OUTRA_PESSOA, name: "Quem fica", type: "student" },
  ]);

  const workouts = fakeCollection([
    { _id: new ObjectId(), student: PESSOA, trainer: TRAINER, name: "Segunda" },
    { _id: new ObjectId(), student: PESSOA, trainer: TRAINER, name: "Quarta" },
    { _id: new ObjectId(), student: OUTRA_PESSOA, trainer: TRAINER, name: "De outra pessoa" },
  ]);

  const link = {
    apagados: [],
    async exists() {
      return vinculado;
    },
    async deleteAllOf(id) {
      link.apagados.push(String(id));
      return true;
    },
  };

  const workout = new Workout_model({});
  workout.workoutsCollection = async () => workouts;

  // Os planos alimentares saem junto desde 13/08/2026, pelo mesmo motivo dos
  // treinos: sem isso ficariam apontando para um `student` apagado.
  const diet = { apagadosDe: [], async deleteAllOfStudent(id) {
    diet.apagadosDe.push(String(id));
    return 0;
  } };

  const app = { api: { link, workout, diet } };
  const user = new User_model(app);
  user.collection = async () => users;
  app.api.user = user;

  return { user, users, workouts, link, diet };
}

test("apaga a pessoa, os vínculos, os treinos e os planos dela", async () => {
  const { user, users, workouts, link, diet } = monta();

  const ok = await user.deleteStudent(TRAINER, PESSOA);

  assert.equal(ok, true);
  assert.deepEqual(
    users.docs.map((d) => d.name),
    ["Quem fica"]
  );
  assert.deepEqual(link.apagados, [String(PESSOA)]);
  assert.deepEqual(
    workouts.docs.map((w) => w.name),
    ["De outra pessoa"]
  );
  assert.deepEqual(diet.apagadosDe, [String(PESSOA)]);
});

test("não encosta nos treinos de quem ficou", async () => {
  const { user, workouts } = monta();

  await user.deleteStudent(TRAINER, PESSOA);

  const sobrou = workouts.docs;
  assert.equal(sobrou.length, 1);
  assert.equal(String(sobrou[0].student), String(OUTRA_PESSOA));
});

test("sem vínculo, não apaga nada", async () => {
  // A pessoa existe, mas não é desse profissional. O `exists` do link é o que
  // guarda a porta — sem ele, um id adivinhado apagaria ficha alheia.
  const { user, users, workouts } = monta({ vinculado: false });

  const ok = await user.deleteStudent(TRAINER, PESSOA);

  assert.equal(ok, false);
  assert.equal(users.docs.length, 2);
  assert.equal(workouts.docs.length, 3);
});

test("id inválido não chega a tocar no banco", async () => {
  const { user, users, workouts } = monta();

  assert.equal(await user.deleteStudent(TRAINER, "não-é-id"), false);
  assert.equal(users.docs.length, 2);
  assert.equal(workouts.docs.length, 3);
});

test("deleteAllOfStudent devolve quantos apagou e ignora id inválido", async () => {
  const { workouts } = monta();
  const workout = new Workout_model({});
  workout.workoutsCollection = async () => workouts;

  assert.equal(await workout.deleteAllOfStudent("não-é-id"), 0);
  assert.equal(workouts.docs.length, 3);

  assert.equal(await workout.deleteAllOfStudent(PESSOA), 2);
  assert.equal(workouts.docs.length, 1);
});
