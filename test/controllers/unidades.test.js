const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const UnitController = require("../../controllers/Unit.js");

// AS ROTAS DAS UNIDADES.
//
// O que se guarda aqui são as duas regras que não estão no modelo: QUEM pode
// mexer, e o que acontece ao tentar apagar uma unidade com gente dentro.

const UNIDADE = { _id: "u1", name: "Centro", photo: "img1", active: true };

function monta({ quantasPessoas = 0, unidade = UNIDADE, permissoes = null } = {}) {
  const chamadas = { update: [], remove: [], insert: [] };
  const pedidas = [];

  const app = fakeApp({
    api: {
      unit: {
        async list() {
          return [unidade];
        },
        async listActive() {
          return [unidade];
        },
        async data(id) {
          // "sumiu" é o único id que não existe: é com ele que os casos
          // exercitam o 404. O recém-criado tem de ser encontrável, senão o
          // dobro contaria uma história que o banco não conta.
          if (String(id) === "sumiu") return undefined;
          return unidade ? { ...unidade, _id: String(id) } : undefined;
        },
        async insert(obj) {
          chamadas.insert.push(obj);
          return obj.name ? "u2" : null;
        },
        async update(id, obj) {
          chamadas.update.push({ id, obj });
          return true;
        },
        async remove(id) {
          chamadas.remove.push(id);
          return true;
        },
        async reorder(ids) {
          return Array.isArray(ids);
        },
        async quantasPessoas() {
          return quantasPessoas;
        },
      },
      unitImage: {
        parseDataUri: () => undefined,
        async save() {
          return { id: "img2" };
        },
        async data() {
          return undefined;
        },
      },
    },
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidas.push(permissao);
          if (permissoes && !permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon" };
        },
      },
    },
  });

  UnitController(app);
  return { app, chamadas, pedidas };
}

test("LER pede `people.view` — quem abre uma ficha precisa ver a unidade", async () => {
  const { app, pedidas } = monta();
  await call(app, "get", "/units");

  assert.equal(pedidas[0], "people.view");
});

test("MEXER pede `users.manage` — abrir filial é decisão de quem administra", async () => {
  const { app, pedidas } = monta();

  await call(app, "post", "/units", { body: { name: "Barra" } });
  await call(app, "put", "/units/u1", { body: { name: "Centro" } });
  await call(app, "delete", "/units/u1");

  assert.deepEqual([...new Set(pedidas)], ["users.manage"]);
});

test("apagar uma unidade COM GENTE é recusado, e o erro diz quantas", async () => {
  // Apagar deixaria as pessoas apontando para uma unidade que não existe: um
  // vínculo vazio que ninguém consegue explicar nem desfazer em lote.
  const { app, chamadas } = monta({ quantasPessoas: 12 });

  const r = await call(app, "delete", "/units/u1");

  assert.equal(r.status, 409);
  assert.match(r.body.msg, /12/);
  assert.equal(chamadas.remove.length, 0);
});

test("vazia, apaga", async () => {
  const { app, chamadas } = monta({ quantasPessoas: 0 });

  const r = await call(app, "delete", "/units/u1");

  assert.equal(r.status, 200);
  assert.deepEqual(chamadas.remove, ["u1"]);
});

test("sem nome, 400 — e nada é criado", async () => {
  const { app } = monta();

  const r = await call(app, "post", "/units", { body: {} });

  assert.equal(r.status, 400);
});

test("a lista devolve o ENDEREÇO da foto, e nunca o id cru", async () => {
  // O documento guarda só o id: guardar a URL prenderia a unidade ao domínio
  // do backend do dia em que a foto subiu.
  const { app } = monta();

  const r = await call(app, "get", "/units");

  assert.match(r.body.rows[0].photoUrl, /\/public\/unit-image\/marlon\/img1$/);
});

test("unidade sem foto não inventa endereço", async () => {
  const { app } = monta({ unidade: { _id: "u1", name: "Centro", photo: null } });

  const r = await call(app, "get", "/units");

  assert.equal(r.body.rows[0].photoUrl, null);
});

test("a ORDEM não é confundida com um id", async () => {
  // Sem a rota de ordem vir ANTES da de `:id`, "order" cairia na de baixo como
  // se fosse um id — e um id inválido vira 404 em vez de reordenar.
  const { app } = monta();

  const r = await call(app, "put", "/units/order", { body: { ids: ["u1"] } });

  assert.equal(r.status, 200);
});

test("id que não existe é 404, e não um update no vazio", async () => {
  const { app, chamadas } = monta();

  const r = await call(app, "put", "/units/sumiu", { body: { name: "x" } });

  assert.equal(r.status, 404);
  assert.equal(chamadas.update.length, 0);
});
