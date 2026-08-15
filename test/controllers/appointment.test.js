const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const AppointmentController = require("../../controllers/Appointment.js");

const EU = { _id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "Marlon" };
const COLEGA = { _id: "aaaaaaaaaaaaaaaaaaaaaaa2", name: "Ana" };
const PESSOA = { _id: "bbbbbbbbbbbbbbbbbbbbbbb1", name: "Heitor" };

// A agenda da equipe tem uma regra que não pode falhar em silêncio: quem NÃO
// tem `schedule.team` enxerga e mexe só na própria agenda.
//
// O filtro do topo da tela é conveniência. A regra é do servidor — senão basta
// trocar um id na query para ler a agenda de um colega, e nada na tela
// denunciaria isso.
function monta({ equipe = true, existente, servico, cobrancaExistente, criado } = {}) {
  const chamadas = {
    between: [],
    listOfStudent: [],
    insert: [],
    update: [],
    delete: [],
    cobrancas: [],
  };
  const permissao = permiteTudo(EU);

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      user: {
        // O `permiteTudo` libera as permissões de ROTA; esta é consultada à
        // parte, e é ela que separa quem vê a equipe de quem não vê.
        async hasPermission(user, permissao) {
          return permissao === "schedule.team" ? equipe : true;
        },
        async professionals() {
          return [EU, COLEGA];
        },
        async professionalIds() {
          return [EU._id, COLEGA._id];
        },
        async dataStudent() {
          return PESSOA;
        },
        async briefByIds() {
          return {
            [EU._id]: { name: EU.name },
            [COLEGA._id]: { name: COLEGA.name },
            [PESSOA._id]: { name: PESSOA.name },
          };
        },
      },
      appointment: {
        async between(ids, from, to) {
          chamadas.between.push(ids.map(String));
          return [];
        },
        async listOfStudent(ids) {
          chamadas.listOfStudent.push(ids.map(String));
          return [];
        },
        async conflicts() {
          return [];
        },
        async data(ids, id) {
          // Depois de inserir, a rota relê o que gravou — é dessa leitura que
          // sai a resposta. O fake devolve algo para o caminho de criação ser
          // exercitado até o fim.
          if (existente) return existente;
          if (String(id) !== "a1") return undefined;
          return criado || { _id: "a1", date: new Date() };
        },
        async insert(alvo, studentId, obj, createdBy) {
          chamadas.insert.push({ alvo: String(alvo), createdBy: String(createdBy) });
          return "a1";
        },
        async update(ids, id, obj, novoTrainer) {
          chamadas.update.push({ ids: ids.map(String), novoTrainer: novoTrainer && String(novoTrainer) });
          return true;
        },
        async setStatus() {
          return true;
        },
        async delete(ids) {
          chamadas.delete.push(ids.map(String));
          return true;
        },
      },
      service: {
        async data(id) {
          return servico && String(id) === String(servico._id) ? servico : undefined;
        },
      },
      finance: {
        async chargeOfAppointment() {
          return cobrancaExistente;
        },
        async insertCharge(studentId, obj, createdBy, currency) {
          chamadas.cobrancas.push({
            ...obj,
            studentId: String(studentId),
            createdBy: String(createdBy),
            currency,
          });
          return "cob1";
        },
      },
      // A moeda da conta, gravada em cada lançamento: sem ela, trocar a moeda
      // reescreveria o passado.
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL", "USD"] };
        },
        // A moeda de um lançamento: a pedida, se habilitada; senão a padrão.
        async currencyFor(pedida) {
          return ["BRL", "USD"].includes(String(pedida || "").toUpperCase())
            ? String(pedida).toUpperCase()
            : "BRL";
        },
      },
      actionHistory: { diff: () => ({}) },
    },
  });

  AppointmentController(app);
  return { app, chamadas };
}

const SEMANA = { from: "2026-08-17T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" };

test("sem a permissão de equipe, a semana é só a MINHA", async () => {
  const { app, chamadas } = monta({ equipe: false });

  await call(app, "get", "/appointments", { query: SEMANA });

  assert.deepEqual(chamadas.between, [[EU._id]]);
});

