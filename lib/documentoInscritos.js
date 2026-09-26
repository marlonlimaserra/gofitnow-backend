const { rotulos } = require("./rotulosDeDocumento.js");
const { TINTA, FRACO, escapar, formatarDataHora, cartoes, secao, pagina } = require("./documentoBase.js");

// A LISTA DE INSCRITOS DE UM AULÃO — a folha para levar na porta da aula.
//
// *"faltou o exportar xlsx e imprimir lista"* no app (23/09/2026).
//
// ── POR QUE ELA NASCE NO SERVIDOR ─────────────────────────────────────────
//
// No painel a folha é uma ROTA de tela (`/imprimir/aulao/:id`): o Ctrl+P do
// navegador resolve o papel e o "salvar em PDF". No celular não existe Ctrl+P
// nem impressora ligada — o app precisa de um ARQUIVO para entregar à folha de
// compartilhar do sistema.
//
// É a mesma decisão da folha de ponto, e pelo mesmo motivo: os dois mundos
// mandam o MESMO papel para quem recebe.
//
// ── A COLUNA DE ASSINATURA É O PONTO ──────────────────────────────────────
//
// Sem ela esta folha não valeria a impressão: a presença se marca na porta, à
// caneta, e depois se lança no sistema. Uma lista sem onde escrever obrigaria
// a virar a folha.
function documentoInscritos({
  aulao,
  inscritos = [],
  recorte = "",
  lang = "pt-BR",
  fuso,
  marca = null,
  emitidoEm = new Date(),
}) {
  const t = rotulos(lang);

  // PAGO é uma soma, e não o campo `status`: quem pagou metade tem cobrança
  // aberta e não entra entre os pagos. Aulão de graça não tem cobrança nenhuma
  // — e aí todo mundo conta como pago, porque não há nada a receber.
  const pagou = (p) => !p.cobranca || (p.cobranca.falta || 0) === 0;
  const temPreco = (aulao?.priceCents || 0) > 0;

  const celula = (conteudo, extra = "") =>
    `<td style="padding:9px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;${extra}">${conteudo}</td>`;

  const linhas = inscritos
    .map(
      (p) => `
      <tr>
        ${celula(`<strong>${escapar(p.name || "—")}</strong>`)}
        ${celula(escapar(p.phone || "—"), `color:${FRACO};`)}
        ${temPreco ? celula(pagou(p) ? t("aulao.paidYes") : t("aulao.paidNo"), `color:${FRACO};`) : ""}
        ${celula('<span style="display:block;height:18px;border-bottom:1px dotted #cbd5e1;"></span>')}
      </tr>`
    )
    .join("");

  const cabecalhoDaTabela = `
    <tr>
      ${[t("aulao.colName"), t("aulao.colPhone"), ...(temPreco ? [t("aulao.colPaid")] : []), t("aulao.colSignature")]
        .map(
          (c) =>
            `<th style="padding:0 8px 8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${FRACO};border-bottom:1px solid #cbd5e1;">${escapar(c)}</th>`
        )
        .join("")}
    </tr>`;

  const tabela = inscritos.length
    ? `<table style="width:100%;border-collapse:collapse;">
         <thead>${cabecalhoDaTabela}</thead>
         <tbody>${linhas}</tbody>
       </table>`
    : `<p style="margin:0;font-size:13px;color:${FRACO};">${escapar(t("aulao.printEmpty"))}</p>`;

  const pagos = inscritos.filter(pagou).length;

  const corpo = [
    cartoes([
      [t("aulao.colName"), String(inscritos.length)],
      temPreco ? [t("aulao.paidYes"), `${pagos}/${inscritos.length}`] : null,
    ]),
    // O RECORTE vai impresso: uma folha com dez nomes e sem essa linha não
    // deixa ninguém saber se faltou gente ou se o filtro estava ligado — e a
    // folha circula longe da tela que a gerou.
    recorte
      ? `<p style="margin:14px 0 0;font-size:11px;color:${FRACO};">${escapar(recorte)}</p>`
      : "",
    secao("", tabela),
  ].join("");

  const quando = aulao?.startsAt ? formatarDataHora(aulao.startsAt, lang, fuso) : "";

  return pagina({
    lang,
    titulo: t("aulao.printTitle"),
    nome: aulao?.name || "",
    subtitulo: [quando, aulao?.address].filter(Boolean).join(" · "),
    corpo,
    rodape: `${escapar(t("aulao.printTitle"))} · ${escapar(formatarDataHora(emitidoEm, lang, fuso))}`,
    marca,
  });
}

// A MESMA lista em planilha — a que soma.
//
// O `exceljs` entra só quando alguém pede: a máquina tem 903 MB e três Node em
// cima dela, e uma biblioteca de planilha carregada no boot é memória parada o
// mês inteiro por causa de um botão.
//
// As colunas passam do que o papel mostra: e-mail, quando se inscreveu e os
// dois valores separados. No papel eles seriam colunas a mais numa folha que já
// é larga; na planilha são o que se soma.
async function planilhaDeInscritos({ aulao, inscritos = [], lang = "pt-BR" }) {
  const ExcelJS = require("exceljs");
  const t = rotulos(lang);

  const book = new ExcelJS.Workbook();
  book.creator = "VAFIT";
  book.created = new Date();

  const aba = book.addWorksheet(t("aulao.printTitle"));
  const temPreco = (aulao?.priceCents || 0) > 0;

  aba.columns = [
    { header: t("aulao.colName"), key: "nome", width: 30 },
    { header: t("aulao.colPhone"), key: "fone", width: 18 },
    { header: t("auth.email"), key: "email", width: 28 },
    { header: t("aulao.colPresence"), key: "presenca", width: 14 },
    ...(temPreco
      ? [
          { header: t("aulao.colPaid"), key: "pagou", width: 10 },
          { header: t("aulao.totalPaid"), key: "pago", width: 14 },
          { header: t("aulao.totalDue"), key: "falta", width: 14 },
        ]
      : []),
    { header: t("aulao.printSince"), key: "desde", width: 18 },
  ];

  aba.getRow(1).font = { bold: true };
  aba.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  aba.views = [{ state: "frozen", ySplit: 1 }];

  for (const p of inscritos) {
    aba.addRow({
      nome: p.name || "",
      fone: p.phone || "",
      email: p.email || "",
      // As três respostas, e a terceira não é "não": ninguém conferiu ainda.
      presenca: p.presente === true ? t("aulao.paidYes") : p.presente === false ? t("aulao.paidNo") : "",
      ...(temPreco
        ? {
            pagou: !p.cobranca || (p.cobranca.falta || 0) === 0 ? t("aulao.paidYes") : t("aulao.paidNo"),
            // Em REAIS e não em centavos: a planilha é lida fora do sistema, e
            // "2500" onde se esperava 25,00 estraga toda soma feita por cima.
            pago: p.cobranca ? (p.cobranca.pago || 0) / 100 : "",
            falta: p.cobranca ? (p.cobranca.falta || 0) / 100 : "",
          }
        : {}),
      // `Date` e não texto: data como texto não ordena nem entra em conta no
      // Excel.
      desde: p.desde ? new Date(p.desde) : "",
    });
  }

  return book.xlsx.writeBuffer();
}

module.exports = { documentoInscritos, planilhaDeInscritos, TINTA };
