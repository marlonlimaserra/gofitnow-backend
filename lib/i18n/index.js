const fs = require("fs");
const path = require("path");

// Tradução do lado do servidor.
//
// Não usa i18next: aqui não há detecção de navegador, nem troca em tempo de
// execução, nem plural — só "pegue esta chave neste idioma". Um Map achatado
// por idioma resolve isso em uma linha e sem dependência nova.
//
// ACHATADO de propósito: as chaves do catálogo têm ponto dentro do nome
// ("people.view", "workout.name"). Com busca por caminho aninhado, procurar
// `permissions.items.people.view.label` quebraria no meio. Achatando na carga,
// tanto o objeto aninhado quanto a chave com ponto viram a mesma string, e a
// busca é exata.
const LOCALES_DIR = path.join(__dirname, "locales");

// pt-BR primeiro: é o idioma de casa do produto e o destino de quem chega com
// um Accept-Language que não sabemos atender.
const LANGUAGES = ["pt-BR", "en", "es", "fr"];
const DEFAULT_LANGUAGE = "pt-BR";

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

// Lidos uma vez, na carga do módulo: são quatro arquivos pequenos e ler a cada
// requisição só gastaria I/O para devolver a mesma coisa.
const TABLES = new Map(
  LANGUAGES.map((lng) => [
    lng,
    flatten(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lng}.json`), "utf8"))),
  ])
);

// O navegador manda "pt", "pt-PT", "en-US", "es-419" — nenhuma é chave nossa.
// Sem normalizar, todo mundo cairia no padrão e um americano leria português.
function normalizeLanguage(tag) {
  const bruto = String(tag || "").trim();
  if (!bruto) return DEFAULT_LANGUAGE;

  const exata = LANGUAGES.find((l) => l.toLowerCase() === bruto.toLowerCase());
  if (exata) return exata;

  const base = bruto.toLowerCase().split(/[-_]/)[0];
  // Qualquer português vira pt-BR: é o único que temos, e mostrar inglês a quem
  // pediu pt-PT seria pior do que mostrar o português do Brasil.
  if (base === "pt") return "pt-BR";
  return LANGUAGES.find((l) => l.toLowerCase().split("-")[0] === base) || DEFAULT_LANGUAGE;
}

// "en-GB;q=0.9, pt;q=0.8" → o primeiro que soubermos atender, na ordem de
// preferência declarada. Sem `q` a ordem do cabeçalho já é a preferência.
function fromAcceptLanguage(header) {
  const partes = String(header || "")
    .split(",")
    .map((p) => {
      const [tag, ...params] = p.trim().split(";");
      const q = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((p) => p.tag && !Number.isNaN(p.q))
    .sort((a, b) => b.q - a.q);

  for (const { tag } of partes) {
    if (tag === "*") break;
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (LANGUAGES.some((l) => l.toLowerCase() === tag.toLowerCase() || l.toLowerCase().split("-")[0] === base)) {
      return normalizeLanguage(tag);
    }
  }
  return DEFAULT_LANGUAGE;
}

// Devolve a própria chave quando não acha: uma tela mostrando "errors.foo" diz
// exatamente o que consertar, enquanto uma string vazia esconde o problema.
// Cai para pt-BR antes disso, para uma chave nova ainda não traduzida sair em
// português em vez de crua.
function translate(lng, key, vars) {
  const tabela = TABLES.get(normalizeLanguage(lng));
  let texto = tabela?.get(key);
  if (texto === undefined) texto = TABLES.get(DEFAULT_LANGUAGE).get(key);
  if (texto === undefined) return key;

  if (!vars) return texto;
  return String(texto).replace(/{{(\w+)}}/g, (m, nome) =>
    vars[nome] === undefined ? m : String(vars[nome])
  );
}

// t "amarrado" num idioma, que é a forma usada em toda parte: `req.t(...)`, ou
// `translator(pessoa.lang)` quando quem lê não é quem pediu (o e-mail).
function translator(lng) {
  const alvo = normalizeLanguage(lng);
  const t = (key, vars) => translate(alvo, key, vars);
  t.lang = alvo;
  return t;
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  fromAcceptLanguage,
  translate,
  translator,
};
