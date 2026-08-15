const test = require("node:test");
const assert = require("node:assert/strict");

const slots = require("../../lib/slots.js");

// Os horários livres da agenda pública.
//
// É a única parte do módulo em que um erro NÃO aparece na tela. Ele aparece
// como duas pessoas marcadas no mesmo horário, ou como um horário livre que o
// cliente clica e não consegue marcar — os dois descobertos pelo cliente, não
// pelo profissional.
//
// As datas são construídas com `new Date(ano, mês, dia, hora)`, que é hora
// LOCAL. Um "2026-08-18T07:00" solto seria lido como UTC e, num fuso negativo,
// cairia no dia anterior.

// Terça-feira, 18 de agosto de 2026.
const TERCA = new Date(2026, 7, 18);
const SEMANA = { tue: [{ from: "07:00", to: "10:00" }] };

test("a hora vira minutos, e o que não é hora vira nulo", () => {
  // Um campo digitado errado não pode virar meia-noite em silêncio: a grade
  // passaria a oferecer madrugada.
  assert.equal(slots.minutos("07:30"), 450);
  assert.equal(slots.minutos("00:00"), 0);
  assert.equal(slots.minutos("24:00"), null);
  assert.equal(slots.minutos("7h"), null);
  assert.equal(slots.minutos(""), null);
});

test("os horários saem de passo em passo, dentro da janela", () => {
  const horarios = slots.horariosDoDia({ dia: TERCA, semana: SEMANA, passo: 60, duracao: 60 });

  assert.deepEqual(
    horarios.map((h) => h.getHours()),
    [7, 8, 9]
  );
});

test("o horário só entra se COUBER inteiro na janela", () => {
  // Uma janela das 7h às 10h com treino de 90 min cabe às 7h e às 8h30 — não às
  // 9h, que terminaria às 10h30, depois do expediente.
  const horarios = slots.horariosDoDia({ dia: TERCA, semana: SEMANA, passo: 30, duracao: 90 });
  const ultimo = horarios[horarios.length - 1];

  assert.equal(ultimo.getHours(), 8);
  assert.equal(ultimo.getMinutes(), 30);
});

test("dia sem janela não oferece nada", () => {
  // Quarta-feira, e a grade só tem terça.
  const quarta = new Date(2026, 7, 19);
  assert.deepEqual(slots.horariosDoDia({ dia: quarta, semana: SEMANA }), []);
});

test("janela invertida é engano de cadastro, não janela negativa", () => {
  const torta = { tue: [{ from: "12:00", to: "08:00" }] };
  assert.deepEqual(slots.horariosDoDia({ dia: TERCA, semana: torta }), []);
});

test("duas janelas no mesmo dia deixam o intervalo de fora", () => {
  // Manhã e tarde, com almoço no meio: o almoço não pode aparecer como livre.
  const comAlmoco = { tue: [{ from: "08:00", to: "10:00" }, { from: "14:00", to: "16:00" }] };
  const horas = slots
    .horariosDoDia({ dia: TERCA, semana: comAlmoco, passo: 60, duracao: 60 })
    .map((h) => h.getHours());

  assert.deepEqual(horas, [8, 9, 14, 15]);
});

// ── Ocupação ──────────────────────────────────────────────────────────────

const as = (hora, minuto = 0) => new Date(2026, 7, 18, hora, minuto);

test("um atendimento cruzando zera as vagas", () => {
  const vagas = slots.vagasEm({
    inicio: as(10),
    duracao: 60,
    compromissos: [{ date: as(10, 30), minutes: 60, service: "s1" }],
    serviceId: "s1",
    capacidade: 1,
  });

  assert.equal(vagas, 0);
});

test("encostar não é cruzar", () => {
  // Das 9h às 10h e das 10h às 11h são horários seguidos, não simultâneos.
  // Tratá-los como choque fecharia metade da agenda de quem atende de hora em
  // hora.
  const vagas = slots.vagasEm({
    inicio: as(10),
    duracao: 60,
    compromissos: [{ date: as(9), minutes: 60, service: "s1" }],
    serviceId: "s1",
    capacidade: 1,
  });

  assert.equal(vagas, 1);
});

test("a mesma turma soma até a capacidade", () => {
  // É o que faz aula de grupo existir: três inscritos numa turma de oito
  // deixam cinco vagas.
  const turma = [
    { date: as(10), minutes: 60, service: "s1" },
    { date: as(10), minutes: 60, service: "s1" },
    { date: as(10), minutes: 60, service: "s1" },
  ];

  assert.equal(
    slots.vagasEm({ inicio: as(10), duracao: 60, compromissos: turma, serviceId: "s1", capacidade: 8 }),
    5
  );
});

