const calculos = require("./calculos.mjs");
// Espelhados do site pelo mesmo script. `grupos` diz quais medidas existem;
// `calculos`, o que elas viram.
const { GRUPOS } = require("./grupos.mjs");
const { rotulos } = require("./rotulosDeDocumento.js");
// As peças do papel (escape, data no fuso, seção, cartões, o esqueleto da
// página) moram na base porque o plano alimentar usa exatamente as mesmas.
const {
  TINTA, FRACO, LINHA, escapar, numero, formatarData, secao, cartoes: cartoesBase, pagina,
} = require("./documentoBase.js");

// O DOCUMENTO DA AVALIAÇÃO FÍSICA, em HTML, montado no servidor.
//
// ── Por que aqui e não na tela ────────────────────────────────────────────
//
// Pedido do Marlon: *"o ideal seria esse PDF ser um HTML gerado direto no
// backend, assim garantimos que vai ser igual no web e no app"*.
//
// Ele está certo, e o ganho é maior do que parece. Com o HTML nascendo num lugar
// só não existe "a versão do site" e "a versão do app" para divergirem — e o
// e-mail é literalmente este mesmo HTML. Um documento, quatro saídas:
//
//   ver        o navegador (ou o app) mostra este HTML
//   imprimir   Ctrl+P sobre ele
//   PDF        o servidor converte ESTE HTML (ver `pdfDoDocumento`)
//   e-mail     o corpo da mensagem é ele
//
// Também some o que o desenho anterior exigia: um Chromium para renderizar a
// página React e um token para esse Chromium se autenticar como o profissional.
// Aqui os dados já estão à mão.
//
// ── AUTOSSUFICIENTE, e isso é requisito ───────────────────────────────────
//
// Nada de `<link>`, nada de `<script>`, e as fotos entram como `data:` URI. Um
// HTML que depende de buscar arquivo não sobrevive a nenhuma das quatro saídas:
// no e-mail o cliente bloqueia, no `expo-print` não há origem, no PDF do servidor
// a imagem chegaria depois da conversão, e salvo em disco vira folha sem foto.
//
// ── Estilo INLINE, e o motivo é o e-mail ──────────────────────────────────
//
// Cliente de e-mail remove `<style>`. O documento é o mesmo nas quatro saídas, e
// a que tem a regra mais dura manda: tudo em `style=`.

// ── OS RESULTADOS, em cartões ─────────────────────────────────────────────
function cartoes(t, coleta, calc) {
  return cartoesBase([
    [t("assessments.weight"), numero(coleta.weight, " kg")],
    [t("assessments.bmi"), numero(calc?.imc)],
    [t("assessments.bodyFat"), numero(calc?.referencia, "%")],
    [t("assessments.whr"), numero(calc?.rcq)],
  ]);
}

// ── O COMPARATIVO com a coleta anterior ───────────────────────────────────
function comparativo(t, coleta, calc, anterior, calcAnterior, lang, fuso) {
  if (!anterior) return "";

  const linhas = [
    [t("assessments.weight"), anterior.weight, coleta.weight, " kg"],
    [t("assessments.bmi"), calcAnterior?.imc, calc?.imc, ""],
    [t("assessments.bodyFat"), calcAnterior?.referencia, calc?.referencia, "%"],
    [t("assessments.fatMass"), calcAnterior?.composicao?.fatMass, calc?.composicao?.fatMass, " kg"],
    [t("assessments.leanMass"), calcAnterior?.composicao?.leanMass, calc?.composicao?.leanMass, " kg"],
    [t("assessments.whr"), calcAnterior?.rcq, calc?.rcq, ""],
  ].filter(([, de, para]) => typeof de === "number" || typeof para === "number");

  if (!linhas.length) return "";

  return `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;">
    <tr style="border-bottom:1px solid #cbd5e1;">
      <th align="left" style="padding:5px 0;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:${FRACO};"></th>
      <th align="right" style="padding:5px 0;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:${FRACO};">${escapar(formatarData(anterior.date, lang, fuso))}</th>
      <th align="right" style="padding:5px 0;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:${FRACO};">${escapar(formatarData(coleta.date, lang, fuso))}</th>
    </tr>
    ${linhas
      .map(
        ([rotulo, de, para, sufixo]) => `<tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:5px 0;color:${TINTA};">${escapar(rotulo)}</td>
          <td align="right" style="padding:5px 0;color:${FRACO};">${escapar(numero(de, sufixo))}</td>
          <td align="right" style="padding:5px 0;font-weight:700;color:${TINTA};">${escapar(numero(para, sufixo))}</td>
        </tr>`
      )
      .join("")}
  </table>`;
}

