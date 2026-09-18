const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const GroupClass = require(path.join(__dirname, "..", "..", "model", "GroupClass_model.js"));

// A AULA COLETIVA — a grade que se repete toda semana.
//
// *"vai ser parecido com o aulões, a diferença é que vai resetar todo o dia,
// coloque para configurar horário mínimo para check-in etc"*.
//
// A diferença para o aulão é o TEMPO, e ela arrasta a modelagem inteira: o
// aulão é um EVENTO com data; esta é uma GRADE que não acaba. Por isso a hora
// aqui é relógio de parede, e não instante.

function monta() {
  const gravados = [];
  const atualizacoes = [];

  const col = {
    countDocuments: async () => 0,
    insertOne: async (doc) => {
      gravados.push(doc);
      return { insertedId: "6a80de570056d24c09f5da61" };
    },
    updateOne: async (onde, mudanca) => {
      atualizacoes.push(mudanca);
      return { matchedCount: 1 };
    },
    findOne: async () => null,
    deleteOne: async () => ({ deletedCount: 1 }),
    find: () => ({ sort: () => ({ toArray: async () => [] }) }),
  };

  const model = new GroupClass({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
  });

  return { model, gravados, atualizacoes };
}

const SP = "America/Sao_Paulo";

test("a hora vira MINUTOS, e não um instante", async () => {
  // Um instante seria a modelagem errada: 07:00 de segunda é 07:00 também no
  // domingo de horário de verão, e guardar instante faria a aula andar uma
  // hora sozinha duas vezes por ano.
  const { model, gravados } = monta();

  await model.insert({ name: "Spinning", hora: "07:30", dias: [1, 3, 5] });

  assert.equal(gravados[0].horaMinutos, 450);
});

test("sem nome, sem hora ou sem dia NÃO existe aula", async () => {
  // Ela nunca aconteceria, e uma linha assim na grade é só confusão.
  const { model, gravados } = monta();

  assert.equal(await model.insert({ hora: "07:00", dias: [1] }), null);
  assert.equal(await model.insert({ name: "X", dias: [1] }), null);
  assert.equal(await model.insert({ name: "X", hora: "07:00", dias: [] }), null);
  assert.equal(gravados.length, 0);
});

test("hora inválida é recusada, e não vira meia-noite", async () => {
  // `"25:00"` virando 0 marcaria a aula para a madrugada sem ninguém pedir.
  const { model } = monta();

  for (const ruim of ["25:00", "07:70", "sete", "", "7h"]) {
    assert.equal(await model.insert({ name: "X", hora: ruim, dias: [1] }), null, String(ruim));
  }
});

test("os dias saem ordenados e sem repetição", async () => {
  const { model, gravados } = monta();

  await model.insert({ name: "X", hora: "07:00", dias: [5, 1, 1, 9, "3", -2] });

  assert.deepEqual(gravados[0].dias, [1, 3, 5]);
});

test("a janela de check-in é RELATIVA ao início, e tem padrão", async () => {
  // "Abre 30 minutos antes" continua valendo quando a aula muda de 07:00 para
  // 08:00; "abre às 06:30" viraria uma janela errada calada.
  const { model, gravados } = monta();

  await model.insert({ name: "X", hora: "07:00", dias: [1] });
  await model.insert({ name: "Y", hora: "07:00", dias: [1], checkinAbre: 60, checkinFecha: 5 });

  assert.equal(gravados[0].checkinAbre, 30);
  assert.equal(gravados[0].checkinFecha, 15);
  assert.equal(gravados[1].checkinAbre, 60);
  assert.equal(gravados[1].checkinFecha, 5);
});

test("editar não pode deixar a aula sem hora nem sem dia", async () => {
  // Seria apagá-la pela metade: ela continuaria na lista sem nunca acontecer.
  const { model } = monta();

  assert.equal(await model.update("6a80de570056d24c09f5da61", { hora: "xx" }), false);
  assert.equal(await model.update("6a80de570056d24c09f5da61", { dias: [] }), false);
  assert.equal(await model.update("6a80de570056d24c09f5da61", { name: "Novo nome" }), true);
});

describe_estado();

function describe_estado() {
  // ── A JANELA, no relógio da CONTA ───────────────────────────────────────
  //
  // Calculada no fuso de quem atende, e não no do servidor. Sem isso, uma
  // academia em Manaus veria a janela abrir uma hora adiantada — e o defeito
  // apareceria só para ela, que é o pior tipo.
  const AULA = { dias: [1], horaMinutos: 7 * 60, checkinAbre: 30, checkinFecha: 15 };

  // Segunda-feira, 22/09/2026. As horas abaixo são de São Paulo (UTC-3).
  const emSP = (hhmm) => new Date(`2026-09-21T${hhmm}:00-03:00`);

  test("fora do dia da semana, a aula não é hoje", () => {
    const { model } = monta();
    // Domingo.
    const r = model.estadoAgora(AULA, new Date("2026-09-20T07:00:00-03:00"), SP);

    assert.equal(r.hoje, false);
    assert.equal(r.aberta, false);
  });

  test("antes de a janela abrir, fechada", () => {
    const { model } = monta();
    assert.equal(model.estadoAgora(AULA, emSP("06:29"), SP).aberta, false);
  });

  test("no minuto em que abre, aberta", () => {
    const { model } = monta();
    assert.equal(model.estadoAgora(AULA, emSP("06:30"), SP).aberta, true);
  });

  test("no atraso tolerado, ainda aberta", () => {
    const { model } = monta();
    assert.equal(model.estadoAgora(AULA, emSP("07:15"), SP).aberta, true);
  });

  test("um minuto depois, fechada — quem chegou é visita, não presença", () => {
    const { model } = monta();
    assert.equal(model.estadoAgora(AULA, emSP("07:16"), SP).aberta, false);
  });

  test("o FUSO da conta é que manda", () => {
    // O mesmo instante: 07:00 em São Paulo são 06:00 em Manaus. A aula das
    // 07:00 de Manaus ainda nem abriu.
    const { model } = monta();
    const instante = emSP("07:00");

    assert.equal(model.estadoAgora(AULA, instante, SP).aberta, true);
    assert.equal(model.estadoAgora(AULA, instante, "America/Manaus").aberta, false);
  });

  test("o DIA vem no fuso da conta, e é a chave do check-in", () => {
    // 22h de segunda em São Paulo é terça em UTC. Gravar o check-in no dia de
    // UTC poria a presença no dia errado — e "quem veio hoje?" é pergunta de
    // calendário.
    const { model } = monta();
    const noite = new Date("2026-09-21T22:30:00-03:00");

    assert.equal(model.estadoAgora({ dias: [1] }, noite, SP).data, "2026-09-21");
  });

  test("diz QUANDO abre e QUANDO fecha, em hora de relógio", () => {
    // A tela mostra "das 06:30 às 07:15" sem refazer a conta — refazê-la em
    // dois lugares é diverger em um deles.
    const { model } = monta();
    const r = model.estadoAgora(AULA, emSP("06:00"), SP);

    assert.equal(r.abreEm, "06:30");
    assert.equal(r.fechaEm, "07:15");
  });
}
