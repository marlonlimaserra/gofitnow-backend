const { rotulos } = require("./rotulosDeDocumento.js");
const {
  TINTA, FRACO, LINHA, escapar, numero, formatarData, secao, cartoes, pagina,
} = require("./documentoBase.js");

// O DOCUMENTO DO PLANO ALIMENTAR, em HTML, montado no servidor.
//
// Irmão de `documentoAvaliacao.js`, pelo mesmo motivo e com as mesmas regras — as
// duas folhas dividem `documentoBase.js`. Pedido do Marlon: *"faça o mesmo para o
// plano alimentar, todas essas opções, coloque no app e web também"*.
//
// Este módulo NÃO fala com o banco. Recebe o plano como a rota o entrega e
// devolve texto — é o que permite testá-lo inteiro sem Mongo.

const DIAS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// ── QUEM CONTA E QUEM É ALTERNATIVA ───────────────────────────────────────
//
// `group` junta alimentos que são a MESMA escolha: "pão de forma OU tapioca". Só
// o primeiro de cada grupo entra na conta do dia — somar os dois diria que a
// pessoa come os dois, e o total sairia inflado.
//
// A regra é a mesma de `principais()` no `Diet_model`, e precisa continuar sendo:
// se a folha marcasse outro alimento como principal, o total impresso não bateria
// com a soma das linhas em negrito logo acima dele. Alimento sem grupo vale por
// si — é o caso de tudo gravado antes de existir substituição.
function marcarAlternativas(foods) {
  const vistos = new Set();

  return (foods || []).map((f, i) => {
    const chave = f.group === null || f.group === undefined ? `solo-${i}` : `grupo-${f.group}`;
    const principal = !vistos.has(chave);
    vistos.add(chave);
    return { ...f, principal };
  });
}

// A quantidade com a unidade colada: "120 g", "1 unidade".
function porcao(alimento) {
  if (typeof alimento.quantity !== "number") return "";
  return `${alimento.quantity} ${alimento.unit || "g"}`.trim();
}

// ── UMA REFEIÇÃO ──────────────────────────────────────────────────────────
// A FOTINHA do alimento, quando existe.
//
// Pequena e quadrada, antes do nome — é o que a tela da dieta faz, e é o que faz
// a lista ser VARRIDA em vez de lida: quem monta o prato reconhece a foto antes
// de ler a palavra.
//
// `imagens` chega pronto de quem chamou: `data:` para o PDF e para imprimir,
// `cid:` para o corpo do e-mail. Este módulo não sabe a diferença.
function fotinha(alimento, imagens) {
  const src = imagens?.[alimento.imageKey];
  if (!src) return "";

  return `<img src="${src}" alt="" width="22" height="22" style="width:22px;height:22px;border-radius:4px;object-fit:cover;vertical-align:middle;margin-right:7px;display:inline-block;" />`;
}

