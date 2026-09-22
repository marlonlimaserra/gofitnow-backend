const { rotulos } = require("./rotulosDeDocumento.js");
const { TINTA, FRACO, LINHA, escapar, cartoes, pagina, formatarDataHora } = require("./documentoBase.js");

// A FOLHA DE PONTO DE UM MÊS — o papel que se assina.
//
// *"no aplicativo não tem os botões de imprimir nem xlsx"*.
//
// ── POR QUE ELA NASCE NO SERVIDOR ─────────────────────────────────────────
//
// Pelo mesmo motivo da avaliação e do extrato: o app não desenha documento. Ele
// pede o HTML pronto e entrega ao `expo-print`, que imprime ou vira PDF no
// próprio aparelho — e o mesmo HTML vai por e-mail. Três saídas, um desenho só.
//
// A folha do PAINEL continua sendo React (`views/funcionarios/FolhaImpressa.jsx`):
// lá ela abre num diálogo, com botões, dentro de uma tela que já tem o mês
// carregado. São duas implementações do mesmo papel, e o preço é conhecido —
// mudar o desenho pede mexer nas duas. O que não podia era o app não ter papel
// nenhum.
//
// ── AS REGRAS DA CASA PARA DOCUMENTO ─────────────────────────────────────
//
// Autossuficiente (foto e logo em `data:`), estilo inline, tabela em vez de
// flex. Ver `documentoBase.js` — as três vêm do cliente de e-mail, que é a
// saída de regra mais dura.
//
// ── ESTE MÓDULO NÃO FALA COM O BANCO ─────────────────────────────────────
//
// Entram dados prontos, sai texto. É o que o torna testável sem MongoDB, e é o
// contrato dos outros três documentos.
const CABECA = `font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${FRACO};padding:0 8px 6px;border-bottom:1px solid ${LINHA};`;
const CELULA = `font-size:12px;color:${TINTA};padding:6px 8px;border-bottom:1px solid #f1f5f9;vertical-align:middle;`;

