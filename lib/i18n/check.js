#!/usr/bin/env node
// Confere os quatro arquivos de tradução do servidor.
//
// Roda com `npm run i18n:check`. Existe porque uma chave que falta num idioma
// não quebra nada em teste: ela cai em pt-BR e só aparece como texto errado na
// tela de alguém. Aqui ela vira erro antes de subir.
const fs = require("fs");
const path = require("path");
const { LANGUAGES, DEFAULT_LANGUAGE, carregarIdioma } = require("./index.js");

// A tradução é repartida por ÁREA desde 26/09/2026 (`locales/<idioma>/*.json`).
// O carregador é quem junta, e é ele que se usa aqui: conferir lendo os
// arquivos por conta própria criaria uma segunda ideia de "o que está
// traduzido" — e a diferença entre as duas só apareceria numa tela.
const dir = path.join(__dirname, "locales");
const load = (l) => carregarIdioma(l);

function flat(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const tabelas = Object.fromEntries(LANGUAGES.map((l) => [l, flat(load(l))]));
const base = tabelas[DEFAULT_LANGUAGE];
const problemas = [];

for (const lng of LANGUAGES.filter((l) => l !== DEFAULT_LANGUAGE)) {
  for (const k of base.keys()) if (!tabelas[lng].has(k)) problemas.push(`${lng}: falta ${k}`);
  for (const k of tabelas[lng].keys()) if (!base.has(k)) problemas.push(`${lng}: sobra ${k}`);
}

// As variáveis {{...}} têm de ser as mesmas: uma frase traduzida que esqueceu
// {{minutes}} entrega um e-mail sem o prazo.
const vars = (s) => new Set([...String(s ?? "").matchAll(/{{(\w+)}}/g)].map((m) => m[1]));

for (const k of base.keys()) {
  const ref = vars(base.get(k));
  for (const lng of LANGUAGES.filter((l) => l !== DEFAULT_LANGUAGE)) {
    if (!tabelas[lng].has(k)) continue;
    const cur = vars(tabelas[lng].get(k));
    const falta = [...ref].filter((v) => !cur.has(v));
    const sobra = [...cur].filter((v) => !ref.has(v));
    if (falta.length || sobra.length) {
      problemas.push(`${lng}: ${k} — falta [${falta}] sobra [${sobra}]`);
    }
  }
}

// Todo catálogo tem de estar coberto: uma permissão nova sem texto sairia com a
// própria chave na tela do admin.
const permissions = require("../permissions.js");
const actions = require("../actions.js");
const autoFill = require("../autoFillFields.js");
const recorrencia = require("../recorrencia.js");
const modelosDeCartao = require("../modelosDeCartao.js");
const apiDocs = require("../apiDocs.js");
const categoriasDeConta = require("../categoriasDeConta.js");
const statusDeCobranca = require("../statusDeCobranca.js");
const statusDePagamento = require("../statusDePagamento.js");
const statusDeRecorrencia = require("../statusDeRecorrencia.js");
const vinculos = require("../vinculosDeTrabalho.js");
const tiposDeOcorrencia = require("../tiposDeOcorrencia.js");
const documentoModelo = require("../documentoModelo.js");
const categoriasDePendencia = require("../categoriasDePendencia.js");
const catalogosDeEstrutura = require("../catalogosDeEstrutura.js");

const exigidas = [
  ...new Set(permissions.GROUPS.flatMap((g) => [
    `permissions.groups.${g.key}.title`,
    `permissions.groups.${g.key}.description`,
    ...g.items.flatMap((i) => [`permissions.items.${i.key}.label`, `permissions.items.${i.key}.hint`]),
  ])),
  ...actions.ACTIONS.map((a) => `actions.${a.key}`),
  ...actions.CATEGORIES.map((c) => `categories.${c.key}`),
  ...actions.TARGET_TYPE_KEYS.map((k) => `targetTypes.${k}`),
  ...autoFill.FIELDS.flatMap((f) => [
    `autoFill.fields.${f.key}.label`,
    `autoFill.fields.${f.key}.hint`,
    `autoFill.groups.${f.group}`,
  ]),
  ...apiDocs.ROTAS.flatMap((r) => [`apiDocs.routes.${r.key}`, `apiDocs.groups.${r.group}`]),

  // ── OS CATÁLOGOS QUE VIAJAM TRADUZIDOS ────────────────────────────────
  //
  // Cadências e modelos de cor saem daqui já com o rótulo pronto, e a tela só
  // desenha o que recebe. Um rótulo sem tradução vira a CHAVE na cara de
  // alguém — foi o que aconteceu em 18/09/2026: eu escrevi
  // `memberships.model.*` no catálogo do FRONTEND, e a vitrine mostrou
  // "memberships.model.brand" num tooltip.
  //
  // O erro é fácil justamente porque os dois catálogos existem e têm chaves
  // parecidas. Esta lista é o que o torna impossível de subir.
  ...recorrencia.CADENCIAS.map((c) => c.rotulo),
  ...modelosDeCartao.MODELOS.map((m) => m.rotulo),

  // ── E OS OUTROS SETE, acrescentados em 20/09/2026 ─────────────────────
  //
  // A lista acima tinha dois, e o comentário logo acima dizia que ela torna o
  // erro impossível de subir. Não tornava: ela cobria os dois que estavam nela.
  //
  // Nasceram mais sete catálogos desde então — categorias de conta, três
  // conjuntos de status, vínculo de trabalho, tipo de ocorrência e os campos do
  // modelo de documento — e NENHUM entrou aqui. O dos campos foi o que apareceu
  // na tela: as oito chaves cruas em cima do editor, porque eu as traduzi no
  // frontend e quem as resolve é o servidor.
  //
  // `test/lib/i18n.test.js` agora varre `lib/` atrás de `rotulo:` e cobra que
  // cada arquivo esteja citado AQUI — o que faz o próximo catálogo não depender
  // de alguém lembrar desta lista.
  ...categoriasDeConta.CATEGORIAS.map((c) => c.rotulo),
  ...statusDeCobranca.STATUS.map((s) => s.rotulo),
  ...statusDePagamento.STATUS.map((s) => s.rotulo),
  ...statusDeRecorrencia.STATUS.map((s) => s.rotulo),
  ...vinculos.VINCULOS.map((v) => v.rotulo),
  ...tiposDeOcorrencia.TIPOS.map((t) => t.rotulo),
  ...tiposDeOcorrencia.GRAVIDADES.map((g) => g.rotulo),
  ...documentoModelo.CAMPOS.map((c) => c.rotulo),
  ...categoriasDePendencia.CATEGORIAS.map((c) => c.rotulo),
  ...categoriasDePendencia.DEVEDORES.map((d) => d.rotulo),
  ...catalogosDeEstrutura.EQUIPAMENTOS.map((c) => c.rotulo),
  ...catalogosDeEstrutura.ESTADOS.map((c) => c.rotulo),
  ...catalogosDeEstrutura.MANUTENCOES.map((c) => c.rotulo),
  ...catalogosDeEstrutura.INSUMOS.map((c) => c.rotulo),
  ...catalogosDeEstrutura.MEDIDAS.map((c) => c.rotulo),
  ...catalogosDeEstrutura.MOVIMENTOS.map((c) => c.rotulo),
];

for (const k of new Set(exigidas)) {
  if (!base.has(k)) problemas.push(`catálogo sem tradução: ${k}`);
}

// Toda permissão citada na documentação tem de existir no catálogo, senão a
// tela manda quem integra procurar um checkbox que não há.
for (const ruim of apiDocs.validate()) {
  problemas.push(`apiDocs cita permissão inexistente: ${ruim}`);
}

// ── O DEPÓSITO DOS DOCUMENTOS, que é espelhado do site ──────────────────
//
// As folhas (extrato, avaliação, dieta) não leem o catálogo acima: leem
// `lib/i18n/documentos`, que é uma CÓPIA da tradução do site feita por
// `scripts/traducaoDoSite.mjs`. Ninguém confere essa cópia, e ela envelhece
// sozinha — o site ganha uma chave, o espelho não roda, e a folha sai com
// `FINANCE.COLNUMBER` escrito no cabeçalho da coluna.
//
// Foi exatamente o que aconteceu com o extrato em 18/09/2026, e o Marlon viu
// antes de qualquer teste. Este bloco é o teste que faltava.
//
// SÓ CHAVES LITERAIS. Uma chave montada — `finance.status.${x}` — depende de
// dados que este script não tem, e adivinhá-las daria alarme falso.
const documentos = fs
  .readdirSync(path.join(__dirname, ".."))
  .filter((f) => /^documento.*\.js$/.test(f));

const { rotulos } = require("../rotulosDeDocumento.js");
const rotulo = rotulos(DEFAULT_LANGUAGE);

for (const arquivo of documentos) {
  const codigo = fs.readFileSync(path.join(__dirname, "..", arquivo), "utf8");
  for (const [, chave] of codigo.matchAll(/\bt\(\s*"([\w.]+)"\s*\)/g)) {
    // O rótulo ausente volta como a própria chave — é o combinado do i18next, e
    // é o que aparece na folha.
    if (rotulo(chave) === chave) {
      problemas.push(`documento sem rótulo: ${chave} (em ${arquivo}) — rode scripts/traducaoDoSite.mjs`);
    }
  }
}

if (problemas.length) {
  console.error("i18n: " + problemas.length + " problema(s)\n" + problemas.join("\n"));
  process.exit(1);
}
console.log(`i18n ok — ${base.size} chaves × ${LANGUAGES.length} idiomas, catálogos cobertos`);
