const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const AdminUserController = require("../../controllers/AdminUser.js");

// A CATEGORIA nas rotas de admin (/users). O resto do controller — papéis, o
// último admin, virar pessoa — tem as regras exercitadas pelas telas; aqui o
// que se guarda é o mesmo contrato do /people: validar ANTES de criar, gravar
// pelo UserCategory, e usar o tipo que a conta VAI TER depois do save.
const ADMIN = { _id: "adm1", name: "Marlon", type: "trainer", admin: true };

function monta({ alvo } = {}) {
  const chamadas = { insertTrainer: [], updateAny: [], categoria: [] };
  const permissao = permiteTudo(ADMIN);

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      user: {
        async dataByEmail() {
          return null;
        },
        async data(id) {
          return alvo && String(id) !== "novo1" ? alvo : { _id: id, name: "Novo", email: "n@x.com" };
        },
        async insertTrainer(obj) {
          chamadas.insertTrainer.push(obj);
          return "novo1";
        },
        async updateAny(id, obj) {
          chamadas.updateAny.push(obj);
          return true;
        },
        async hasPermission() {
          return false;
        },
        async withRole(u) {
          return u;
        },
      },
      role: {
        defaultName: "Profissional",
        async data() {
          return { _id: "r1", name: "Profissional" };
        },
        async dataByName() {
          return { _id: "r1", name: "Profissional" };
        },
        async grants() {
          return true;
        },
        async countActiveUsersWith() {
          return 1;
        },
      },
      link: {
        async countPeopleOf() {
          return 0;
        },
      },
      auth: {
        async deleteAllTokensByUser() {},
      },
      actionHistory: { diff: () => ({}) },
      // Aceita "personal" na lista de profissional e "aluno" na de pessoa: o
      // suficiente para conferir que a rota manda o TIPO certo junto.
      userCategory: {
        async valida(key, tipo) {
          const chave = String(key || "").trim();
          if (!chave) return true;
          return tipo === "student" ? chave === "aluno" : chave === "personal";
        },
        async gravar(userId, key, tipo) {
          chamadas.categoria.push({ userId: String(userId), key, tipo });
          return { ok: true, category: key || "" };
        },
      },
    },
  });

  AdminUserController(app);
  return { app, chamadas };
}

const NOVO = { name: "Novo", email: "n@x.com", password: "segredo123" };

test("criar usuário com categoria grava — com o tipo trainer, que é o que a rota cria", async () => {
  const { app, chamadas } = monta();
  const r = await call(app, "post", "/users", { body: { ...NOVO, category: "personal" } });

  assert.equal(r.status, 201);
  assert.deepEqual(chamadas.categoria, [{ userId: "novo1", key: "personal", tipo: "trainer" }]);
});

test("categoria fora do catálogo recusa ANTES de criar a conta", async () => {
  const { app, chamadas } = monta();
  const r = await call(app, "post", "/users", { body: { ...NOVO, category: "aluno" } });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_category");
  assert.equal(chamadas.insertTrainer.length, 0);
});

test("editar valida contra o tipo que a conta VAI TER — quem vira pessoa escolhe da lista de pessoa", async () => {
  const alvo = { _id: "u2", name: "Bia", email: "b@x.com", type: "trainer", active: 1 };
  const { app, chamadas } = monta({ alvo });

  const r = await call(app, "put", "/users/u2", {
    body: { type: "student", category: "aluno" },
    params: { id: "u2" },
  });

  assert.equal(r.status, 200);
  assert.deepEqual(chamadas.categoria, [{ userId: "u2", key: "aluno", tipo: "student" }]);
});

test("na edição, categoria inválida recusa sem salvar o resto", async () => {
  const alvo = { _id: "u2", name: "Bia", email: "b@x.com", type: "trainer", active: 1 };
  const { app, chamadas } = monta({ alvo });

  const r = await call(app, "put", "/users/u2", {
    body: { name: "Bia", category: "aluno" }, // "aluno" não está na lista de profissional
    params: { id: "u2" },
  });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_category");
  assert.equal(chamadas.updateAny.length, 0);
});
