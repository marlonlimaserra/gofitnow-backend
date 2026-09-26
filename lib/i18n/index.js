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

// ── UM ARQUIVO POR ÁREA, E NÃO UM POR IDIOMA ─────────────────────────────
//
// *"no backend você colocou um arquivo de linguagem único; se entrar mais
// programador vai começar a dar um monte de conflito nesse arquivo porque todo
// mundo vai mexer nele — separe um arquivo de linguagem para cada arquivo de
// controle"* (26/09/2026).
//
// Ele está certo, e o problema é de ferramenta, não de gosto: num JSON único de
// 845 chaves, duas pessoas acrescentando mensagens de features diferentes
// escrevem quase sempre na MESMA região do arquivo — e o git resolve isso com
// um conflito por vez, à mão, em quatro idiomas.
//
// Agora cada idioma é uma PASTA (`locales/pt-BR/*.json`), e cada arquivo é uma
// área. Feature nova = arquivo novo = zero conflito. O carregador junta tudo na
// abertura: para quem chama `t()`, nada mudou.
//
// ── A JUNÇÃO É PROFUNDA, e é isso que faz a regra funcionar ──────────────
//
// Dois arquivos podem contribuir com pedaços do MESMO grupo — `errors`, por
// exemplo, que é de todo mundo. `financeiro.json` traz os `errors` do
// financeiro; `equipe.json` traz os dele. Sem junção profunda, o segundo
// apagaria o primeiro, e o sintoma seria uma mensagem sumindo sem motivo.
//
// A regra de quem escreve, então, é simples: **a chave nova vai no arquivo da
// ÁREA dela**, inclusive quando for um `errors.*`. Nunca num arquivo "geral"
// só porque o grupo dela já existe lá.
//
// Uma chave definida em DOIS arquivos é erro, não é precedência — o teste
// `test/lib/traducaoRepartida.test.js` recusa, pelo mesmo motivo que o mapa de
// partes do frontend recusa: com duas fontes, mudar a errada não faz nada e
// ninguém descobre por quê.
function juntarFundo(alvo, novo, caminho = "") {
  for (const [k, v] of Object.entries(novo)) {
    const aqui = caminho ? `${caminho}.${k}` : k;

    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (alvo[k] === undefined) alvo[k] = {};
      juntarFundo(alvo[k], v, aqui);
      continue;
    }

    if (alvo[k] !== undefined) {
      // Barulhento de propósito: silenciar aqui seria deixar a tradução com
      // duas verdades e a descoberta para o cliente.
      throw new Error(`[i18n] chave repetida em dois arquivos: ${aqui}`);
    }

    alvo[k] = v;
  }
  return alvo;
}

function carregarIdioma(lng) {
  const pasta = path.join(LOCALES_DIR, lng);

  const tudo = {};
  for (const arquivo of fs.readdirSync(pasta).sort()) {
    if (!arquivo.endsWith(".json")) continue;
    juntarFundo(tudo, JSON.parse(fs.readFileSync(path.join(pasta, arquivo), "utf8")));
  }

  return tudo;
}

// Lidos uma vez, na carga do módulo: ler a cada requisição só gastaria I/O para
// devolver a mesma coisa.
const TABLES = new Map(LANGUAGES.map((lng) => [lng, flatten(carregarIdioma(lng))]));

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
  carregarIdioma,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  fromAcceptLanguage,
  translate,
  translator,
};
