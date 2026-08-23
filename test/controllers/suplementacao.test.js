const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const SupplementController = require("../../controllers/Supplement.js");
const Supplement_model = require("../../model/Supplement_model.js");

// A SUPLEMENTAÇÃO de uma pessoa.
//
// Três coisas valem o arquivo, e nenhuma é o CRUD:
//
//   • ver e INDICAR são permissões diferentes. Numa clínica, quem lê o que a
//     pessoa toma não é necessariamente quem decide o que ela vai tomar.
//   • a lista sai na ordem do DIA, não do cadastro. Quem toma cinco coisas lê
//     "ao acordar / pré-treino / antes de dormir", e uma lista por data de
//     inclusão obrigaria a procurar.
//   • o selo da aba conta o que vale HOJE. Creatina encerrada em março não é
//     "o que esta pessoa toma".
const PESSOA = "64b2c0f7e1a2b3c4d5e6f701";
const PROF = "64b2c0f7e1a2b3c4d5e6f7a8";

function monta({ permissao = "supplements.manage", pessoaExiste = true } = {}) {
  const feito = { inseridos: [], atualizados: [], apagados: [] };

  const app = fakeApp({
    api: {
      user: {
        async dataStudent() {
          return pessoaExiste ? { _id: PESSOA, name: "Marlon" } : undefined;
        },
      },
      supplement: {
        MOMENTOS: ["wake", "preWorkout", "any"],
        UNIDADES: ["g", "scoop"],
        async list() {
          return [
            { _id: "1", name: "Creatina", moment: "wake", status: "current" },
            { _id: "2", name: "Whey", moment: "preWorkout", status: "current" },
            { _id: "3", name: "Termogênico", moment: "any", status: "past" },
          ];
        },
        async insert(_t, _s, obj) {
          feito.inseridos.push(obj);
          return "novo-id";
        },
        async update(_t, id, obj) {
          feito.atualizados.push({ id, obj });
          return id !== "fantasma";
        },
        async delete(_t, id) {
          feito.apagados.push(id);
          return true;
        },
        async data(_t, id) {
          return id === "fantasma" ? undefined : { _id: id, name: "Creatina", moment: "wake" };
        },
      },
      actionHistory: { diff: () => ({}) },
    },
    helpers: {
      ReqProtected: {
        async can(req, res, pedida) {
          if (pedida !== permissao && permissao !== "todas") {
            res.status(403).send({ msg: "sem permissão" });
            return false;
          }
          return { _id: PROF, name: "Bruna" };
        },
      },
    },
  });

  SupplementController(app);
  return { app, feito };
}

test("a lista devolve as contagens e as listas fechadas que a tela precisa", async () => {
  const { app } = monta({ permissao: "todas" });

  const r = await call(app, "get", `/people/${PESSOA}/supplements`, {
    params: { personId: PESSOA },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 3);
  // O selo da aba usa `current`: dois valem hoje, um já encerrou.
  assert.equal(r.body.counts.current, 2);
  assert.equal(r.body.counts.past, 1);
  assert.equal(r.body.counts.all, 3);
  // Momentos e unidades vêm do SERVIDOR: acrescentar uma unidade passa a ser
  // mexer num lugar só, e a tela com cache não oferece o que o servidor recusa.
  assert.deepEqual(r.body.moments, ["wake", "preWorkout", "any"]);
  assert.deepEqual(r.body.units, ["g", "scoop"]);
});

test("indicar exige `supplements.manage`, não só ver", async () => {
  const { app, feito } = monta({ permissao: "supplements.view" });

  const r = await call(app, "post", `/people/${PESSOA}/supplements`, {
    params: { personId: PESSOA },
    body: { name: "Creatina" },
  });

  assert.equal(r.status, 403);
  assert.deepEqual(feito.inseridos, [], "gravou sem permissão");
});

test("suplemento sem nome é 400 e não grava nada", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/supplements`, {
    params: { personId: PESSOA },
    body: { name: " ", dose: 5 },
  });

  assert.equal(r.status, 400);
  assert.deepEqual(feito.inseridos, []);
});

test("fim antes do começo é recusado", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/supplements`, {
    params: { personId: PESSOA },
    body: { name: "Creatina", startDate: "2026-08-20", endDate: "2026-08-01" },
  });

  assert.equal(r.status, 400);
  assert.deepEqual(feito.inseridos, []);
});

