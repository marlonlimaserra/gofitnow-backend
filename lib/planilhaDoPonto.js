const { rotulos } = require("./rotulosDeDocumento.js");
const { horas, abreviado, nomeDoMes, situacao } = require("./documentoPonto.js");

// A FOLHA DE PONTO EM PLANILHA — a que soma.
//
// *"no aplicativo não tem os botões de imprimir nem xlsx"*.
//
// ── POR QUE ELA TAMBÉM NASCE NO SERVIDOR ─────────────────────────────────
//
// No painel a planilha é gerada no navegador (`views/funcionarios/planilhaDoPonto.js`,
// com o mesmo `exceljs`): lá o mês já está carregado e o arquivo cai na pasta
// de downloads. No celular não há pasta de downloads nem biblioteca de xlsx que
// caiba no aplicativo — o app pede os bytes e entrega ao compartilhar do
// sistema.
//
// As duas escrevem a MESMA planilha, e é de propósito: quem exporta do tablet e
// quem exporta do computador manda o mesmo arquivo para o contador.
//
// ── O `exceljs` ENTRA SÓ QUANDO ALGUÉM PEDE ──────────────────────────────
//
// `require` dentro da função. A máquina tem 903 MB e três Node em cima dela; uma
// biblioteca de planilha carregada no boot é memória parada o mês inteiro por
// causa de um botão que se aperta uma vez por mês.
const MAX_PARES = 6;

const FORMATO_DATA = { en: "mm/dd/yyyy" };

// Meio-dia UTC, e não meia-noite: se o Excel deslocar por fuso, um empurrão de
// até doze horas para qualquer lado ainda cai no mesmo dia.
function celulaDeData(dia) {
  const d = new Date(`${dia}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : d;
}

async function planilhaDoPonto({ funcionario, mes, dias = [], resumo = {}, lang = "pt-BR" }) {
  const ExcelJS = require("exceljs");
  const t = rotulos(lang);

  const book = new ExcelJS.Workbook();
  book.creator = "VAFIT";
  book.created = new Date();

  // O nome da ABA é o mês, e não "Planilha1": quem junta doze meses num arquivo
  // só fica com eles nomeados sozinhos.
  const rotulo = nomeDoMes(mes, lang);
  const aba = book.addWorksheet(rotulo.charAt(0).toUpperCase() + rotulo.slice(1));

  // A planilha não inventa coluna que o mês não usou: jornada direta sai com
  // duas colunas de horário, e não com doze onde dez estariam vazias.
  const pares = Math.min(MAX_PARES, Math.max(1, ...dias.map((d) => (d.batidas || []).length)));

  const colunasDeHora = [];
  for (let n = 1; n <= pares; n++) {
    colunasDeHora.push(
      { header: t("employees.colNthIn").replace("{{n}}", n), key: `e${n}`, width: 11 },
      { header: t("employees.colNthOut").replace("{{n}}", n), key: `s${n}`, width: 11 }
    );
  }

  aba.columns = [
    { header: t("employees.colDay"), key: "dia", width: 12 },
    { header: t("employees.colWeekday"), key: "semana", width: 9 },
    ...colunasDeHora,
    { header: t("employees.colTotal"), key: "total", width: 10 },
    { header: t("employees.colStatus"), key: "situacao", width: 18 },
    { header: t("employees.colDayNote"), key: "observacao", width: 44 },
  ];

  const titulos = aba.getRow(1);
  titulos.font = { bold: true };
  titulos.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  aba.views = [{ state: "frozen", ySplit: 1 }];

  for (const d of dias) {
    const horarios = {};
    (d.batidas || []).slice(0, pares).forEach((b, i) => {
      horarios[`e${i + 1}`] = b.entrada || "";
      horarios[`s${i + 1}`] = b.saida || "";
    });

    aba.addRow({
      dia: celulaDeData(d.dia),
      semana: abreviado(d.dia, lang),
      ...horarios,
      // O TOTAL vai como DURAÇÃO (fração de dia com formato `[h]:mm`), e não
      // como "6h20": a coluna soma, e a soma passa de 24h sem virar "2:20".
      // Texto seria bonito e inútil — somar é a razão de existir a planilha ao
      // lado do papel.
      total: d.minutos ? d.minutos / 1440 : null,
      situacao: situacao(t, d),
      observacao: d.observacao || "",
    });
  }

  aba.getColumn("dia").numFmt = FORMATO_DATA[String(lang).slice(0, 2)] || "dd/mm/yyyy";
  aba.getColumn("total").numFmt = "[h]:mm";
  aba.getColumn("total").alignment = { horizontal: "right" };

  // O RESUMO no pé, depois de uma linha em branco: uma tabela que começa na
  // linha 1 é uma tabela que se ordena, se filtra e se cola noutra, e texto
  // acima dela quebra as três. A linha em branco impede o Excel de engolir o
  // resumo ao selecionar a região da tabela.
  aba.addRow({});

  const linhaDeResumo = (nome, valor) => {
    const linha = aba.addRow({ dia: nome, semana: valor });
    linha.getCell(1).font = { bold: true };
  };

  const trabalhado = dias.reduce((n, d) => n + (d.minutos || 0), 0);
  const previsto = resumo.previsto || 0;

  linhaDeResumo(t("employees.worked"), horas(trabalhado));
  if (previsto > 0) {
    linhaDeResumo(t("employees.expected"), horas(previsto));
    linhaDeResumo(
      t("employees.balance"),
      (trabalhado - previsto >= 0 ? "+" : "−") + horas(Math.abs(trabalhado - previsto))
    );
  }
  linhaDeResumo(t("employees.absences"), String(dias.filter((d) => d.falta).length));

  return Buffer.from(await book.xlsx.writeBuffer());
}

// O nome viaja por WhatsApp, e-mail e pen drive — e cada um reescreve o que não
// entende. Sem acento, sem espaço, e o mês em AAAA-MM, que ordena sozinho na
// pasta de quem recebe.
function nomeDaPlanilha(nome, mes) {
  const limpo = String(nome || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

  return ["folha-de-ponto", limpo, mes].filter(Boolean).join("-") + ".xlsx";
}

module.exports = { planilhaDoPonto, nomeDaPlanilha };
