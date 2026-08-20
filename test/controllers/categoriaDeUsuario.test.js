const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const UserCategoryController = require("../../controllers/UserCategory.js");

// O QUE CADA PESSOA É, pelo lado das rotas.
//
// Duas regras valem o arquivo: a lista é FILTRADA pelo tipo (um aluno não escolhe
// "endocrinologista"), e quem grava a categoria de outra pessoa usa o tipo DELA.
const CATALOGO = {
  student: [{ key: "aluno", name: "Aluno", tipo: "atendido" }],
  trainer: [
    { key: "personal-trainer", name: "Personal trainer", tipo: "profissional" },
    { key: "academia", name: "Academia", tipo: "negocio" },
  ],
};

function monta({ user = { _id: "u1", type: "trainer" }, alvo, permite = true } = {}) {
  const gravadas = [];

  const app = fakeApp({
    api: {
      userCategory: {
        async paraTipo(tipo) {
          return CATALOGO[tipo === "student" ? "student" : "trainer"];
        },
        async gravar(userId, key, tipo) {
          const permitidas = CATALOGO[tipo === "student" ? "student" : "trainer"];
          if (key && !permitidas.some((c) => c.key === key)) return { erro: "invalid_category" };
          gravadas.push({ userId: String(userId), key, tipo });
          return { ok: true, category: key || "" };
        },
      },
      user: {
        async data() {
          return alvo;
        },
      },
    },
    helpers: {
      ReqProtected: {
        async verify(req, res) {
          if (permite) return user;
          res.status(401).send({ msg: "sem sessão" });
          return false;
        },
        async can(req, res, permissao) {
          if (permite) return { ...user, permissao };
          res.status(403).send({ msg: "forbidden" });
          return false;
        },
      },
    },
  });

  app.insertUserActionHistory = () => {};
  UserCategoryController(app);
  return { app, gravadas };
}

test("a lista vem filtrada pelo tipo de quem pediu", async () => {
  const { app } = monta({ user: { _id: "u1", type: "trainer" } });
  const r = await call(app, "get", "/user-categories", { headers: {} });

  const chaves = r.body.map((c) => c.key);
  assert.ok(chaves.includes("personal-trainer"));
  assert.ok(!chaves.includes("aluno"), "ofereceu 'Aluno' a um profissional");
});

test("o profissional pode pedir a lista DO ALUNO que está cadastrando", async () => {
  // Sem o parâmetro, o formulário de cadastrar aluno ofereceria "Nutricionista" e
  // "Academia" — e o erro contamina a estatística que o site exibe.
  const { app } = monta({ user: { _id: "u1", type: "trainer" } });
  const r = await call(app, "get", "/user-categories", { query: { tipo: "student" } });

  assert.deepEqual(r.body.map((c) => c.key), ["aluno"]);
});

test("a pessoa grava a própria categoria sem permissão nenhuma", async () => {
  // É resposta sobre si mesma. Exigir `users.manage` deixaria o aluno sem poder
  // dizer o que ele é.
  const { app, gravadas } = monta({ user: { _id: "u9", type: "student" } });
  const r = await call(app, "put", "/me/category", {
    body: { category: "aluno" },
    headers: {},
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.category, "aluno");
  assert.deepEqual(gravadas, [{ userId: "u9", key: "aluno", tipo: "student" }]);
});

test("categoria fora da lista é 400 com o código, não um 500", async () => {
  // A lista veio do servidor, então chave inválida é formulário desatualizado ou
  // chamada à mão — e a tela precisa saber que foi a CHAVE.
  const { app } = monta({ user: { _id: "u9", type: "student" } });
  const r = await call(app, "put", "/me/category", { body: { category: "academia" } });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_category");
});

test("vazio APAGA a categoria, e não é erro", async () => {
  // Quem não quis dizer o que é tem direito de não dizer.
  const { app, gravadas } = monta({ user: { _id: "u9", type: "student" } });
  const r = await call(app, "put", "/me/category", { body: { category: "" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.category, "");
  assert.equal(gravadas[0].key, "");
});

test("gravar pelo aluno usa o tipo DO ALUNO, não o de quem grava", async () => {
  // Este é o caso mais comum: o aluno não entra na configuração, então o
  // profissional responde por ele. Usando o tipo de quem grava, "Aluno" — que não
  // está na lista do profissional — seria recusado.
  const { app, gravadas } = monta({
    user: { _id: "u1", type: "trainer" },
    alvo: { _id: "u9", type: "student" },
  });

  const r = await call(app, "put", "/users/u9/category", { body: { category: "aluno" } });

  assert.equal(r.status, 200);
  assert.deepEqual(gravadas, [{ userId: "u9", key: "aluno", tipo: "student" }]);
});

test("gravar pelo outro exige users.manage", async () => {
  const pedidas = [];
  const { app } = monta({ alvo: { _id: "u9", type: "student" } });
  app.helpers.ReqProtected.can = async (req, res, permissao) => {
    pedidas.push(permissao);
    return { _id: "u1", type: "trainer" };
  };

  await call(app, "put", "/users/u9/category", { body: { category: "aluno" } });
  assert.deepEqual(pedidas, ["users.manage"]);
});

test("pessoa que não existe é 404 antes de qualquer gravação", async () => {
  const { app, gravadas } = monta({ alvo: undefined });
  const r = await call(app, "put", "/users/fantasma/category", { body: { category: "aluno" } });

  assert.equal(r.status, 404);
  assert.equal(gravadas.length, 0);
});

test("sem sessão, nada é lido nem gravado", async () => {
  const { app, gravadas } = monta({ permite: false });

  assert.equal((await call(app, "get", "/user-categories")).status, 401);
  assert.equal((await call(app, "put", "/me/category", { body: { category: "aluno" } })).status, 401);
  assert.equal((await call(app, "put", "/users/u9/category", { body: {} })).status, 403);
  assert.equal(gravadas.length, 0);
});
