const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const MyController = require("../../controllers/My.js");

// A ÁREA DA PESSOA (/my/*): as rotas que o ALUNO usa.
//
// O que estes casos guardam não é o formato das respostas — é a AUTORIZAÇÃO,
// que aqui é diferente de todo o resto do sistema:
//
//   • a identidade É o filtro: `student = eu`, cravado no servidor. Não existe
//     :personId em rota nenhuma — um id na URL seria um convite para trocá-lo.
//   • profissional NÃO entra: para ele existe a ficha. Uma lista vazia com cara
//     de defeito seria a resposta errada.
//   • treino de OUTRA pessoa devolve 404, não 403: de fora não se distingue
//     "não existe" de "não é seu".
const EU = { _id: "64b2c0f7e1a2b3c4d5e6f701", name: "Marlon", type: "student", sex: "female" };
const PROF = { _id: "64b2c0f7e1a2b3c4d5e6f7a8", name: "Bruna", type: "trainer" };

const TREINOS = [
  { _id: "w1", name: "A", status: "current", student: EU._id },
  { _id: "w2", name: "B", status: "past", student: EU._id },
];

function monta({ quem = EU, acompanhadoPor = 0 } = {}) {
  const pedidos = { workouts: [], exams: [] };

  const app = fakeApp({
    api: {
      // Quantos profissionais acompanham esta pessoa. É o que o portão passou a
      // perguntar no lugar de "que tipo de conta é esta?".
      link: {
        async countProfessionalsOf() {
          return acompanhadoPor;
        },
      },
      workout: {
        async listOfStudent(id) {
          pedidos.workouts.push(String(id));
          return TREINOS;
        },
        async dataOfStudent(studentId, id) {
          return id === "meu" ? { _id: "meu", name: "A", student: String(studentId) } : undefined;
        },
      },
      diet: { async listOfStudent() { return [{ _id: "d1", status: "current" }]; } },
      supplement: {
        MOMENTOS: ["wake", "any"],
        async listOfStudent() {
          return [
            { _id: "s1", name: "Creatina", moment: "wake", status: "current" },
            { _id: "s2", name: "Termogênico", moment: "any", status: "past" },
          ];
        },
      },
      exam: {
        async listOfStudent(id) {
          pedidos.exams.push(String(id));
          return [{ _id: "e1", collectedAt: "2026-08-01", markers: [] }];
        },
      },
      appointment: {
        async listAllOfStudent() {
          return [
            { _id: "a1", date: new Date(Date.now() + 86400000).toISOString(), trainer: PROF._id },
            { _id: "a2", date: new Date(Date.now() - 86400000).toISOString(), trainer: PROF._id },
            { _id: "a3", date: new Date(Date.now() + 172800000).toISOString(), trainer: PROF._id, status: "canceled" },
          ];
        },
      },
      user: { async data() { return { _id: PROF._id, name: "Bruna" }; } },
    },
    helpers: { ReqProtected: { verify: async () => quem } },
  });

  MyController(app);
  return { app, pedidos };
}

test("um profissional que NÃO é acompanhado por ninguém é barrado — a ficha é o lugar dele", async () => {
  const { app, pedidos } = monta({ quem: PROF, acompanhadoPor: 0 });

  const r = await call(app, "get", "/my/workouts");

  assert.equal(r.status, 403);
  assert.equal(pedidos.workouts.length, 0);
});

// O portão pergunta "alguém acompanha esta pessoa?", e não "que tipo de conta é
// esta?".
//
// O caso real que mudou a regra: o Marlon é profissional na conta dele e
// ATENDIDO na conta do Willian — com três dietas e uma avaliação montadas para
// ele que nenhuma tela alcançava. A home de profissional listava quem ELE
// acompanha (ninguém) e esta área estava fechada pelo tipo: um vão.
test("um profissional que É acompanhado entra — e vê o que é DELE", async () => {
  const { app, pedidos } = monta({ quem: PROF, acompanhadoPor: 1 });

  const r = await call(app, "get", "/my/workouts");

  assert.equal(r.status, 200);
  // O filtro continua sendo a identidade de quem perguntou: entrar aqui nunca
  // deu acesso ao dado de outra pessoa, e continua não dando.
  assert.deepEqual(pedidos.workouts, [String(PROF._id)]);
});

test("a lista de treinos é filtrada pela MINHA identidade, não por parâmetro", async () => {
  const { app, pedidos } = monta();

  const r = await call(app, "get", "/my/workouts");

  assert.equal(r.status, 200);
  assert.deepEqual(pedidos.workouts, [String(EU._id)]);
  assert.equal(r.body.counts.current, 1);
  assert.equal(r.body.counts.all, 2);
});

test("treino de OUTRA pessoa é 404 — indistinguível de não existir", async () => {
  const { app } = monta();

  const meu = await call(app, "get", "/my/workouts/meu", { params: { id: "meu" } });
  assert.equal(meu.status, 200);

  const alheio = await call(app, "get", "/my/workouts/deOutro", { params: { id: "deOutro" } });
  assert.equal(alheio.status, 404);
});

test("os exames vêm com o catálogo resolvido pelo MEU sexo", async () => {
  const { app } = monta(); // EU é female

  const r = await call(app, "get", "/my/exams");

  const hormonal = r.body.catalog.find((g) => g.key === "hormonal");
  const testo = hormonal.markers.find((m) => m.key === "testosteroneTotal");
  assert.equal(testo.low, 15);
  assert.equal(testo.high, 70);
});

test("a agenda reparte em 'o que vem' e 'o que já foi', sem os cancelados", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/my/appointments");

  assert.equal(r.body.upcoming.length, 1);
  assert.equal(r.body.past.length, 1);
  // Quem atende vem com nome — id sozinho não veste tela.
  assert.equal(r.body.upcoming[0].trainerName, "Bruna");
});

test("a minha suplementação vem só com o que vale HOJE", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/my/supplements");

  // O termogênico encerrado não é "o que eu tomo".
  assert.deepEqual(r.body.rows.map((s) => s.name), ["Creatina"]);
  assert.deepEqual(r.body.moments, ["wake", "any"]);
});

test("o resumo conta o que vale HOJE e aponta o próximo compromisso", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/my/overview");

  assert.equal(r.body.counts.workouts, 1); // só o current
  assert.equal(r.body.counts.exams, 1);
  assert.equal(r.body.nextAppointment._id, "a1"); // o cancelado de depois não ganha
});
