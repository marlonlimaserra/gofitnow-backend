const fs = require("node:fs");
const path = require("node:path");

// OS RÓTULOS de um documento, no idioma de quem vai ler.
//
// O catálogo vem espelhado do site (`scripts/traducaoDoSite.mjs`) e mora num
// depósito à parte — não no catálogo do backend, que tem dono e conferidor
// próprios (`npm run i18n:check`).
//
// ── Chave que falta devolve a CHAVE, e é de propósito ─────────────────────
//
// É o comportamento do i18next, e o documento herda: a folha sai com
// `assessments.weight` escrito onde deveria estar "Peso". Feio, e é o ponto —
// some no teste e grita na tela, em vez de sair em branco e ninguém notar que
// faltou.
const DEPOSITO = path.join(__dirname, "i18n", "documentos");
const PADRAO = "pt-BR";

const cache = new Map();

function catalogo(lang) {
  const escolhido = lang && fs.existsSync(path.join(DEPOSITO, `${lang}.json`)) ? lang : PADRAO;
  if (cache.has(escolhido)) return cache.get(escolhido);

  let dados = {};
  try {
    dados = JSON.parse(fs.readFileSync(path.join(DEPOSITO, `${escolhido}.json`), "utf8"));
  } catch (error) {
    // Depósito ausente (deploy sem o `npm run i18n:docs`) não pode derrubar o
    // documento: ele sai com as chaves à mostra, que é legível o bastante para
    // alguém perceber e rodar o espelho.
  }

  cache.set(escolhido, dados);
  return dados;
}

// ── O CATÁLOGO MISTURA DUAS FORMAS, e as duas são válidas ────────────────
//
// Os arquivos do site guardam uns grupos aninhados (`diets: { totalDay: … }`) e
// outros com a chave com ponto DENTRO do objeto (`workouts: { "weekday.monday":
// … }`). É como o i18next aceita os dois, e o espelho copia byte a byte — não
// cabe a este lado normalizar o que lá é legítimo.
//
// Descer só nível a nível achava o primeiro e perdia o segundo, calado: a folha
// saía com `workouts.weekdayShort.monday` escrito no lugar de "Seg". Por isso, em
// cada passo, o resto do caminho também é tentado como chave literal.
function buscar(no, partes) {
  if (!no || typeof no !== "object") return undefined;

  const inteiro = partes.join(".");
  if (typeof no[inteiro] === "string") return no[inteiro];

  const [cabeca, ...resto] = partes;
  if (!(cabeca in no)) return undefined;
  if (!resto.length) return typeof no[cabeca] === "string" ? no[cabeca] : undefined;

  return buscar(no[cabeca], resto);
}

// ── E ELE INTERPOLA, porque as frases do site interpolam ─────────────────
//
// `bulk.printedAt` é "Impresso em {{quando}}". Sem esta troca, o rodapé de toda
// lista exportada saía com `{{quando}}` escrito — e saiu, em produção, até
// 23/09/2026. O `t` do site aceita o segundo argumento e este espelhava só o
// primeiro: a diferença não aparece em nenhuma chave sem variável, que são
// quase todas, e some no meio delas.
//
// A troca é literal (`{{nome}}`), como a do i18next e a do `documentoPonto`.
function rotulos(lang) {
  const dados = catalogo(lang);

  return function t(chave, vars) {
    const achado = buscar(dados, String(chave).split("."));
    const texto = achado === undefined ? String(chave) : achado;

    if (!vars) return texto;

    return Object.entries(vars).reduce(
      (acc, [nome, valor]) => acc.split(`{{${nome}}}`).join(String(valor ?? "")),
      texto
    );
  };
}

module.exports = { rotulos };