test("turma cheia não oferece vaga", () => {
  const cheia = [
    { date: as(10), minutes: 60, service: "s1" },
    { date: as(10), minutes: 60, service: "s1" },
  ];

  assert.equal(
    slots.vagasEm({ inicio: as(10), duracao: 60, compromissos: cheia, serviceId: "s1", capacidade: 2 }),
    0
  );
});

test("OUTRO serviço cruzando ocupa o profissional por inteiro", () => {
  // A parte que costuma ser esquecida: uma consulta às 10h30 impede o treino
  // das 10h, mesmo que a turma das 10h tenha vaga. O profissional é um só.
  const vagas = slots.vagasEm({
    inicio: as(10),
    duracao: 60,
    compromissos: [{ date: as(10, 30), minutes: 30, service: "s2" }],
    serviceId: "s1",
    capacidade: 8,
  });

  assert.equal(vagas, 0);
});

test("a mesma turma em horário diferente também ocupa", () => {
  // Mesmo serviço, mas começando 30 min depois: não é a mesma turma, é outra
  // que se sobrepõe.
  const vagas = slots.vagasEm({
    inicio: as(10),
    duracao: 60,
    compromissos: [{ date: as(10, 30), minutes: 60, service: "s1" }],
    serviceId: "s1",
    capacidade: 8,
  });

  assert.equal(vagas, 0);
});

test("desmarcado não ocupa horário", () => {
  const vagas = slots.vagasEm({
    inicio: as(10),
    duracao: 60,
    compromissos: [{ date: as(10), minutes: 60, service: "s1", status: "canceled" }],
    serviceId: "s1",
    capacidade: 1,
  });

  assert.equal(vagas, 1);
});

// ── A lista que o cliente vê ───────────────────────────────────────────────

test("a antecedência mínima corta o que é cedo demais", () => {
  // Ninguém quer receber uma marcação para daqui a dez minutos e descobrir
  // depois de a pessoa chegar.
  const livres = slots.livresDoDia({
    dia: TERCA,
    semana: SEMANA,
    passo: 60,
    duracao: 60,
    compromissos: [],
    agora: as(6),
    antecedenciaHoras: 2,
  });

  assert.deepEqual(
    livres.map((l) => l.start.getHours()),
    [8, 9]
  );
});

test("o horizonte corta o que é longe demais", () => {
  // Sem ele, um cliente marcaria para o ano que vem e o profissional só
  // descobriria em dezembro.
  const livres = slots.livresDoDia({
    dia: TERCA,
    semana: SEMANA,
    duracao: 60,
    compromissos: [],
    agora: new Date(2026, 6, 1),
    horizonteDias: 7,
  });

  assert.deepEqual(livres, []);
});

test("o bloqueio vence a grade", () => {
  // Férias, feriado, uma tarde de congresso: quem bloqueou não quer explicar
  // por que o horário continua aparecendo.
  const livres = slots.livresDoDia({
    dia: TERCA,
    semana: SEMANA,
    passo: 60,
    duracao: 60,
    compromissos: [],
    bloqueios: [{ from: as(8), to: as(9, 30) }],
    agora: as(0),
  });

  assert.deepEqual(
    livres.map((l) => l.start.getHours()),
    [7]
  );
});

test("o que sobra vem com quantas vagas restam", () => {
  // É o número que a tela mostra ao cliente numa aula de grupo.
  const livres = slots.livresDoDia({
    dia: TERCA,
    semana: SEMANA,
    passo: 60,
    duracao: 60,
    serviceId: "s1",
    capacidade: 5,
    compromissos: [{ date: as(8), minutes: 60, service: "s1" }],
    agora: as(0),
  });

  const oito = livres.find((l) => l.start.getHours() === 8);
  assert.equal(oito.seats, 4);
});

test("horário sem vaga não é oferecido", () => {
  const livres = slots.livresDoDia({
    dia: TERCA,
    semana: SEMANA,
    passo: 60,
    duracao: 60,
    serviceId: "s1",
    capacidade: 1,
    compromissos: [{ date: as(8), minutes: 60, service: "s1" }],
    agora: as(0),
  });

  assert.deepEqual(
    livres.map((l) => l.start.getHours()),
    [7, 9]
  );
});

// ── O horário de uma página de agendamento ───────────────────────────────
//
// Uma página é dona do calendário dela. A rota pública decide de quem é o
// horário perguntando se a página tem um — e é só isso que esta parte precisa
// responder bem.

test("saber se sobrou algum horário não obriga a varrer os sete dias na mão", () => {
  assert.equal(slots.temHorario(SEMANA), true);
  assert.equal(slots.temHorario({}), false);
  assert.equal(slots.temHorario({ tue: [] }), false);
  assert.equal(slots.temHorario(undefined), false);
  // Uma faixa impossível não conta como horário: a página cairia na grade da conta.
  assert.equal(slots.temHorario({ tue: [{ from: "10:00", to: "07:00" }] }), false);
});
