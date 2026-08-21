const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const TabCountsController = require("../../controllers/TabCounts.js");

// O NUMEROZINHO de cada aba da ficha.
//
// Duas coisas valem o arquivo. A primeira é o que cada número CONTA: o selo serve
// para dizer "tem coisa aqui agora", então treino que acabou e cobrança já paga não
// entram — senão o número vira decoração e ninguém olha mais.
//
// A segunda é a PERMISSÃO por aba: sem ela, quem não pode ver o financeiro descobre
// "esta pessoa tem 3 cobranças em aberto" por um selo numa aba que não abre.
const HOJE = new Date().toISOString().slice(0, 10);

// Ids de verdade são ObjectId: 24 caracteres hex. Um "aluno1" aqui faria o teste
// passar com um id que o Mongo recusaria — e o defeito só apareceria em produção.
const ALUNO = "64b2c0f7e1a2b3c4d5e6f701";
const PROF = "64b2c0f7e1a2b3c4d5e6f7a8";
const OUTRO_PROF = "64b2c0f7e1a2b3c4d5e6f7a9";

function monta({ permissoes = [], aluno = { _id: ALUNO }, docs = {} } = {}) {
  // As consultas que chegaram ao banco, por collection. É sobre elas que o teste
  // afirma: o que se conta é o filtro, não o número que um dublê devolveria.
  const consultas = {};

  const app = fakeApp({
    mongodb: {
      async connectToServer() {
        return {
          collection(nome) {
            return {
              async countDocuments(query) {
                consultas[nome] = query;
                return docs[nome] ?? 0;
              },
            };
          },
        };
      },
    },
    api: {
      user: {
        async dataStudent(trainerId, id) {
          return id === "fantasma" ? undefined : aluno;
        },
        async hasPermission(user, permissao) {
          return permissoes.includes(permissao);
        },
        async professionalIds() {
          return [PROF, OUTRO_PROF];
        },
      },
    },
    helpers: {
      ReqProtected: {
        async verify() {
          return { _id: PROF, type: "trainer" };
        },
      },
    },
  });

  TabCountsController(app);
  return { app, consultas };
}

const TODAS = [
  "workouts.view",
  "diets.view",
  "finance.view",
  "schedule.view",
  "assessments.view",
];

const pedir = (app) =>
  call(app, "get", `/people/${ALUNO}/tab-counts`, { params: { personId: ALUNO } });

test("devolve um número por aba", async () => {
  const { app } = monta({
    permissoes: TODAS,
    docs: { workouts: 2, diets: 1, charges: 3, appointments: 4, assessments: 7 },
  });

  const r = await pedir(app);

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { workouts: 2, diet: 1, finance: 3, schedule: 4, assessment: 7 });
});

test("treino e dieta contam só os VIGENTES", async () => {
  // Uma pessoa com trinta treinos antigos e nenhum vigente mostraria "30" para
  // sempre, e o selo deixaria de significar qualquer coisa.
  const { app, consultas } = monta({ permissoes: TODAS });
  await pedir(app);

  for (const collection of ["workouts", "diets"]) {
    const q = consultas[collection];
    assert.ok(q.$and, `${collection} não filtrou por vigência`);

    // Começou (ou não tem começo) e não terminou (ou não tem fim) — o mesmo
    // `statusOf === "current"` dos modelos, escrito como filtro.
    const [comeco, fim] = q.$and;
    assert.equal(comeco.$or[0].startDate.$lte, HOJE);
    assert.equal(fim.$or[0].endDate.$gte, HOJE);
  }
});

test("financeiro conta só cobrança EM ABERTO — inclusive a sem status", async () => {
  // `insertCharge` grava `status: "open"` por omissão, mas cobrança antiga pode não
  // ter o campo. Contá-la como paga esconderia dinheiro a receber.
  const { app, consultas } = monta({ permissoes: TODAS });
  await pedir(app);

  const estados = consultas.charges.$or.map((c) => c.status);
  assert.ok(estados.includes("open"));
  assert.ok(estados.includes(null));
  assert.ok(consultas.charges.$or.some((c) => c.status && c.status.$exists === false));
  // E nunca as pagas.
  assert.ok(!estados.includes("paid"));
});

test("agenda conta só o que ainda vai acontecer, e não o cancelado", async () => {
  const { app, consultas } = monta({ permissoes: TODAS });
  await pedir(app);

  const q = consultas.appointments;
  assert.ok(q.date.$gte instanceof Date, "não recortou pelo futuro");
  assert.deepEqual(q.status, { $ne: "canceled" });
});

test("avaliação conta TODAS — aqui o histórico é o conteúdo", async () => {
  // Uma medida de março não "vence": ela é o registro. Recortar por data aqui
  // esconderia justamente o que a aba serve para mostrar.
  const { app, consultas } = monta({ permissoes: TODAS });
  await pedir(app);

  const q = consultas.assessments;
  assert.equal(q.date, undefined);
  assert.equal(q.$and, undefined);
  assert.ok(q.trainer && q.student);
});

test("a agenda respeita o alcance da EQUIPE", async () => {
  // Com `schedule.team`, a aba lista a agenda da equipe inteira — e o selo tem de
  // contar o mesmo, senão ele anuncia menos do que a tela mostra.
  const { app, consultas } = monta({ permissoes: [...TODAS, "schedule.team"] });
  await pedir(app);

  assert.equal(consultas.appointments.trainer.$in.length, 2);
});

test("sem a equipe, a agenda conta só a própria", async () => {
  const { app, consultas } = monta({ permissoes: TODAS });
  await pedir(app);

  assert.equal(consultas.appointments.trainer.$in.length, 1);
});

test("aba que a conta não alcança NÃO é contada — nem consultada", async () => {
  // O selo do financeiro contaria "3 cobranças em aberto" numa aba que a pessoa não
  // consegue abrir. Não é só economia de consulta: é vazamento.
  const { app, consultas } = monta({
    permissoes: ["workouts.view"],
    docs: { workouts: 2, charges: 9, assessments: 9 },
  });

  const r = await pedir(app);

  assert.equal(r.body.workouts, 2);
  assert.equal(r.body.finance, 0);
  assert.equal(r.body.assessment, 0);
  assert.equal(consultas.charges, undefined, "consultou o financeiro sem permissão");
  assert.equal(consultas.assessments, undefined);
});

test("todos os filtros são pela pessoa da URL", async () => {
  // Um filtro que esquecesse o aluno contaria a base inteira — e o selo diria "12"
  // em toda ficha.
  const { app, consultas } = monta({ permissoes: TODAS });
  await pedir(app);

  for (const [collection, q] of Object.entries(consultas)) {
    assert.ok(q.student, `${collection} não filtrou pelo aluno`);
  }
});

test("pessoa de outro profissional é 404, e nada é contado", async () => {
  const { app, consultas } = monta({ permissoes: TODAS });

  const r = await call(app, "get", "/people/fantasma/tab-counts", {
    params: { personId: "fantasma" },
  });

  assert.equal(r.status, 404);
  assert.deepEqual(consultas, {});
});

test("sem nenhuma permissão, todos os números são zero", async () => {
  const { app } = monta({ permissoes: [] });
  const r = await pedir(app);

  assert.deepEqual(r.body, { workouts: 0, diet: 0, finance: 0, schedule: 0, assessment: 0 });
});
