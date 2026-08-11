#!/usr/bin/env node
// Confere os quatro arquivos de tradução do servidor.
//
// Roda com `npm run i18n:check`. Existe porque uma chave que falta num idioma
// não quebra nada em teste: ela cai em pt-BR e só aparece como texto errado na
// tela de alguém. Aqui ela vira erro antes de subir.
const fs = require("fs");
const path = require("path");
const { LANGUAGES, DEFAULT_LANGUAGE } = require("./index.js");

const dir = path.join(__dirname, "locales");
const load = (l) => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), "utf8"));

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
];

for (const k of new Set(exigidas)) {
  if (!base.has(k)) problemas.push(`catálogo sem tradução: ${k}`);
}

if (problemas.length) {
  console.error("i18n: " + problemas.length + " problema(s)\n" + problemas.join("\n"));
  process.exit(1);
}
console.log(`i18n ok — ${base.size} chaves × ${LANGUAGES.length} idiomas, catálogos cobertos`);
