const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const User_model = require("../../model/User_model.js");
const ActionHistory_model = require("../../model/ActionHistory_model.js");
const Workout_model = require("../../model/Workout_model.js");

// Os modelos só precisam de `app` para os módulos que penduram nele; nada aqui
// toca o banco.
const app = { crypto, moment: require("moment"), validator: require("validator") };
const users = new User_model(app);
const history = new ActionHistory_model(app);
const workouts = new Workout_model(app);

test("filter nunca deixa hash nem salt saírem do backend", () => {
  const doc = { _id: "1", name: "Ana", email: "a@b.c", password: "hash", salt: "sal" };
  const out = users.filter(doc);

  assert.equal(out.password, undefined);
  assert.equal(out.salt, undefined);
  assert.equal(out.name, "Ana");
});

test("filter traduz a existência de senha em hasAccess", () => {
  // É o que a tela precisa saber (a pessoa consegue entrar?) sem ver o hash.
  assert.equal(users.filter({ password: "x", salt: "y" }).hasAccess, true);
  assert.equal(users.filter({ name: "só ficha" }).hasAccess, false);
  assert.equal(users.filter({ password: "" }).hasAccess, false);
});

test("filter passa reto por documento ausente", () => {
  assert.equal(users.filter(undefined), undefined);
  assert.equal(users.filter(null), null);
});

test("o salt é diferente a cada chamada e tem 32 hex", () => {
  const a = users.generateSalt();
  const b = users.generateSalt();

  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("a mesma senha com salts diferentes gera hashes diferentes", () => {
  // É exatamente para isso que o salt existe: duas contas com a senha "123456"
  // não podem ter o mesmo hash guardado.
  const h1 = users.hashPassword("123456", users.generateSalt());
  const h2 = users.hashPassword("123456", users.generateSalt());
  assert.notEqual(h1, h2);
});

test("a mesma senha com o mesmo salt é estável — é como o login confere", () => {
  const salt = users.generateSalt();
  assert.equal(users.hashPassword("123456", salt), users.hashPassword("123456", salt));
});

test("senha errada com o salt certo não bate", () => {
  const salt = users.generateSalt();
  assert.notEqual(users.hashPassword("123456", salt), users.hashPassword("123457", salt));
});

test("o separador impede colisão entre salt e senha", () => {
  // Sem o ":" entre os dois, ("ab","c") e ("a","bc") virariam o mesmo hash.
  assert.notEqual(users.hashPassword("c", "ab"), users.hashPassword("bc", "a"));
});

test("diff nunca registra senha nem salt no histórico", () => {
  const antes = { name: "Ana", password: "hash-velho", salt: "sal-velho" };
  const depois = { name: "Ana Paula", password: "hash-novo", salt: "sal-novo" };
  const d = history.diff(antes, depois);

  assert.deepEqual(Object.keys(d), ["name"]);
  assert.equal(d.name.from, "Ana");
  assert.equal(d.name.to, "Ana Paula");
});

test("diff ignora carimbos de tempo e o _id", () => {
  const d = history.diff(
    { _id: 1, name: "Ana", createdAt: new Date(0), updatedAt: new Date(0) },
    { _id: 1, name: "Ana", createdAt: new Date(0), updatedAt: new Date(1) }
  );
  assert.deepEqual(d, {});
});

test("diff enxerga campo que apareceu e campo que sumiu", () => {
  const d = history.diff({ name: "Ana" }, { name: "Ana", goal: "Hipertrofia" });
  assert.equal(d.goal.from, undefined);
  assert.equal(d.goal.to, "Hipertrofia");
});

test("diff devolve vazio quando falta um dos lados", () => {
  assert.deepEqual(history.diff(null, { a: 1 }), {});
  assert.deepEqual(history.diff({ a: 1 }, undefined), {});
});

test("statusOf: sem datas, o treino é atual", () => {
  assert.equal(workouts.statusOf({}), "current");
});

test("statusOf: compara por DIA, então o treino que acaba hoje ainda é atual", () => {
  const hoje = new Date().toISOString().slice(0, 10);
  assert.equal(workouts.statusOf({ endDate: hoje }), "current");
  assert.equal(workouts.statusOf({ startDate: hoje }), "current");
  assert.equal(workouts.statusOf({ startDate: hoje, endDate: hoje }), "current");
});

test("statusOf: terminado ontem é passado; começa amanhã é futuro", () => {
  const dia = (delta) => {
    const d = new Date();
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
  };

  assert.equal(workouts.statusOf({ endDate: dia(-1) }), "past");
  assert.equal(workouts.statusOf({ startDate: dia(1) }), "future");
  assert.equal(workouts.statusOf({ startDate: dia(-10), endDate: dia(10) }), "current");
});

test("statusOf: passado vence futuro quando as duas datas já ficaram para trás", () => {
  assert.equal(workouts.statusOf({ startDate: "2020-01-01", endDate: "2020-02-01" }), "past");
});
