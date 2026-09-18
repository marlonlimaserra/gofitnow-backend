const iconify = require("./iconify.js");

// O DESENHO DE UM ÍCONE ESCOLHIDO, guardado junto com o nome dele.
//
// ── Por que o desenho é guardado, e não buscado na hora ─────────────────
//
// O cartão da vitrine abre DENTRO do site de um cliente. Um ícone que só
// aparece se a Iconify responder é um buraco no cartão de venda dele — e
// quarenta e oito requisições paralelas a um terceiro já nos renderam um
// `error code: 1015` uma vez.
//
// Então o servidor busca UMA vez, confere o SVG contra a lista fechada de tags
// de desenho (`lib/iconify.js`) e guarda o corpo. Depois disso, o desenho é
// nosso.
//
// ── E por que isto virou biblioteca ─────────────────────────────────────
//
// Nasceu dentro de `MembershipBenefit_model`, para a linha da tabela. Em
// 18/09/2026 o botão de comprar ganhou ícone — *"permita escolher ícone para
// esse botão"* — e a regra é exatamente a mesma, só com outros nomes de campo.
//
// Copiar as trinta linhas criaria duas versões da mesma decisão: a primeira
// vez que alguém mudar o comportamento de "tirei o ícone", só uma das duas
// muda, e a outra continua mostrando o desenho de antes.
const CAMPOS_PADRAO = { nome: "icone", svg: "iconeSvg", caixa: "iconeCaixa" };

// Escolheu um ícone novo? busca e guarda. Tirou o ícone? apaga o desenho junto
// — senão o cartão continuaria mostrando o de antes, e a pessoa acharia que o
// "sem ícone" não funcionou.
//
// Se a busca falhar (rede lenta, Iconify fora), grava SEM ícone em vez de não
// gravar: o nome é o conteúdo, e o ícone é enfeite. Perder o enfeite é melhor
// que perder o que a pessoa escreveu.
async function aplicar(mudanca, anterior, campos = CAMPOS_PADRAO) {
  const { nome, svg, caixa } = campos;
  if (mudanca[nome] === undefined) return mudanca;

  if (!mudanca[nome]) {
    mudanca[svg] = "";
    mudanca[caixa] = "";
    return mudanca;
  }

  // Mesmo ícone de antes: nada a buscar. É o caso de toda edição que mexe só
  // no texto, e ele é o mais comum.
  if (anterior && anterior[nome] === mudanca[nome] && anterior[svg]) return mudanca;

  const achado = await iconify.buscar(mudanca[nome]);
  if (!achado) {
    mudanca[nome] = "";
    mudanca[svg] = "";
    mudanca[caixa] = "";
    return mudanca;
  }

  mudanca[svg] = achado.body;
  mudanca[caixa] = achado.caixa;
  return mudanca;
}

// O NOME de um ícone, ou vazio. `prefixo:nome`, minúsculo — é a forma da
// Iconify, e o que não casa não é ícone nenhum.
function nome(v) {
  const texto = String(v || "").trim().toLowerCase();
  return iconify.NOME.test(texto) ? texto : "";
}

module.exports = { aplicar, nome, CAMPOS_PADRAO };
