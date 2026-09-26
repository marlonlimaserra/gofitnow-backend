// Reparte os arquivos de tradução do servidor em ARQUIVOS POR ÁREA.
//
// *"se entrar mais programador vai começar a dar um monte de conflito nesse
// arquivo porque todo mundo vai mexer nele — separe um arquivo de linguagem
// para cada arquivo de controle"* (26/09/2026).
//
// De `locales/pt-BR.json` (845 chaves) para `locales/pt-BR/<area>.json`. O
// carregador (`lib/i18n/index.js`) junta a pasta inteira na abertura, então
// para quem chama `t()` nada muda.
//
//   node scripts/traducaoRepartir.mjs
//
// Ele é IDEMPOTENTE e CONFERE a si mesmo: junta o que produziu e compara, chave
// a chave, com o que existia antes. Qualquer diferença aborta sem escrever —
// perder uma mensagem no meio de uma migração de arquivo é o tipo de defeito
// que só aparece na tela de um cliente, meses depois.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(AQUI, "..", "lib", "i18n", "locales");
const IDIOMAS = ["pt-BR", "en", "es", "fr"];

// ── ONDE CADA COISA MORA ──────────────────────────────────────────────────
//
// Um grupo de primeiro nível inteiro vai para a área dele. `errors` é a exceção
// e a razão de tudo isto: com 262 chaves, é o grupo que TODA feature toca — e
// era ele que ia colecionar conflitos. Ele se reparte por PREFIXO, de modo que
// a mensagem de erro de uma área fique no arquivo daquela área.
const POR_GRUPO = {
  permissions: "permissoes",
  actions: "registro",
  categories: "registro",
  targetTypes: "registro",
  email: "email",
  push: "push",
  autoFill: "autoPreencher",
  apiDocs: "apiDocs",
  structure: "estrutura",
  planLimits: "planos",
  memberships: "planos",
  employees: "equipe",
  payables: "contas",
  finance: "financeiro",
  documentTemplates: "documentos",
  pendencies: "documentos",
  chat: "conversas",
  ok: "ok",
};

// Na ORDEM: a primeira regra que casa manda. Por isso `aiVoice…` não precisa de
// entrada própria (cai em `ai`), e `paymentMethod…` vem antes de `payment…`.
const POR_PREFIXO_DE_ERRO = [
  [/^ai/, "ia"],
  [/^aulao/, "aulao"],
  [/^(booking|appointment|groupClass|checkin|endBeforeStart|invalidDay|slotTaken)/, "agenda"],
  [/^(payable|supplier)/, "contas"],
  [/^(paymentMethod|payment|charge|recurrence|billing|checkout|requireAmount|invalidReceipt|noSubscription)/, "financeiro"],
  [/^(employee|payroll)/, "equipe"],
  [/^(equipment|maintenance|stock)/, "estrutura"],
  [/^(membership|plan|notInPlan|brandImagesNotInPlan|alreadyOnPlan)/, "planos"],
  [/^(idea|ticket)/, "suporte"],
  [/^deletion/, "conta"],
  [/^(apiKey|invalidApiKey|noApiKey)/, "apiKeys"],
  [/^(role|group|admin|lastAccount|lastRole|lastManager|noPermission|invalidRole)/, "permissoes"],
  [/^(food|exercise|recipe)/, "catalogos"],
  [
    /^(person|student|invite|assessment|diet|exam|workout|prescription|pendency|document|anamnesis|checkinNot|photo|attachment)/,
    "pessoas",
  ],
  [/^(unit|domain|subdomain|instance|tenant|ourDomain|noCustomDomain|noInstance)/, "instancia"],
];

function areaDaChave(grupo, chave) {
  if (grupo !== "errors") return POR_GRUPO[grupo] || "comum";

  for (const [regra, area] of POR_PREFIXO_DE_ERRO) {
    if (regra.test(chave)) return area;
  }

  // O que não é de área nenhuma — `internal`, `notFound`, `invalidEmail`,
  // `rateLimited`. Mensagens que qualquer controller usa, e que por isso mesmo
  // quase nunca mudam: elas não são o problema que este corte resolve.
  return "comum";
}

function achatar(obj, prefixo = "", saida = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const chave = prefixo ? `${prefixo}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) achatar(v, chave, saida);
    else saida.set(chave, v);
  }
  return saida;
}

function porCaminho(alvo, caminho, valor) {
  const partes = caminho.split(".");
  let atual = alvo;
  for (const parte of partes.slice(0, -1)) {
    if (atual[parte] === undefined) atual[parte] = {};
    atual = atual[parte];
  }
  atual[partes.at(-1)] = valor;
}

function ordenar(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, ordenar(obj[k])])
  );
}

let areas = new Set();
const escrever = [];

for (const lng of IDIOMAS) {
  const plano = path.join(DIR, `${lng}.json`);
  if (!fs.existsSync(plano)) {
    console.error(`falta ${lng}.json — nada a repartir`);
    process.exit(1);
  }

  const original = JSON.parse(fs.readFileSync(plano, "utf8"));
  const arquivos = {};

  for (const [grupo, conteudo] of Object.entries(original)) {
    if (conteudo && typeof conteudo === "object" && !Array.isArray(conteudo)) {
      for (const [chave, valor] of achatar(conteudo)) {
        const area = areaDaChave(grupo, chave.split(".")[0]);
        arquivos[area] = arquivos[area] || {};
        porCaminho(arquivos[area], `${grupo}.${chave}`, valor);
      }
      continue;
    }
    // Chave solta no topo, se existir.
    arquivos.comum = arquivos.comum || {};
    arquivos.comum[grupo] = conteudo;
  }

  // ── A CONFERÊNCIA ─────────────────────────────────────────────────────
  const juntado = {};
  for (const conteudo of Object.values(arquivos)) {
    for (const [k, v] of achatar(conteudo)) porCaminho(juntado, k, v);
  }

  const antes = achatar(original);
  const depois = achatar(juntado);

  const faltando = [...antes.keys()].filter((k) => !depois.has(k));
  const sobrando = [...depois.keys()].filter((k) => !antes.has(k));
  const diferentes = [...antes.keys()].filter((k) => depois.has(k) && depois.get(k) !== antes.get(k));

  if (faltando.length || sobrando.length || diferentes.length) {
    console.error(`[${lng}] o corte não bate — nada foi escrito`);
    console.error("  faltando:", faltando.slice(0, 5));
    console.error("  sobrando:", sobrando.slice(0, 5));
    console.error("  diferentes:", diferentes.slice(0, 5));
    process.exit(1);
  }

  areas = new Set([...areas, ...Object.keys(arquivos)]);
  escrever.push({ lng, arquivos, plano });
}

// Todos os idiomas têm de produzir o MESMO conjunto de arquivos: um idioma com
// um arquivo a menos é uma área inteira sem tradução naquele idioma.
for (const { lng, arquivos } of escrever) {
  for (const area of areas) if (!arquivos[area]) arquivos[area] = {};
}

for (const { lng, arquivos, plano } of escrever) {
  const pasta = path.join(DIR, lng);
  fs.mkdirSync(pasta, { recursive: true });

  for (const [area, conteudo] of Object.entries(arquivos)) {
    fs.writeFileSync(path.join(pasta, `${area}.json`), JSON.stringify(ordenar(conteudo), null, 2) + "\n");
  }

  fs.rmSync(plano);
  console.log(`${lng}: ${Object.keys(arquivos).length} arquivos`);
}

console.log("áreas:", [...areas].sort().join(", "));
