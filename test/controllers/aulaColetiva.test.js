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
  horarios: [{ inicio: 7 * 60, fim: 7 * 60 + 50 }],
  checkinAbre: 30,
  checkinFecha: 15,
  active: true,
};

const GroupClass = require("../../model/GroupClass_model.js");
const estadoDeVerdade = GroupClass.prototype.estadoAgora;

function monta({
  aulas = [AULA],
  contagem = {},
  agora,
  permissoes = null,
  extra = {},
  // Quem JÁ está no horário — é contra este número que a vaga é conferida.
  dentro = [],
  // A pessoa é da lista deste profissional? `false` exercita o id de outra conta.
  pessoaVinculada = true,
  // O que o modelo responde ao `entrar`. O caso do "já entrou hoje" passa outro.
  entrada = { ok: true, novo: true },
  apagou = true,
} = {}) {
  const pedidas = [];
  const chamadas = { insert: [], remove: [], removeCheckins: [], entrou: [], apagados: [] };

  const app = fakeApp({
    api: {
      groupClass: {
        async list() { return aulas; },
        async listActive() { return aulas; },
        async data(id) {
          // "sumiu" é o único id que não existe: é com ele que os casos
          // exercitam o 404. O recém-criado tem de ser encontrável, senão o
          // dobro contaria uma história que o banco não conta.
          return String(id) === "sumiu" ? undefined : { ...AULA, _id: String(id) };
        },
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
        async inscritos() { return dentro; },
        async entrar(aula, dia, pessoa, opcoes) {
          chamadas.entrou.push({ aula, dia, pessoa, ...opcoes });
          return entrada;
        },
        async remover(id) {
          chamadas.apagados.push(id);
          return apagou;
        },
        async removeAllOf(id) {
          chamadas.removeCheckins.push(id);
          return 0;
        },
      },
      // A pessoa, para conferir o VÍNCULO com quem está inscrevendo.
      user: {
        async dataStudent(_trainer, id) {
          return pessoaVinculada ? { _id: String(id), name: "Rafael" } : undefined;
        },
      },
      // A AULA DE UM DIA: o fechamento para inscrição, que é de hoje e não da
      // aula.
      groupClassSession: {
        async fechadasDoDia() { return new Set(); },
        async estaFechada() { return false; },
        async fechar() { return true; },
        async removeAllOf(id) {
          chamadas.removeSessoes = chamadas.removeSessoes || [];
          chamadas.removeSessoes.push(id);
          return 0;
        },
      },
      // A capa entrou em 18/09/2026: a aula virou cartão, como o aulão.
      groupClassImage: {
        parseDataUri: () => undefined,
        async save() { return { id: "img1" }; },
        async data() { return undefined; },
        async removeAllOf(id) {
          chamadas.removeCapas = chamadas.removeCapas || [];
          chamadas.removeCapas.push(id);
          return 0;
        },
      },
      tenant: { async timezoneOfInstance() { return "America/Sao_Paulo"; } },
      center: { async limitsFor() { return {}; } },
      ...extra,
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

// ── PRESENÇA, FALTA E FECHAR A AULA ─────────────────────────────────────
//
// *"'fechar' aula para ninguém mais se inscrever, e poder dar PRESENÇA"* —
// *"presença ou falta no caso"*.
test("marcar presença pede `schedule.manage`, e não só ver", async () => {
  // Dar presença é uma decisão sobre a aula, como montá-la — não é leitura.
  const { app, pedidas } = monta({ permissoes: ["people.view"] });

  const r = await call(app, "put", "/group-class-checkins/c1/presence", {
    body: { presenca: "presente" },
  });

  assert.equal(r.status, 403);
  assert.ok(pedidas.includes("schedule.manage"));
});

test("fechar a aula é do DIA, e leva quem fechou", async () => {
  // Numa academia com três pessoas no balcão, "quem fechou a aula das 7?" é
  // uma pergunta que se faz no mesmo dia.
  const fechamentos = [];
  const { app } = monta({
    extra: {
      groupClassSession: {
        async fechadasDoDia() { return new Set(); },
        async estaFechada() { return false; },
        async fechar(aula, dia, inicio, fechada, quem) {
          fechamentos.push({ aula, dia, inicio, fechada, quem });
          return true;
        },
        async removeAllOf() { return 0; },
      },
    },
  });

  const r = await call(app, "post", "/group-classes/a1/close", {
    body: { dia: "2026-09-21", inicio: 420, fechada: true },
  });

  assert.equal(r.status, 200);
  assert.equal(fechamentos[0].dia, "2026-09-21");
  assert.equal(fechamentos[0].fechada, true);
  assert.equal(fechamentos[0].quem, "u1");
});

test("apagar a aula leva as sessões junto", async () => {
  const { app, chamadas } = monta();
  await call(app, "delete", "/group-classes/a1");

  assert.deepEqual(chamadas.removeSessoes, ["a1"]);
});

// ── INSCREVER À MÃO ───────────────────────────────────────────────────────
//
// *"coloque botão para inserir aluno manualmente para ocupar vaga"*.
//
// O que se guarda aqui são as três RECUSAS. Elas são a parte que dá vontade de
// afrouxar — "quem está no balcão manda" —, e é justamente quem está no balcão
// que não vê a lista inteira.
test("inscrever à mão pede `schedule.manage`", async () => {
  const { app, pedidas } = monta({ permissoes: ["people.view"] });

  const r = await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", dia: "2026-09-21", inicio: 420 },
  });

  assert.equal(r.status, 403);
  assert.ok(pedidas.includes("schedule.manage"));
});

test("pessoa que não é da lista de quem chama é 404 — e não entra", async () => {
  // Sem isto, um id de outra conta entraria numa aula que não é dela.
  const { app, chamadas } = monta({ pessoaVinculada: false });

  const r = await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", dia: "2026-09-21", inicio: 420 },
  });

  assert.equal(r.status, 404);
  assert.deepEqual(chamadas.entrou, []);
});