test("pessoa de outro profissional é 404 — e não 403", async () => {
  // De fora não se distingue "não existe" de "é de outro". As duas respostas
  // têm de ser a mesma, senão a diferença conta quem existe.
  const { app } = monta({ pessoaExiste: false });

  const r = await call(app, "post", `/people/${PESSOA}/supplements`, {
    params: { personId: PESSOA },
    body: { name: "Creatina" },
  });

  assert.equal(r.status, 404);
});

test("indicar registra no histórico com a pessoa dentro", async () => {
  // Sem `person` no registro, o log diria "indicou Creatina" sem dizer para
  // quem — e é justamente isso que se procura quando se abre o histórico.
  const { app } = monta();

  await call(app, "post", `/people/${PESSOA}/supplements`, {
    params: { personId: PESSOA },
    body: { name: "Creatina", dose: 5, unit: "g", moment: "wake" },
  });

  const registro = app.registrados.find((r) => r.action === "create_supplement");
  assert.ok(registro, "não registrou");
  assert.equal(registro.data.extra.person, "Marlon");
  assert.equal(registro.data.category, "supplements");
});

test("apagar o que não existe é 404, e não um 200 calado", async () => {
  const { app, feito } = monta();

  const r = await call(app, "delete", "/supplements/fantasma", { params: { id: "fantasma" } });

  assert.equal(r.status, 404);
  assert.deepEqual(feito.apagados, []);
});

// ── O MODELO ────────────────────────────────────────────────────────────────
//
// A ordem e o "vale hoje" são regra de modelo, e é onde dá para provar sem
// banco: as duas são funções puras sobre o documento.
function modelo(docs) {
  const app = {
    mongodb: {
      async connectToServer() {
        return {
          collection() {
            return {
              find() {
                return { toArray: async () => docs };
              },
            };
          },
        };
      },
    },
  };
  return new Supplement_model(app);
}

test("a lista sai na ordem do DIA, não na do cadastro", async () => {
  const m = modelo([
    { name: "Melatonina", moment: "beforeSleep" },
    { name: "Whey", moment: "postWorkout" },
    { name: "Creatina", moment: "wake" },
    { name: "Cafeína", moment: "preWorkout" },
  ]);

  const lista = await m.list(PROF, PESSOA);

  assert.deepEqual(
    lista.map((s) => s.name),
    ["Creatina", "Cafeína", "Whey", "Melatonina"]
  );
});

test("dentro do mesmo momento, ordena pelo nome", async () => {
  const m = modelo([
    { name: "Ômega 3", moment: "withMeal" },
    { name: "Creatina", moment: "withMeal" },
  ]);

  const lista = await m.list(PROF, PESSOA);
  assert.deepEqual(
    lista.map((s) => s.name),
    ["Creatina", "Ômega 3"]
  );
});

test("momento desconhecido não quebra a ordem — cai em `any`", async () => {
  // Documento gravado por uma versão futura, ou por um cliente com defeito.
  // Sumir da lista seria pior: o profissional indicou e a pessoa não vê.
  const m = modelo([{ name: "Coisa nova", moment: "sei-la" }]);
  const lista = await m.list(PROF, PESSOA);
  assert.equal(lista.length, 1);
});

test("o status é do documento, não do que a tela mandar", async () => {
  const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const m = modelo([]);

  assert.equal(m.statusOf({ endDate: ontem }), "past");
  assert.equal(m.statusOf({ startDate: amanha }), "future");
  assert.equal(m.statusOf({}), "current");
  assert.equal(m.statusOf({ startDate: ontem, endDate: amanha }), "current");
});