function refeicao(t, m, lang, imagens) {
  const alimentos = marcarAlternativas(m.foods);
  if (!alimentos.length && !m.note) return "";

  const cabecalho = [m.time, m.name].filter(Boolean).join(" · ");
  const total = m.totals || {};

  const linhas = alimentos
    .map((a) => {
      // A alternativa entra recuada e em cinza, com "ou" na frente: é a mesma
      // informação que a tela dá, e sem ela a folha lista dois cafés da manhã.
      const estilo = a.principal
        ? `color:${TINTA};`
        : `color:${FRACO};padding-left:14px;font-style:italic;`;
      const prefixo = a.principal ? "" : `<span style="color:#94a3b8;">${escapar(t("diets.or"))} </span>`;

      return `<tr>
        <td style="padding:4px 0;border-top:1px solid ${LINHA};font-size:12.5px;${estilo}">${fotinha(a, imagens)}${prefixo}${escapar(a.name)}</td>
        <td align="right" style="padding:4px 0 4px 8px;border-top:1px solid ${LINHA};font-size:12.5px;white-space:nowrap;${estilo}">${escapar(porcao(a))}</td>
        <td align="right" style="padding:4px 0 4px 10px;border-top:1px solid ${LINHA};font-size:12.5px;white-space:nowrap;${estilo}">${escapar(numero(a.kcal))}</td>
      </tr>`;
    })
    .join("");

  const resumo = [
    typeof total.kcal === "number" ? `${total.kcal} ${t("diets.kcal")}` : "",
    typeof total.protein === "number" ? `${t("diets.protein")} ${total.protein} g` : "",
    typeof total.carbs === "number" ? `${t("diets.carbs")} ${total.carbs} g` : "",
    typeof total.fat === "number" ? `${t("diets.fat")} ${total.fat} g` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // `page-break-inside:avoid`: uma refeição cortada ao meio pela quebra de
  // página deixa o cabeçalho numa folha e os alimentos na outra.
  return `<div style="margin-top:14px;page-break-inside:avoid;">
    <div style="display:block;padding-bottom:2px;">
      <span style="font-size:13.5px;font-weight:700;color:${TINTA};">${escapar(cabecalho)}</span>
      ${resumo ? `<span style="font-size:11px;color:${FRACO};"> — ${escapar(resumo)}</span>` : ""}
    </div>
    ${
      linhas
        ? `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${linhas}</table>`
        : ""
    }
    ${
      m.note
        ? `<div style="margin-top:5px;font-size:11.5px;line-height:1.5;color:${FRACO};white-space:pre-wrap;">${escapar(m.note)}</div>`
        : ""
    }
  </div>`;
}

// ── O TOTAL DO DIA, e a meta quando existe ────────────────────────────────
function totais(t, diet) {
  const total = diet.totals || {};
  const alvo = (v) => (typeof v === "number" ? ` / ${v}` : "");

  const itens = [
    [t("diets.kcal"), `${numero(total.kcal)}${alvo(diet.targetKcal)}`],
    [t("diets.protein"), `${numero(total.protein, " g")}${alvo(diet.targetProtein)}`],
    [t("diets.carbs"), `${numero(total.carbs, " g")}${alvo(diet.targetCarbs)}`],
    [t("diets.fat"), `${numero(total.fat, " g")}${alvo(diet.targetFat)}`],
  ];

  return cartoes(itens);
}

function periodo(t, diet, lang, fuso) {
  const de = formatarData(diet.startDate, lang, fuso);
  const ate = formatarData(diet.endDate, lang, fuso);
  if (!de && !ate) return "";
  return [de, ate].filter(Boolean).join(" — ");
}

function dias(t, diet) {
  const marcados = DIAS.filter((d) => (diet.weekdays || []).includes(d));
  // Todos marcados é o mesmo que nenhum: o plano vale todo dia, e listar os sete
  // só ocupa linha.
  if (!marcados.length || marcados.length === 7) return "";
  return marcados.map((d) => t(`workouts.weekdayShort.${d}`)).join(", ");
}

function documentoDieta({ diet, person, lang = "pt-BR", fuso = "UTC", marca = null, imagens = {} }) {
  const t = rotulos(lang);

  // Objetivo, período e dias numa linha só: são três informações curtas, e cada
  // uma numa seção própria gastaria um terço da primeira página com rótulos.
  const contexto = [
    diet.goal ? `${t("diets.goal")}: ${diet.goal}` : "",
    periodo(t, diet, lang, fuso) ? `${t("diets.period")}: ${periodo(t, diet, lang, fuso)}` : "",
    dias(t, diet) ? `${t("workouts.weekdays")}: ${dias(t, diet)}` : "",
  ]
    .filter(Boolean)
    .join("  ·  ");

  const refeicoes = (diet.meals || []).map((m) => refeicao(t, m, lang, imagens)).join("");

  const corpo = [
    contexto
      ? `<p style="margin:14px 0 0;font-size:12.5px;color:${FRACO};">${escapar(contexto)}</p>`
      : "",
    secao(t("diets.totalDay"), totais(t, diet)),
    refeicoes ? secao(t("diets.meals"), refeicoes) : "",
    diet.note
      ? secao(
          t("diets.note"),
          `<p style="margin:0;font-size:13px;line-height:1.6;color:${TINTA};white-space:pre-wrap;">${escapar(diet.note)}</p>`
        )
      : "",
  ].join("");

  return pagina({
    lang,
    titulo: diet.name || t("diets.title"),
    nome: person?.name,
    subtitulo: diet.name || t("diets.title"),
    corpo,
    rodape: `${person?.name || ""} · ${diet.name || ""}`.replace(/ · $/, ""),
    marca,
  });
}

module.exports = { documentoDieta, marcarAlternativas };