test("entra com o dia, o horário e a regra de um por dia da aula", async () => {
  const { app, chamadas } = monta();

  const r = await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", dia: "2026-09-21", inicio: 420 },
  });

  assert.equal(r.status, 201);
  assert.equal(chamadas.entrou[0].dia, "2026-09-21");
  assert.equal(chamadas.entrou[0].inicio, 420);
  // A aula do teste não tem `variosHorarios`: a marca de um-por-dia vale.
  assert.equal(chamadas.entrou[0].variosHorarios, false);
});

test("sem dia no corpo, quem decide o dia é o servidor", async () => {
  // O relógio de quem está no balcão pode estar errado, e a inscrição de hoje
  // iria parar em ontem sem nada na tela denunciar.
  const { app, chamadas } = monta();

  await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", inicio: 420 },
  });

  assert.match(chamadas.entrou[0].dia, /^\d{4}-\d{2}-\d{2}$/);
});

test("lotada recusa, mesmo pelo balcão", async () => {
  // Uma inscrição a mais numa aula de vinte vagas só aparece na hora da
  // chamada, quando não dá mais para resolver. Quem precisa de uma vaga a mais
  // aumenta as vagas.
  const cheia = { ...AULA, seats: 2 };
  const { app, chamadas } = monta({
    aulas: [cheia],
    dentro: [{ _id: "c1" }, { _id: "c2" }],
    extra: {
      groupClass: {
        async list() { return [cheia]; },
        async listActive() { return [cheia]; },
        async data() { return cheia; },
        async insert() { return "a2"; },
        async update() { return true; },
        async remove() { return true; },
        async reorder() { return true; },
        estadoAgora: (aula, quando, fuso) => estadoDeVerdade(aula, quando, fuso),
      },
    },
  });

  const r = await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", dia: "2026-09-21", inicio: 420 },
  });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "lotada");
  assert.deepEqual(chamadas.entrou, []);
});

test("vaga ilimitada não é lotada nunca", async () => {
  // `seats: 0` é sem limite; sem esta diferença, a conferência leria "zero
  // vagas" e recusaria todo mundo.
  const { app } = monta({ dentro: [{ _id: "c1" }, { _id: "c2" }, { _id: "c3" }] });

  const r = await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", dia: "2026-09-21", inicio: 420 },
  });

  assert.equal(r.status, 201);
});

test("aula fechada recusa — reabrir é um clique, e ele fica registrado", async () => {
  const { app, chamadas } = monta({
    extra: {
      groupClassSession: {
        async fechadasDoDia() { return new Set(); },
        async estaFechada() { return true; },
        async fechar() { return true; },
        async removeAllOf() { return 0; },
      },
    },
  });

  const r = await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", dia: "2026-09-21", inicio: 420 },
  });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "fechada");
  assert.deepEqual(chamadas.entrou, []);
});

test("quem já entrou noutro horário hoje, numa aula de um por dia, é recusado", async () => {
  const { app } = monta({ entrada: { ok: false, erro: "ja_entrou_hoje" } });

  const r = await call(app, "post", "/group-classes/a1/checkins", {
    body: { person: "p1", dia: "2026-09-21", inicio: 420 },
  });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ja_entrou_hoje");
});

test("tirar da lista apaga a LINHA, e id que não existe é 404", async () => {
  // A mesma pessoa pode estar nos dois horários do dia: tirar "a pessoa da
  // aula" tiraria dos dois.
  const { app, chamadas } = monta();
  const ok = await call(app, "delete", "/group-class-checkins/c1");

  assert.equal(ok.status, 200);
  assert.deepEqual(chamadas.apagados, ["c1"]);

  const { app: app2 } = monta({ apagou: false });
  const nao = await call(app2, "delete", "/group-class-checkins/sumiu");

  assert.equal(nao.status, 404);
});

test("tirar da lista pede `schedule.manage`", async () => {
  const { app, pedidas } = monta({ permissoes: ["people.view"] });
  const r = await call(app, "delete", "/group-class-checkins/c1");

  assert.equal(r.status, 403);
  assert.ok(pedidas.includes("schedule.manage"));
});

// ── A FOLHA IMPRESSA ──────────────────────────────────────────────────────
//
// *"bote aqui para poder imprimir a listagem também e exportar"*.
//
// A folha é uma ROTA, aberta por link, sem tela nenhuma atrás. Por isso o
// cabeçalho dela vem do servidor, na mesma resposta dos inscritos: uma folha
// que diz "08:00" sem dizer de que aula é não serve na prancheta.
test("os inscritos vêm com a AULA junto, para a folha ter cabeçalho", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/group-classes/a1/checkins", {
    query: { dia: "2026-09-21", inicio: "420" },
  });

  assert.equal(r.body.aula.nome, "Spinning");
  assert.equal(r.body.aula.inicio, "07:00");
  assert.equal(r.body.aula.fim, "07:50");
});

test("horário que a aula não tem sai sem relógio, e não quebra", async () => {
  // Um link velho aponta para um horário que saiu da grade. A folha abre com a
  // lista vazia e o nome da aula — melhor que um erro que não diz nada.
  const { app } = monta();
  const r = await call(app, "get", "/group-classes/a1/checkins", {
    query: { dia: "2026-09-21", inicio: "1380" },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.aula.nome, "Spinning");
  assert.equal(r.body.aula.inicio, "");
});
