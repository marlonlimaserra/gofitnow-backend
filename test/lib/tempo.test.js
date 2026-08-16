const test = require("node:test");
const assert = require("node:assert/strict");

const tempo = require("../../lib/tempo.js");

// A hora de PAREDE virando instante, e voltando.
//
// O defeito que trouxe este arquivo: "no painel eu coloco 8 e no calendário
// aparece 5". A grade dizia "480 minutos de segunda", o servidor — que roda em
// UTC — lia isso como 08:00Z, e o navegador em Brasília desenhava 05:00. Três
// horas somem entre digitar e olhar.
//
// O servidor continua em UTC de propósito. Quem diz que horas são "08:00" passa
// a ser o fuso da CONTA.
const SP = "America/Sao_Paulo";
const LISBOA = "Europe/Lisbon";
const TOQUIO = "Asia/Tokyo";

test("08:00 em São Paulo é 11:00 UTC", () => {
  const quando = tempo.instante({ ano: 2026, mes: 8, dia: 20, hora: 8, minuto: 0 }, SP);

  assert.equal(quando.toISOString(), "2026-08-20T11:00:00.000Z");
});

test("o mesmo 08:00 em Tóquio é outro instante", () => {
  // É a prova de que o fuso está sendo usado, e não ignorado: se ele fosse
  // decorativo, os dois dariam o mesmo horário UTC.
  const quando = tempo.instante({ ano: 2026, mes: 8, dia: 20, hora: 8, minuto: 0 }, TOQUIO);

  assert.equal(quando.toISOString(), "2026-08-19T23:00:00.000Z");
});

test("ida e volta não perde nem ganha hora", () => {
  const quando = tempo.instante({ ano: 2026, mes: 8, dia: 20, hora: 8, minuto: 30 }, SP);
  const parede = tempo.paredeDe(quando, SP);

  assert.equal(parede.hora, 8);
  assert.equal(parede.minuto, 30);
  assert.equal(parede.data, "2026-08-20");
});

test("o DIA da parede não é o dia do UTC", () => {
  // 22:00 em São Paulo é 01:00 do dia seguinte em UTC. Agrupar a agenda por
  // `toISOString()` jogaria o compromisso da noite para o dia de amanhã.
  const noite = tempo.instante({ ano: 2026, mes: 8, dia: 20, hora: 22, minuto: 0 }, SP);

  assert.equal(noite.toISOString().slice(0, 10), "2026-08-21");
  assert.equal(tempo.paredeDe(noite, SP).data, "2026-08-20");
});

test("o dia da SEMANA é o de quem atende", () => {
  // A grade semanal pergunta "que dia é hoje?" a cada slot. Com o dia de UTC, a
  // sexta à noite viraria sábado — e a grade de sábado é outra.
  const sextaANoite = tempo.instante({ ano: 2026, mes: 8, dia: 21, hora: 22, minuto: 0 }, SP);

  assert.equal(sextaANoite.getUTCDay(), 6, "em UTC já é sábado");
  assert.equal(tempo.paredeDe(sextaANoite, SP).diaDaSemana, 5, "para quem atende é sexta");
});

test("horário de verão: o deslocamento muda com a data", () => {
  // Lisboa é UTC+0 no inverno e UTC+1 no verão. Um número fixo por fuso erraria
  // meio ano inteiro — e é por isso que o deslocamento é calculado no instante.
  const inverno = tempo.instante({ ano: 2026, mes: 1, dia: 15, hora: 8 }, LISBOA);
  const verao = tempo.instante({ ano: 2026, mes: 7, dia: 15, hora: 8 }, LISBOA);

  assert.equal(inverno.toISOString(), "2026-01-15T08:00:00.000Z");
  assert.equal(verao.toISOString(), "2026-07-15T07:00:00.000Z");
});

test("a hora seguinte à virada do horário de verão cai no lugar", () => {
  // É o caso que obriga as DUAS passadas: o deslocamento depende do instante, e
  // o instante é o que se está calculando. Com uma passada só, a hora seguinte à
  // virada erra em sessenta minutos.
  //
  // Lisboa adianta às 01:00 do dia 29/03/2026. Às 08:00 daquele dia já vale o
  // horário de verão.
  const depois = tempo.instante({ ano: 2026, mes: 3, dia: 29, hora: 8 }, LISBOA);

  assert.equal(depois.toISOString(), "2026-03-29T07:00:00.000Z");
  assert.equal(tempo.paredeDe(depois, LISBOA).hora, 8);
});

test("comMinutos abre a janela na hora do relógio de quem atende", () => {
  // A grade guarda minutos desde a meia-noite. 480 é 08:00 — do estúdio, não do
  // servidor.
  const dia = new Date("2026-08-20T15:00:00.000Z");
  const abertura = tempo.comMinutos(dia, 480, SP);

  assert.equal(abertura.toISOString(), "2026-08-20T11:00:00.000Z");
  assert.equal(tempo.paredeDe(abertura, SP).hora, 8);
});

test("comMinutos usa o DIA de quem atende, não o do instante em UTC", () => {
  // 01:00Z do dia 21 ainda é dia 20 em São Paulo. Sem isto, a janela da segunda
  // seria montada em cima da terça.
  const madrugada = new Date("2026-08-21T01:00:00.000Z");

  assert.equal(tempo.paredeDe(madrugada, SP).data, "2026-08-20");
  assert.equal(
    tempo.comMinutos(madrugada, 480, SP).toISOString(),
    "2026-08-20T11:00:00.000Z"
  );
});

test("fuso inválido cai no padrão em vez de estourar", () => {
  // O nome vem de configuração, e configuração errada não pode derrubar a
  // agenda de todo mundo — ela cai no fuso de sempre.
  assert.equal(tempo.normalizar("Marte/Olympus"), tempo.PADRAO);
  assert.equal(tempo.normalizar(""), tempo.PADRAO);
  assert.equal(tempo.normalizar(undefined), tempo.PADRAO);
  assert.equal(tempo.normalizar("Europe/Lisbon"), "Europe/Lisbon");
});

test("o Intl é quem diz quais fusos existem", () => {
  // Manter uma lista aqui seria manter uma lista desatualizada: o IANA muda, e
  // o Node acompanha.
  assert.equal(tempo.valido("America/Sao_Paulo"), true);
  assert.equal(tempo.valido("Asia/Tokyo"), true);
  assert.equal(tempo.valido("UTC"), true);
  assert.equal(tempo.valido("Nenhum/Lugar"), false);
});
