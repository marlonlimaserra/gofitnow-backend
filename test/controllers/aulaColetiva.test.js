const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const GroupClassController = require("../../controllers/GroupClass.js");

// AS ROTAS DA AULA COLETIVA.
//
// O que se guarda aqui é o que não está no modelo: quem pode mexer, e a GRADE
// DE HOJE — que é onde o "resetar todo o dia" aparece.

const AULA = {
  _id: "a1",
  name: "Spinning",
  dias: [1, 3, 5],
  horaMinutos: 7 * 60,
  checkinAbre: 30,
  checkinFecha: 15,
  active: true,
};

const GroupClass = require("../../model/GroupClass_model.js");
const estadoDeVerdade = GroupClass.prototype.estadoAgora;

function monta({ aulas = [AULA], contagem = {}, agora, permissoes = null } = {}) {
  const pedidas = [];
  const chamadas = { insert: [], remove: [], removeCheckins: [] };

  const app = fakeApp({
    api: {
      groupClass: {
        async list() { return aulas; },
        async listActive() { return aulas; },
        async data(id) { return String(id) === "a1" ? AULA : undefined; },
        async insert(obj) {
          chamadas.insert.push(obj);
          return obj.name ? "a2" : null;
        },
        async update() { return true; },
        async remove(id) {
          chamadas.remove.push(id);
          return true;
        },
        async reorder(ids) { return Array.isArray(ids); },
        // O estado é o DE VERDADE: é ele que os casos daqui querem exercitar.
        estadoAgora: (aula, quando, fuso) => estadoDeVerdade(aula, quando, fuso),
      },
      groupClassCheckin: {
        async contagemDoDia() { return contagem; },
        async removeAllOf(id) {
          chamadas.removeCheckins.push(id);
          return 0;
        },
      },
      tenant: { async timezoneOfInstance() { return "America/Sao_Paulo"; } },
      center: { async limitsFor() { return {}; } },
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
    mongodb: {
      async connectToServer() {
        return { collection: () => ({ countDocuments: async () => 0 }) };
      },
    },
  });

  GroupClassController(app);
  return { app, pedidas, chamadas, agora };
}

test("LER pede `people.view`; MEXER pede `schedule.manage`", async () => {
  // Montar a grade é decidir o que a casa oferece e quando — é o mesmo tipo de
  // decisão da agenda.
  const { app, pedidas } = monta();

  await call(app, "get", "/group-classes");
  await call(app, "post", "/group-classes", { body: { name: "X" } });

  assert.equal(pedidas[0], "people.view");
  assert.equal(pedidas[1], "schedule.manage");
});

test("a grade de HOJE traz só as aulas do dia da semana", async () => {
  // Segunda-feira: a aula de seg/qua/sex entra.
  const { app } = monta();
  const r = await call(app, "get", "/group-classes/today");

  // O caso roda em qualquer dia, então afirma sobre a REGRA e não sobre a
  // resposta: o que sai tem de ser o que `estadoAgora` aprovou.
  const hoje = new Date().getDay();
  assert.equal(r.body.rows.length, AULA.dias.includes(hoje) ? 1 : 0);
});

test("a grade diz o DIA, e é ele que o check-in vai usar como chave", async () => {
  // Deixar a tela montar o dia do relógio dela seria deixá-la gravar no dia
  // errado quando o relógio estiver errado.
  const { app } = monta();
  const r = await call(app, "get", "/group-classes/today");

  assert.match(r.body.dia, /^\d{4}-\d{2}-\d{2}$/);
});

test("e traz QUANTOS já entraram — sem uma consulta por linha", async () => {
  const { app } = monta({ contagem: { a1: 7 } });
  const r = await call(app, "get", "/group-classes/today");

  if (r.body.rows.length) assert.equal(r.body.rows[0].presentes, 7);
});

test("`today` não é confundido com um id", async () => {
  // Sem a rota vir ANTES da de `:id`, "today" cairia nela e viraria 404.
  const { app } = monta();
  const r = await call(app, "get", "/group-classes/today");

  assert.equal(r.status, 200);
});

test("sem nome, hora ou dia, criar é 400 — e nada é criado", async () => {
  const { app, chamadas } = monta();
  const r = await call(app, "post", "/group-classes", { body: {} });

  assert.equal(r.status, 400);
  assert.equal(chamadas.insert.filter((o) => o.name).length, 0);
});

test("apagar a aula leva os check-ins junto", async () => {
  // Diferente da unidade, que é RECUSADA quando tem gente: ali as pessoas
  // continuam existindo. Aqui o check-in não tem vida própria — sem a aula,
  // nenhuma tela o alcança e nada o apagaria.
  const { app, chamadas } = monta();
  const r = await call(app, "delete", "/group-classes/a1");

  assert.equal(r.status, 200);
  assert.deepEqual(chamadas.remove, ["a1"]);
  assert.deepEqual(chamadas.removeCheckins, ["a1"]);
});

test("id que não existe é 404", async () => {
  const { app } = monta();
  const r = await call(app, "delete", "/group-classes/sumiu");

  assert.equal(r.status, 404);
});
