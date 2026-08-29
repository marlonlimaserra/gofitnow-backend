// AS PEÇAS COMUNS DOS DOCUMENTOS — avaliação física e plano alimentar.
//
// Existe porque os dois são a MESMA folha com conteúdo diferente: mesmo papel,
// mesmo cabeçalho, mesmas regras de escape e de data. Copiar isto no segundo
// gerador garantiria que um dia só um dos dois ganhasse a correção — e o defeito
// mais provável aqui (data no fuso errado, texto não escapado) é justamente o
// tipo que não aparece em teste de tela.
//
// ── AS REGRAS QUE ESTE ARQUIVO CARREGA ────────────────────────────────────
//
// AUTOSSUFICIENTE: nada de `<link>`, `<script>` ou `src` externo. O documento é
// o mesmo nas quatro saídas (ver, imprimir, PDF, e-mail), e um HTML que precisa
// buscar arquivo não sobrevive a nenhuma delas — o cliente de e-mail bloqueia, o
// `expo-print` não tem origem, e salvo em disco vira folha sem foto.
//
// ESTILO INLINE: cliente de e-mail remove `<style>`. A saída de regra mais dura
// manda em todas.
//
// TABELA, NÃO FLEX: cliente de e-mail antigo não implementa nenhum dos dois, e a
// folha sairia com tudo empilhado.

// Papel: fundo branco, tipo escuro, sem bloco grande de cor sólida — cor sólida
// em área grande gasta tinta e sai cinza sujo em impressora preto e branco.
const TINTA = "#0f172a";
const FRACO = "#64748b";
const LINHA = "#e2e8f0";

// O que a pessoa recebe pode ir para qualquer lugar, então nada do que vem do
// banco entra no HTML sem passar por aqui. Nome com `<` quebraria a folha; nome
// com `<script>` seria pior.
function escapar(valor) {
  return String(valor == null ? "" : valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function numero(valor, sufixo = "") {
  return typeof valor === "number" && Number.isFinite(valor) ? `${valor}${sufixo}` : "—";
}

// A data no fuso da CONTA, não no do servidor.
//
// O servidor roda em UTC. Sem o fuso, uma coleta das 21h de São Paulo sai com a
// data do dia seguinte — e a folha que a pessoa leva para casa mostra um dia que
// ela não veio.
function formatarData(valor, lang, fuso) {
  if (!valor) return "";
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return "";

  // Meia-noite UTC quer dizer DIA, e não instante: formatar em UTC evita que o
  // fuso empurre a data. Ver a mesma regra em `campos.js` no site (`ehSoDia`).
  const soDia = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;

  return d.toLocaleDateString(lang, {
    timeZone: soDia ? "UTC" : fuso || "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function secao(titulo, conteudo) {
  if (!conteudo) return "";
  return `
    <section style="margin-top:22px;">
      <h2 style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${FRACO};">${escapar(titulo)}</h2>
      ${conteudo}
    </section>`;
}

// Cartões de número — os resultados da avaliação, os totais do dia na dieta.
function cartoes(itens) {
  const vivos = itens.filter(Boolean);
  if (!vivos.length) return "";

  const largura = Math.floor(100 / vivos.length);

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:8px 0;">
    <tr>${vivos
      .map(
        ([rotulo, valor]) => `<td width="${largura}%" style="border:1px solid ${LINHA};border-radius:8px;padding:10px;">
            <div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:${FRACO};">${escapar(rotulo)}</div>
            <div style="margin-top:2px;font-size:17px;font-weight:700;color:${TINTA};">${escapar(valor)}</div>
          </td>`
      )
      .join("")}</tr>
  </table>`;
}

// A PÁGINA. Quem chama entrega o miolo pronto; daqui sai o documento inteiro.
function pagina({ lang, titulo, nome, subtitulo, corpo, rodape, marca = null }) {
  return `<!doctype html>
<html lang="${escapar(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(nome || "")} — ${escapar(titulo)}</title>
</head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${TINTA};">
<div style="max-width:760px;margin:0 auto;">

  <div style="padding-bottom:14px;border-bottom:1px solid #cbd5e1;">
    ${marca ? `<img src="${escapar(marca)}" alt="" style="max-height:44px;max-width:170px;display:block;margin-bottom:10px;" />` : ""}
    <h1 style="margin:0;font-size:19px;font-weight:800;">${escapar(nome || "")}</h1>
    <div style="margin-top:2px;font-size:13px;color:${FRACO};">${escapar(subtitulo)}</div>
  </div>

  ${corpo}

  <div style="margin-top:32px;padding-top:12px;border-top:1px solid ${LINHA};text-align:center;font-size:11px;color:#94a3b8;">
    ${escapar(rodape)}
  </div>
</div>
</body>
</html>`;
}

module.exports = { TINTA, FRACO, LINHA, escapar, numero, formatarData, secao, cartoes, pagina };