// "7h20", e não "7.33h": a folha é lida por gente que pensa em horas e minutos.
// A mesma conta de `views/funcionarios/folha.js` no painel — se as duas
// discordarem, o papel discorda da tela que o mandou imprimir.
function horas(minutos) {
  const n = Math.max(0, Math.round(Number(minutos) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

// O nome curto do dia sai do `Intl`: são sete palavras que todo idioma já tem.
//
// `timeZone: "UTC"` porque "2026-09-19" é um CONTADOR DE DIAS, e não um
// instante: lido no fuso do servidor, ele vira o dia anterior a folha inteira.
function abreviado(dia, lang) {
  try {
    return new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" })
      .format(new Date(dia + "T00:00:00Z"))
      .replace(".", "");
  } catch (erro) {
    return "";
  }
}

function nomeDoMes(mes, lang) {
  const [ano, m] = String(mes || "").split("-").map(Number);
  if (!ano || !m) return "";
  try {
    return new Intl.DateTimeFormat(lang, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(ano, m - 1, 1)));
  } catch (erro) {
    return String(mes);
  }
}

// "10:00–12:00   14:00–18:00". O "…" marca a batida ABERTA: quem entrou e não
// bateu a saída aparece como "14:00–…", e não como um dia cheio.
function batidas(dia) {
  return (dia.batidas || [])
    .map((b) => `${b.entrada || "--:--"}–${b.saida || "…"}`)
    .join("   ");
}

// No papel não existe cor que sobreviva a uma impressora preto e branco: a
// linha vermelha da tela vira PALAVRA.
function situacao(t, dia) {
  if (dia.falta) return t(dia.abonado ? "employees.excusedLabel" : "employees.absence");
  if (dia.aberto) return t("employees.openPunch");
  return "";
}

// Os rótulos do depósito não interpolam (ver `rotulosDeDocumento.js`): a chave
// volta com `{{dia}}` dentro, e quem sabe o valor é quem chama.
function comValor(texto, valores) {
  return Object.entries(valores).reduce(
    (acc, [chave, valor]) => acc.split(`{{${chave}}}`).join(valor),
    String(texto || "")
  );
}

function documentoPonto({
  funcionario,
  mes,
  dias = [],
  resumo = {},
  foto = null,
  lang = "pt-BR",
  fuso = "UTC",
  marca = null,
  emitidoEm = new Date(),
}) {
  const t = rotulos(lang);

  const trabalhado = dias.reduce((n, d) => n + (d.minutos || 0), 0);
  const previsto = resumo.previsto || 0;
  const saldo = trabalhado - previsto;
  const faltas = dias.filter((d) => d.falta).length;

  // ── A FICHA: foto à esquerda, contato à direita ─────────────────────────
  //
  // *"no pdf faltou a foto da pessoa"*, *"também faltou pôr o whatsapp para
  // facilitar"*. O papel circula na mão de quem confere e de quem assina: o
  // rosto diz de quem é a folha, e o número evita voltar ao sistema para
  // perguntar uma hora. Sem foto a coluna some — um quadrado cinza é pior que
  // nada.
  const contato = [funcionario?.role, funcionario?.whatsapp].filter(Boolean).join(" · ");

  const ficha =
    foto || contato
      ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:18px;">
          <tr>
            ${
              foto
                ? `<td valign="middle" width="1" style="padding-right:12px;">
                     <img src="${escapar(foto)}" alt="" width="64" height="64" style="width:64px;height:64px;border-radius:8px;border:1px solid ${LINHA};display:block;object-fit:cover;" />
                   </td>`
                : ""
            }
            <td valign="middle" style="font-size:12px;color:${FRACO};">${escapar(contato)}</td>
          </tr>
        </table>`
      : "";

  const linhas = dias
    .map((d) => {
      // O fim de semana é uma LINHA MAIS CLARA, e não um fundo: navegador não
      // imprime cor de fundo por padrão, e a faixa sumiria justo no papel.
      const fimDeSemana = d.semana === 0 || d.semana === 6;
      const cor = fimDeSemana ? FRACO : TINTA;

      return `<tr>
        <td style="${CELULA};color:${cor};white-space:nowrap;">
          <strong>${escapar(d.dia.slice(8))}</strong>
          <span style="color:${FRACO};font-size:10px;text-transform:uppercase;">&nbsp;${escapar(abreviado(d.dia, lang))}</span>
        </td>
        <td style="${CELULA};color:${cor};">
          ${escapar(batidas(d))}
          ${d.observacao ? `<div style="font-size:10px;color:${FRACO};">${escapar(d.observacao)}</div>` : ""}
        </td>
        <td style="${CELULA};text-align:center;white-space:nowrap;">${d.minutos ? escapar(horas(d.minutos)) : ""}</td>
        <td style="${CELULA};text-align:center;color:${FRACO};">${escapar(situacao(t, d))}</td>
        <td style="${CELULA};"><div style="border-bottom:1px dotted #cbd5e1;height:14px;"></div></td>
      </tr>`;
    })
    .join("");

  const tabela = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px;border-collapse:collapse;">
    <tr>
      <th align="left" style="${CABECA}">${escapar(t("employees.colDay"))}</th>
      <th align="left" style="${CABECA}">${escapar(t("employees.colPunches"))}</th>
      <th align="center" style="${CABECA};text-align:center;">${escapar(t("employees.colTotal"))}</th>
      <th align="center" style="${CABECA};text-align:center;">${escapar(t("employees.colStatus"))}</th>
      <th align="left" style="${CABECA};width:150px;">${escapar(t("employees.colSignature"))}</th>
    </tr>
    ${linhas}
  </table>`;

  // AS DUAS ASSINATURAS: a de quem cumpriu a jornada e a de quem responde pela
  // casa. É o que transforma o papel num documento.
  const assinaturas = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:44px;">
    <tr>
      <td width="50%" style="padding-right:24px;">
        <div style="border-top:1px solid #94a3b8;padding-top:5px;text-align:center;font-size:11px;color:${FRACO};">${escapar(t("employees.signEmployee"))}</div>
      </td>
      <td width="50%" style="padding-left:24px;">
        <div style="border-top:1px solid #94a3b8;padding-top:5px;text-align:center;font-size:11px;color:${FRACO};">${escapar(t("employees.signManager"))}</div>
      </td>
    </tr>
  </table>`;

  const corpo = [
    ficha,
    `<div style="margin-top:18px;"></div>`,
    cartoes([
      [t("employees.worked"), horas(trabalhado)],
      previsto > 0 ? [t("employees.expected"), horas(previsto)] : null,
      previsto > 0 ? [t("employees.balance"), (saldo >= 0 ? "+" : "−") + horas(Math.abs(saldo))] : null,
      [t("employees.absences"), String(faltas)],
    ]),
    tabela,
    assinaturas,
  ].join("");

  return pagina({
    lang,
    titulo: t("employees.tabTime"),
    nome: funcionario?.name || "",
    subtitulo: [t("employees.tabTime"), nomeDoMes(mes, lang)].filter(Boolean).join(" · "),
    corpo,
    rodape: comValor(t("employees.printedOn"), {
      dia: formatarDataHora(emitidoEm, lang, fuso),
    }),
    marca,
  });
}

module.exports = { documentoPonto, horas, abreviado, nomeDoMes, batidas, situacao };