test("sem a permissão, pedir a agenda de um colega na query não adianta", async () => {
  // O teste central deste arquivo. A tela esconde o seletor, mas a rota é
  // pública para quem tem sessão — e é ela que tem de recusar.
  const { app, chamadas } = monta({ equipe: false });

  await call(app, "get", "/appointments", {
    query: { ...SEMANA, professionals: `${COLEGA._id},${EU._id}` },
  });

  assert.deepEqual(chamadas.between, [[EU._id]]);
});

test("com a permissão e sem escolha, vem a equipe inteira", async () => {
  const { app, chamadas } = monta();

  await call(app, "get", "/appointments", { query: SEMANA });

  assert.deepEqual(chamadas.between, [[EU._id, COLEGA._id]]);
});

test("com a permissão, o filtro escolhe quem aparece", async () => {
  const { app, chamadas } = monta();

  await call(app, "get", "/appointments", {
    query: { ...SEMANA, professionals: COLEGA._id },
  });

  assert.deepEqual(chamadas.between, [[COLEGA._id]]);
});

test("o seletor só lista a equipe para quem pode vê-la", async () => {
  // Para quem não pode, existe uma agenda só — a própria — e um seletor de um
  // item é enfeite.
  const sozinho = monta({ equipe: false });
  const um = await call(sozinho.app, "get", "/professionals");
  assert.deepEqual(um.body.rows.map((r) => r.name), ["Marlon"]);

  const coordena = monta();
  const todos = await call(coordena.app, "get", "/professionals");
  assert.deepEqual(todos.body.rows.map((r) => r.name), ["Marlon", "Ana"]);
});

test("marcar no horário de um colega exige a permissão de equipe", async () => {
  // Sem ela o pedido é ignorado e o compromisso fica com quem marcou — não
  // vira um erro, porque um erro aqui não ajudaria ninguém.
  const sozinho = monta({ equipe: false });
  await call(sozinho.app, "post", "/people/p1/appointments", {
    body: { date: "2026-08-18T10:00:00.000Z", trainer: COLEGA._id },
  });
  assert.equal(sozinho.chamadas.insert[0].alvo, EU._id);

  const coordena = monta();
  await call(coordena.app, "post", "/people/p1/appointments", {
    body: { date: "2026-08-18T10:00:00.000Z", trainer: COLEGA._id },
  });
  assert.equal(coordena.chamadas.insert[0].alvo, COLEGA._id);
});

test("quem ATENDE e quem REGISTROU ficam separados", async () => {
  // A recepção marca no horário do professor: o compromisso é dele, e o
  // histórico precisa saber quem digitou.
  const { app, chamadas } = monta();

  await call(app, "post", "/people/p1/appointments", {
    body: { date: "2026-08-18T10:00:00.000Z", trainer: COLEGA._id },
  });

  assert.deepEqual(chamadas.insert[0], { alvo: COLEGA._id, createdBy: EU._id });
});

test("editar e apagar respeitam o mesmo alcance", async () => {
  // Sem isto, bastaria trocar o id na URL para mexer na agenda de um colega.
  const sozinho = monta({ equipe: false, existente: { _id: "a1", status: "scheduled" } });

  await call(sozinho.app, "put", "/appointments/a1", { body: { date: "2026-08-18T10:00:00.000Z" } });
  await call(sozinho.app, "delete", "/appointments/a1");

  assert.deepEqual(sozinho.chamadas.update[0].ids, [EU._id]);
  assert.deepEqual(sozinho.chamadas.delete[0], [EU._id]);
});

test("trocar o compromisso de profissional exige a permissão", async () => {
  const sozinho = monta({ equipe: false, existente: { _id: "a1" } });
  await call(sozinho.app, "put", "/appointments/a1", {
    body: { date: "2026-08-18T10:00:00.000Z", trainer: COLEGA._id },
  });
  assert.equal(sozinho.chamadas.update[0].novoTrainer, null);

  const coordena = monta({ existente: { _id: "a1" } });
  await call(coordena.app, "put", "/appointments/a1", {
    body: { date: "2026-08-18T10:00:00.000Z", trainer: COLEGA._id },
  });
  assert.equal(coordena.chamadas.update[0].novoTrainer, COLEGA._id);
});