// ── AS MEDIDAS, grupo por grupo ───────────────────────────────────────────
//
// Só os grupos que ESTA coleta preencheu. Imprimir os vazios encheria a folha de
// rótulo sem número — e é a folha que a pessoa leva para casa.
function medidas(t, coleta) {
  return GRUPOS.map((grupo) => {
    const valores = coleta[grupo.key];
    if (!valores || typeof valores !== "object") return "";

    const campos = grupo.campos.filter((c) => typeof valores[c] === "number");
    if (!campos.length) return "";

    return secao(
      t(`assessments.fields.${grupo.key}._`),
      `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;">
        ${campos
          .map(
            (campo, i) => `${i % 3 === 0 ? "<tr>" : ""}
              <td width="33%" style="padding:4px 12px 4px 0;border-bottom:1px solid #f1f5f9;">
                <span style="color:${FRACO};">${escapar(t(`assessments.fields.${grupo.key}.${campo}`))}</span>
                <span style="float:right;font-weight:600;color:${TINTA};">${escapar(valores[campo])} ${escapar(grupo.unit || "")}</span>
              </td>
              ${i % 3 === 2 || i === campos.length - 1 ? "</tr>" : ""}`
          )
          .join("")}
      </table>`
    );
  }).join("");
}

// ── AS FOTOS, NO FIM ──────────────────────────────────────────────────────
//
// Pedido: *"gerar o PDF com as fotos no final"*. E é a ordem em que se conversa
// sobre uma avaliação: primeiro os números, depois o corpo.
//
// Entram como `data:` URI — ver a nota de autossuficiência no topo.
function fotos(t, lados, imagens) {
  const comFoto = (lados || []).filter((lado) => imagens[lado.key]);
  if (!comFoto.length) return "";

  return secao(
    t("assessments.photos"),
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:8px;">
      ${comFoto
        .map(
          (lado, i) => `${i % 2 === 0 ? "<tr>" : ""}
            <td width="50%" valign="top" style="page-break-inside:avoid;">
              <img src="${imagens[lado.key]}" alt="" width="100%" style="display:block;border:1px solid ${LINHA};border-radius:8px;" />
              <div style="margin-top:4px;text-align:center;font-size:11px;color:${FRACO};">${escapar(
                lado.label || t(`assessments.photoSides.${lado.key}`)
              )}</div>
            </td>
            ${i % 2 === 1 || i === comFoto.length - 1 ? "</tr>" : ""}`
        )
        .join("")}
    </table>`
  );
}

// `imagens` é `{ front: "data:image/jpeg;base64,…" }`. Quem as busca é a rota —
// este módulo não fala com o banco, para poder ser testado sem ele.
function documentoAvaliacao({
  assessment,
  person,
  previous,
  photoSides,
  imagens = {},
  lang = "pt-BR",
  fuso = "UTC",
  marca = null,
}) {
  const t = rotulos(lang);
  const calc = calculos.calcular(assessment, person);
  const calcAnterior = previous ? calculos.calcular(previous, person) : null;

  const corpo = [
    secao(t("assessments.results"), cartoes(t, assessment, calc)),
    secao(
      t("assessments.compare"),
      comparativo(t, assessment, calc, previous, calcAnterior, lang, fuso)
    ),
    medidas(t, assessment),
    assessment.note
      ? secao(
          t("assessments.note"),
          `<p style="margin:0;font-size:13px;line-height:1.6;color:${TINTA};white-space:pre-wrap;">${escapar(assessment.note)}</p>`
        )
      : "",
    fotos(t, photoSides, imagens),
  ].join("");

  return pagina({
    lang,
    titulo: t("assessments.title"),
    nome: person?.name,
    subtitulo: `${t("assessments.title")} · ${formatarData(assessment.date, lang, fuso)}`,
    corpo,
    rodape: `${person?.name || ""} · ${formatarData(assessment.date, lang, fuso)}`,
    marca,
  });
}

module.exports = { documentoAvaliacao, escapar, formatarData };
