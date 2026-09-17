const test = require("node:test");
const assert = require("node:assert/strict");

const recorrencia = require("../../lib/recorrencia.js");

// A ARITMÉTICA DA RECORRÊNCIA.
//
// É onde mora o risco desta funcionalidade. Errar aqui não estoura: produz uma
// cobrança com a data errada, que alguém vai pagar ou reclamar meses depois.

const dia = (d) => d.toISOString().slice(0, 10);
const datas = (inicio, cadencia, quantas) =>
  Array.from({ length: quantas }, (_, k) => dia(recorrencia.ocorrencia(inicio, cadencia, k)));

test("a data é contada SEMPRE do início, e por isso o dia volta depois de fevereiro", () => {
  // O defeito que isto impede: somar um mês à ocorrência ANTERIOR faz a data
  // andar para trás e nunca mais voltar — 31/01 → 28/02 → 28/03 → 28/04. Quem
  // contratou "todo dia 31" passaria a ser cobrado dia 28 para sempre.
  assert.deepEqual(datas("2026-01-31", "monthly", 6), [
    "2026-01-31",
    "2026-02-28",
    "2026-03-31",
    "2026-04-30",
    "2026-05-31",
    "2026-06-30",
  ]);
});

test("ano bissexto: 29 de fevereiro existe em 2028", () => {
  assert.deepEqual(datas("2028-01-31", "monthly", 2), ["2028-01-31", "2028-02-29"]);
});

test("o dia cede ao mês, e não transborda para o mês seguinte", () => {
  // Deixar o `Date` estourar sozinho daria 03/03 — uma cobrança de fevereiro
  // vencendo em março, que some do fechamento do mês.
  assert.equal(dia(recorrencia.ocorrencia("2026-01-31", "monthly", 1)).slice(5, 7), "02");
});

test("as sete cadências são unidade × passo, e a virada de ano acompanha", () => {
  assert.deepEqual(datas("2026-09-01", "weekly", 3), ["2026-09-01", "2026-09-08", "2026-09-15"]);
  assert.deepEqual(datas("2026-09-01", "biweekly", 3), ["2026-09-01", "2026-09-15", "2026-09-29"]);
  assert.deepEqual(datas("2026-11-10", "bimonthly", 3), ["2026-11-10", "2027-01-10", "2027-03-10"]);
  assert.deepEqual(datas("2026-11-10", "quarterly", 2), ["2026-11-10", "2027-02-10"]);
  assert.deepEqual(datas("2026-09-05", "semiannual", 3), ["2026-09-05", "2027-03-05", "2027-09-05"]);
  assert.deepEqual(datas("2026-03-05", "annual", 3), ["2026-03-05", "2027-03-05", "2028-03-05"]);
});

test("cadência desconhecida cai em mensal, em vez de estourar", () => {
  // O id vem do corpo de uma requisição. Uma cadência inventada não pode
  // derrubar a geração do financeiro de uma conta inteira.
  assert.equal(recorrencia.normalizar("quinzenal-e-meio"), "monthly");
  assert.equal(dia(recorrencia.ocorrencia("2026-09-05", "inexistente", 1)), "2026-10-05");
});

test("a etiqueta é o VENCIMENTO, e é ela que torna a geração idempotente", () => {
  // O vencimento e não o número da ocorrência: mudar a cadência renumeraria
  // todas, e o que já foi gerado nasceria de novo com outro número.
  assert.equal(recorrencia.etiqueta(new Date("2026-09-05T00:00:00.000Z")), "2026-09-05");
  // A hora não entra: vencimento é DIA, como em toda cobrança deste sistema.
  assert.equal(recorrencia.etiqueta("2026-09-05T23:40:00.000Z"), "2026-09-05");
});

test("gera até a antecedência, e nem um vencimento além dela", () => {
  // Hoje 17/09; a janela vai até 02/10. A de 05/10 fica para outra passada —
  // senão uma anuidade passaria doze meses pendurada no "a receber".
  const saida = recorrencia.pendentes({
    inicio: "2026-07-05",
    cadencia: "monthly",
    hoje: new Date("2026-09-17T12:00:00.000Z"),
  });

  assert.deepEqual(saida.map((x) => x.etiqueta), ["2026-07-05", "2026-08-05", "2026-09-05"]);
});

test("o que já nasceu não nasce de novo", () => {
  const saida = recorrencia.pendentes({
    inicio: "2026-07-05",
    cadencia: "monthly",
    hoje: new Date("2026-09-17T12:00:00.000Z"),
    jaGeradas: new Set(["2026-07-05", "2026-08-05"]),
  });

  assert.deepEqual(saida.map((x) => x.etiqueta), ["2026-09-05"]);
});

test("a data de FIM corta a série", () => {
  const saida = recorrencia.pendentes({
    inicio: "2026-07-05",
    fim: "2026-08-31",
    cadencia: "monthly",
    hoje: new Date("2026-09-17T12:00:00.000Z"),
  });

  assert.deepEqual(saida.map((x) => x.etiqueta), ["2026-07-05", "2026-08-05"]);
});

test("um início muito antigo não despeja setenta cobranças de uma vez", () => {
  // Quase sempre é engano de digitação, e a surpresa seria cara de desfazer. O
  // teto para em 24 e a próxima leitura continua de onde parou.
  const saida = recorrencia.pendentes({
    inicio: "2018-01-10",
    cadencia: "monthly",
    hoje: new Date("2026-09-17T12:00:00.000Z"),
  });

  assert.equal(saida.length, recorrencia.TETO_POR_PASSADA);
  assert.equal(saida[0].etiqueta, "2018-01-10");
});

test("recorrência que ainda não começou não gera nada", () => {
  const saida = recorrencia.pendentes({
    inicio: "2027-01-05",
    cadencia: "monthly",
    hoje: new Date("2026-09-17T12:00:00.000Z"),
  });

  assert.deepEqual(saida, []);
});

test("data de início inválida devolve lista vazia, e não uma data inventada", () => {
  // `new Date(null)` é 01/01/1970, e não data inválida. Sem a guarda, uma
  // recorrência sem início geraria as 24 primeiras mensalidades de 1970 na
  // primeira abertura do financeiro. Este caso achou o defeito.
  for (const ruim of ["não é data", null, undefined, "", false]) {
    assert.deepEqual(
      recorrencia.pendentes({ inicio: ruim, cadencia: "monthly" }),
      [],
      `${JSON.stringify(ruim)} não pode virar data`
    );
  }

  assert.equal(recorrencia.diaUTC(null), null);
  assert.equal(recorrencia.ocorrencia(null, "monthly", 3), null);
});

test("o catálogo viaja com o rótulo já traduzido", () => {
  // A tela não conhece nenhuma cadência: acrescentar "quadrimestral" é uma linha
  // em `lib/recorrencia.js`, e o seletor ganha a opção sem mudar de linha.
  const lista = recorrencia.paraTela((k) => `[${k}]`);

  assert.equal(lista.length, recorrencia.IDS.length);
  assert.deepEqual(lista[0], {
    id: "weekly",
    label: "[finance.every.weekly]",
    unidade: "semana",
    passo: 1,
  });
});

test("a conta é em UTC — a hora local não pode empurrar o vencimento", () => {
  // Uma recorrência cadastrada às 21h em São Paulo começaria no dia seguinte se
  // a conta fosse feita no fuso da máquina.
  assert.equal(dia(recorrencia.ocorrencia("2026-09-05T23:59:00.000Z", "monthly", 0)), "2026-09-05");
  assert.equal(dia(recorrencia.diaUTC("2026-09-05T23:59:00.000Z")), "2026-09-05");
});