test("a ficha da pessoa mostra o atendimento de toda a equipe", async () => {
  // Se a nutricionista marcou uma consulta, ela faz parte do acompanhamento
  // desta pessoa tanto quanto o treino.
  const { app, chamadas } = monta();

  await call(app, "get", "/people/p1/appointments");

  assert.deepEqual(chamadas.listOfStudent, [[EU._id, COLEGA._id]]);
});

test("sem a permissão, a ficha mostra só o meu atendimento", async () => {
  const { app, chamadas } = monta({ equipe: false });

  await call(app, "get", "/people/p1/appointments");

  assert.deepEqual(chamadas.listOfStudent, [[EU._id]]);
});

// ── A cobrança automática ─────────────────────────────────────────────────
//
// É a regra que liga agenda e financeiro: marcou um compromisso de um serviço
// que tem valor, nasce a cobrança. Errar aqui não aparece na tela — aparece no
// caixa, semanas depois, cobrando de menos ou duas vezes.
const SERVICO = { _id: "ccccccccccccccccccccccc1", name: "Treino", price: 12000 };
const QUANDO = new Date("2026-08-18T10:00:00.000Z");

test("compromisso de serviço com valor gera a cobrança", async () => {
  const { app, chamadas } = monta({
    servico: SERVICO,
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.equal(chamadas.cobrancas.length, 1);
  assert.equal(chamadas.cobrancas[0].amount, 12000);
  assert.equal(chamadas.cobrancas[0].description, "Treino");
  // O vencimento é o DIA do atendimento: cobrar antes de atender inverteria a
  // ordem do combinado.
  assert.equal(String(chamadas.cobrancas[0].dueDate), String(QUANDO));
});

test("o valor é COPIADO do serviço, não apontado para ele", async () => {
  // Reajustar o preço em setembro não pode mudar o que já foi cobrado em
  // agosto. Por isso a cobrança guarda o número, e não uma referência.
  const { app, chamadas } = monta({
    servico: SERVICO,
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.equal(typeof chamadas.cobrancas[0].amount, "number");
});

test("serviço SEM valor não gera cobrança", async () => {
  // Avaliação de cortesia, aula experimental: existe serviço que não se cobra,
  // e uma cobrança de zero real só polui a lista.
  const { app, chamadas } = monta({
    servico: { ...SERVICO, price: 0 },
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.deepEqual(chamadas.cobrancas, []);
});

test("compromisso sem serviço não gera cobrança", async () => {
  const { app, chamadas } = monta({ criado: { _id: "a1", date: QUANDO } });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString() },
  });

  assert.deepEqual(chamadas.cobrancas, []);
});

test("compromisso que JÁ tem cobrança não ganha outra", async () => {
  // A garantia contra cobrar duas vezes pela mesma aula — o erro que o cliente
  // percebe antes do profissional.
  const { app, chamadas } = monta({
    servico: SERVICO,
    cobrancaExistente: { _id: "cob-antiga" },
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.deepEqual(chamadas.cobrancas, []);
});

test("a cobrança nasce com a moeda do SERVIÇO", async () => {
  // Um serviço vendido em dólar gera cobrança em dólar. Usar a padrão da conta
  // daria o valor certo com o símbolo errado — o pior tipo de erro, porque
  // parece certo.
  const emDolar = monta({
    servico: { ...SERVICO, currency: "USD" },
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(emDolar.app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.equal(emDolar.chamadas.cobrancas[0].currency, "USD");
});

test("serviço sem moeda própria cai na padrão da conta", async () => {
  const { app, chamadas } = monta({
    servico: SERVICO,
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.equal(chamadas.cobrancas[0].currency, "BRL");
});

test("moeda não habilitada cai na padrão, e não vira erro", async () => {
  // Recusar seria pior: o pedido viraria erro de tela numa situação em que a
  // resposta certa é óbvia.
  const { app, chamadas } = monta({
    servico: { ...SERVICO, currency: "JPY" },
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.equal(chamadas.cobrancas[0].currency, "BRL");
});

test("a cobrança nasce para o ALUNO, registrada por quem marcou", async () => {
  const { app, chamadas } = monta({
    servico: SERVICO,
    criado: { _id: "a1", date: QUANDO, service: SERVICO._id },
  });

  await call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: SERVICO._id },
  });

  assert.equal(chamadas.cobrancas[0].studentId, PESSOA._id);
  assert.equal(chamadas.cobrancas[0].createdBy, EU._id);
});
