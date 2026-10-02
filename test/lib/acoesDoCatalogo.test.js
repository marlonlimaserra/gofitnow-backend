const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const acoes = require("../../lib/actions.js");
const { translator } = require("../../lib/i18n");

// O CATÁLOGO DO HISTÓRICO NÃO PODE FICAR PARA TRÁS.
//
// *"verifique a ação, acho que tem muito mais coisa agora, pois aparecendo um
// monte em inglês"* e *"recurso também"* (02/10/2026).
//
// ── POR QUE ISTO PASSOU DESPERCEBIDO POR MESES ─────────────────────────
//
// `lib/actions.js` diz, no topo, que uma ação fora do catálogo "ainda aparece
// na tela, com a própria chave como rótulo". Essa gentileza é o que torna o
// defeito invisível: nada quebra, nada avisa, e o filtro de Logs vai juntando
// `create_equipment` e `create_group_class` no meio das frases em português.
//
// Eram CINQUENTA E SETE ações e VINTE E CINCO recursos quando ele reparou.
//
// A causa não é falta de disciplina: registrar uma ação nova custa duas
// escritas, em dois arquivos, e a segunda não dói na hora. Este teste é quem
// passa a cobrar as duas juntas.
const RAIZ = path.join(__dirname, "..", "..");

// `insertUserActionHistory(req, user, "a_chave", …)` — a terceira posição.
// Chave montada em variável escapa, e tudo bem: a varredura grosseira cobre o
// que de fato se escreve, sem exigir uma lista para manter.
const CHAMADA = /insertUserActionHistory\(\s*req\s*,\s*[A-Za-z_.]+\s*,\s*["']([a-z0-9_]+)["']/g;
const ALVO = /target_type:\s*["']([a-z0-9_]+)["']/g;

function varrer(dir, achar, saida = new Map()) {
  for (const nome of fs.readdirSync(dir)) {
    const caminho = path.join(dir, nome);

    if (fs.statSync(caminho).isDirectory()) {
      if (nome !== "node_modules") varrer(caminho, achar, saida);
      continue;
    }

    if (!nome.endsWith(".js")) continue;

    const texto = fs.readFileSync(caminho, "utf8");
    for (const m of texto.matchAll(achar)) saida.set(m[1], path.relative(RAIZ, caminho));
  }
  return saida;
}

const PASTAS = ["controllers", "model", "lib", "helper"].map((d) => path.join(RAIZ, d));

function tudo(achar) {
  const saida = new Map();
  for (const p of PASTAS) if (fs.existsSync(p)) varrer(p, achar, saida);
  return saida;
}

test("toda ação que o código grava está no catálogo", () => {
  const noCatalogo = new Set(acoes.ACTIONS.map((a) => a.key));
  const gravadas = tudo(CHAMADA);

  const faltando = [...gravadas.entries()]
    .filter(([k]) => !noCatalogo.has(k))
    .map(([k, arquivo]) => `${k} (${arquivo})`);

  assert.deepEqual(
    faltando,
    [],
    "ação gravada no histórico e ausente de lib/actions.js — ela aparece no filtro com a chave crua"
  );
});

test("todo `target_type` que o código grava está na lista de recursos", () => {
  const conhecidos = new Set(acoes.TARGET_TYPE_KEYS);
  const gravados = tudo(ALVO);

  const faltando = [...gravados.entries()]
    .filter(([k]) => !conhecidos.has(k))
    .map(([k, arquivo]) => `${k} (${arquivo})`);

  assert.deepEqual(faltando, [], "recurso gravado e ausente de TARGET_TYPE_KEYS");
});

test("nenhuma ação sai como chave crua, em nenhum idioma", () => {
  for (const lng of ["pt-BR", "en", "es", "fr"]) {
    const cruas = acoes
      .localizedActions(translator(lng))
      .filter((a) => a.label.startsWith("actions."))
      .map((a) => a.key);

    assert.deepEqual(cruas, [], `${lng}: ação sem rótulo`);
  }
});

test("nenhum recurso sai como chave crua, em nenhum idioma", () => {
  for (const lng of ["pt-BR", "en", "es", "fr"]) {
    const cruos = Object.entries(acoes.localizedTargetTypes(translator(lng)))
      .filter(([, v]) => v.startsWith("targetTypes."))
      .map(([k]) => k);

    assert.deepEqual(cruos, [], `${lng}: recurso sem rótulo`);
  }
});

test("nenhuma categoria sai como chave crua", () => {
  for (const lng of ["pt-BR", "en", "es", "fr"]) {
    const cruas = acoes
      .localizedCategories(translator(lng))
      .filter((c) => c.label.startsWith("categories."))
      .map((c) => c.key);

    assert.deepEqual(cruas, [], `${lng}: categoria sem rótulo`);
  }
});

test("a categoria de toda ação existe no catálogo de categorias", () => {
  // Uma categoria inventada numa ação faria o filtro de categoria devolver
  // zero para ela — a ação existe, está gravada, e some da tela.
  const categorias = new Set(acoes.CATEGORIES.map((c) => c.key));
  const fora = acoes.ACTIONS.filter((a) => !categorias.has(a.category)).map(
    (a) => `${a.key} → ${a.category}`
  );

  assert.deepEqual(fora, []);
});
