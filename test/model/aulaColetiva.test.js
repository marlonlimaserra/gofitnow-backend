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

const UM = [{ inicio: "07:30", fim: "08:20" }];

test("o horário vira MINUTOS, e guarda início e FIM", async () => {
  // *"permita escolher os horários manualmente início e fim"*. Duração era uma
  // conta que a pessoa fazia de cabeça: quem monta grade pensa "das 7 às
  // 7h50", não "50 minutos".
  const { model, gravados } = monta();

  await model.insert({ name: "Spinning", horarios: UM, dias: [1, 3, 5] });

  assert.deepEqual(gravados[0].horarios, [{ inicio: 450, fim: 500 }]);
});

test("VÁRIOS horários na mesma aula, ordenados pelo relógio", async () => {
  // *"aí posso ir adicionando vários"*. Spinning às 07:00 e às 18:00 é a MESMA
  // aula — cadastrar duas daria dois nomes e duas descrições para manter
  // iguais. E uma grade fora de ordem de relógio não é uma grade.
  const { model, gravados } = monta();

  await model.insert({
    name: "Spinning",
    dias: [1],
    horarios: [
      { inicio: "18:00", fim: "18:50" },
      { inicio: "07:00", fim: "07:50" },
    ],
  });

  assert.deepEqual(gravados[0].horarios, [
    { inicio: 420, fim: 470 },
    { inicio: 1080, fim: 1130 },
  ]);
});

test("horário repetido entra uma vez só", async () => {
  // Duas linhas idênticas na mesma aula são duas que ninguém consegue
  // distinguir para apagar.
  const { model, gravados } = monta();

  await model.insert({
    name: "X",
    dias: [1],
    horarios: [
      { inicio: "07:00", fim: "07:50" },
      { inicio: "07:00", fim: "07:50" },
    ],
  });

  assert.equal(gravados[0].horarios.length, 1);
});

test("fim ANTES do início é descartado, e não vira janela negativa", async () => {
  const { model } = monta();

  assert.equal(
    await model.insert({ name: "X", dias: [1], horarios: [{ inicio: "08:00", fim: "07:00" }] }),
    null
  );
  assert.equal(
    await model.insert({ name: "X", dias: [1], horarios: [{ inicio: "08:00", fim: "08:00" }] }),
    null
  );
});

test("sem nome, sem horário ou sem dia NÃO existe aula", async () => {
  // Ela nunca aconteceria, e uma linha assim na grade é só confusão.
  const { model, gravados } = monta();

  assert.equal(await model.insert({ horarios: UM, dias: [1] }), null);
  assert.equal(await model.insert({ name: "X", dias: [1] }), null);
  assert.equal(await model.insert({ name: "X", horarios: UM, dias: [] }), null);
  assert.equal(gravados.length, 0);
});

test("hora inválida é descartada, e não vira meia-noite", async () => {
  // `"25:00"` virando 0 marcaria a aula para a madrugada sem ninguém pedir.
  const { model } = monta();

  for (const ruim of ["25:00", "07:70", "sete", "", "7h"]) {
    const r = await model.insert({
      name: "X",
      dias: [1],
      horarios: [{ inicio: ruim, fim: "09:00" }],
    });
    assert.equal(r, null, String(ruim));
  }
});

test("os dias saem ordenados e sem repetição", async () => {
  const { model, gravados } = monta();

  await model.insert({ name: "X", horarios: UM, dias: [5, 1, 1, 9, "3", -2] });

  assert.deepEqual(gravados[0].dias, [1, 3, 5]);
});

test("a janela de check-in é RELATIVA ao início, e tem padrão", async () => {
  // "Abre 30 minutos antes" continua valendo quando a aula muda de 07:00 para
  // 08:00; "abre às 06:30" viraria uma janela errada calada.
  const { model, gravados } = monta();

  await model.insert({ name: "X", horarios: UM, dias: [1] });
  await model.insert({ name: "Y", horarios: UM, dias: [1], checkinAbre: 60, checkinFecha: 5 });

  assert.equal(gravados[0].checkinAbre, 30);
  assert.equal(gravados[0].checkinFecha, 15);
  assert.equal(gravados[1].checkinAbre, 60);
  assert.equal(gravados[1].checkinFecha, 5);
});

test("editar não pode deixar a aula sem hora nem sem dia", async () => {
  // Seria apagá-la pela metade: ela continuaria na lista sem nunca acontecer.
  const { model } = monta();

  assert.equal(await model.update("6a80de570056d24c09f5da61", { horarios: [] }), false);
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
  const AULA = {
    dias: [1],
    horarios: [
      { inicio: 7 * 60, fim: 7 * 60 + 50 },
      { inicio: 18 * 60, fim: 18 * 60 + 50 },
    ],
    checkinAbre: 30,
    checkinFecha: 15,
  };

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

    assert.equal(r.horarios[0].abreEm, "06:30");
    assert.equal(r.horarios[0].fechaEm, "07:15");
  });

  test("CADA horário tem a sua janela — só o da vez abre", () => {
    // Às 07:10 a aula está aberta, mas é a das 07:00. Sem dizer QUAL, a tela
    // confirmaria presença na aula da manhã às seis da tarde.
    const { model } = monta();
    const r = model.estadoAgora(AULA, emSP("07:10"), SP);

    assert.equal(r.aberta, true);
    assert.equal(r.horarios[0].aberta, true);
    assert.equal(r.horarios[1].aberta, false);
  });

  test("entre os dois, a aula está fechada", () => {
    const { model } = monta();
    const r = model.estadoAgora(AULA, emSP("12:00"), SP);

    assert.equal(r.aberta, false);
    assert.ok(r.horarios.every((h) => !h.aberta));
  });

  test("e o horário mostra o FIM, que é o que se confere na grade", () => {
    const { model } = monta();
    const r = model.estadoAgora(AULA, emSP("06:00"), SP);

    assert.equal(r.horarios[0].inicio, "07:00");
    assert.equal(r.horarios[0].fim, "07:50");
  });
}

// ── UM POR DIA, OU VÁRIOS ───────────────────────────────────────────────
//
// *"coloque a opção permite inscrição em mais um horário sim/não. Se por não,
// o usuário só pode se inscrever uma vez por dia"*.
test("o padrão é NÃO permitir vários horários", async () => {
  // É o caso comum: quem faz spinning às 07:00 não faz de novo às 18:00, e uma
  // vaga ocupada duas vezes pela mesma pessoa é uma vaga que faltou para
  // outra.
  const { model, gravados } = monta();

  await model.insert({ name: "X", dias: [1], horarios: UM });
  await model.insert({ name: "Y", dias: [1], horarios: UM, variosHorarios: true });

  assert.equal(gravados[0].variosHorarios, false);
  assert.equal(gravados[1].variosHorarios, true);
});

test("o nome do campo é a RESPOSTA, e não a pergunta", async () => {
  // `variosHorarios: false` se lê sozinho. `umPorDia: true` diria a mesma
  // coisa invertida, e é assim que se troca o sentido de uma regra sem
  // perceber.
  const { model, gravados } = monta();

  await model.insert({ name: "X", dias: [1], horarios: UM, variosHorarios: "sim" });

  // Só o booleano verdadeiro conta: uma string qualquer não é um "sim".
  assert.equal(gravados[0].variosHorarios, false);
});
