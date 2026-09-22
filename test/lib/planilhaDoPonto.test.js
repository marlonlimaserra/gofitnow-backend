const test = require("node:test");
const assert = require("node:assert");
const ExcelJS = require("exceljs");

const { planilhaDoPonto, nomeDaPlanilha } = require("../../lib/planilhaDoPonto.js");

// A FOLHA DE PONTO EM PLANILHA, montada no servidor.
//
// Ela existe para o CELULAR: não há biblioteca de xlsx que caiba no aplicativo,
// e o painel gera a dele no navegador. As duas escrevem a mesma planilha — quem
// exporta do tablet e quem exporta do computador manda o mesmo arquivo para o
// contador.
//
// O arquivo é lido de VOLTA aqui: o defeito que mais assusta neste tipo de
// exportação só aparece na hora de gravar (nome de aba recusado pelo Excel,
// célula com tipo que o exceljs não aceita).
const FUNCIONARIO = { name: "Bruna Lima", role: "Recepção" };

const DIAS = [
  {
    dia: "2026-09-01",
    semana: 2,
    batidas: [{ entrada: "08:00", saida: "12:00" }],
    minutos: 240,
    falta: false,
    abonado: false,
    observacao: "",
    aberto: false,
  },
  {
    dia: "2026-09-02",
    semana: 3,
    batidas: [],
    minutos: 0,
    falta: true,
    abonado: true,
    observacao: "Atestado entregue",
    aberto: false,
  },
];

async function gerar(extra = {}) {
  const bytes = await planilhaDoPonto({
    funcionario: FUNCIONARIO,
    mes: "2026-09",
    dias: DIAS,
    resumo: { previsto: 1131 },
    ...extra,
  });

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book.worksheets[0];
}

const textos = (linha) => linha.values.slice(1).map((v) => (v == null ? "" : String(v)));

test("a aba leva o nome do mês, e não 'Planilha1'", async () => {
  const aba = await gerar();
  assert.match(aba.name, /setembro.*2026/i);
});

test("a tabela começa na LINHA 1, com os títulos", async () => {
  // Texto acima dos títulos quebra ordenar, filtrar e colar — a lição que a
  // planilha da chamada já pagou.
  const aba = await gerar();

  assert.deepEqual(textos(aba.getRow(1)), [
    "Dia",
    "Dia da semana",
    "Entrada 1",
    "Saída 1",
    "Total",
    "Situação",
    "Observação",
  ]);
});

test("o dia vai como DATA, e o total como DURAÇÃO somável", async () => {
  const aba = await gerar();

  const dia = aba.getRow(2).getCell(1).value;
  assert.ok(dia instanceof Date);
  assert.equal(dia.toISOString().slice(0, 10), "2026-09-01");

  // Na volta o exceljs devolve a duração como Date — é o que ele faz com todo
  // número que tem formato de hora. O que importa é a duração sobreviver à ida
  // e à volta: 4 horas contadas da época do Excel (30/12/1899).
  const total = aba.getRow(2).getCell(5).value;
  const emHoras =
    total instanceof Date ? (total.getTime() - Date.UTC(1899, 11, 30)) / 3600000 : total * 24;

  assert.ok(Math.abs(emHoras - 4) < 0.001, `esperava 4h, veio ${emHoras}`);
  assert.equal(aba.getColumn(5).numFmt, "[h]:mm");
});

test("a situação vira palavra, e a observação vai junto", async () => {
  const aba = await gerar();

  assert.equal(aba.getRow(3).getCell(6).value, "Falta justificada");
  assert.equal(aba.getRow(3).getCell(7).value, "Atestado entregue");
});

test("as colunas de batida seguem o MÊS, e não o teto do servidor", async () => {
  const aba = await gerar({
    dias: [
      {
        ...DIAS[0],
        batidas: [
          { entrada: "08:00", saida: "12:00" },
          { entrada: "14:00", saida: "18:00" },
        ],
      },
    ],
  });

  const titulos = textos(aba.getRow(1));
  assert.ok(titulos.includes("Entrada 2"));
  assert.ok(!titulos.includes("Entrada 3"));
});

test("o resumo fica no PÉ, depois de uma linha em branco", async () => {
  const aba = await gerar();

  assert.equal(aba.getRow(4).values.filter(Boolean).length, 0);
  assert.deepEqual(
    [5, 6, 7, 8].map((n) => textos(aba.getRow(n)).slice(0, 2)),
    [
      ["Trabalhado", "4h"],
      ["Previsto", "18h51"],
      ["Saldo", "−14h51"],
      ["Faltas", "1"],
    ]
  );
});

test("em inglês, os títulos e a data mudam junto", async () => {
  const aba = await gerar({ lang: "en" });

  assert.equal(textos(aba.getRow(1))[0], "Day");
  assert.equal(aba.getColumn(1).numFmt, "mm/dd/yyyy");
});

test("mês sem lançamento nenhum ainda gera arquivo", async () => {
  // Uma promessa quebrada aqui é a pior: o botão pisca e nada baixa.
  const aba = await gerar({ dias: [], resumo: {} });
  assert.ok(aba.getRow(1).values.length > 1);
});

test("o nome do arquivo sobrevive a WhatsApp e pen drive", () => {
  assert.equal(nomeDaPlanilha("Bruna Lima", "2026-09"), "folha-de-ponto-bruna-lima-2026-09.xlsx");
  assert.equal(nomeDaPlanilha("Aparício/Souza", "2026-09"), "folha-de-ponto-aparicio-souza-2026-09.xlsx");
  assert.equal(nomeDaPlanilha("", "2026-09"), "folha-de-ponto-2026-09.xlsx");
});
