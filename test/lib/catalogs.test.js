const test = require("node:test");
const assert = require("node:assert/strict");

const actions = require("../../lib/actions.js");
const autoFill = require("../../lib/autoFillFields.js");
const { LANGUAGES, translator } = require("../../lib/i18n");

const IDIOMAS = LANGUAGES.map(translator);

test("toda ação aponta para uma categoria que existe", () => {
  const categorias = new Set(actions.CATEGORIES.map((c) => c.key));
  for (const a of actions.ACTIONS) {
    assert.ok(categorias.has(a.category), `${a.key} → categoria ${a.category} não existe`);
  }
});

test("nenhuma chave de ação repetida", () => {
  const chaves = actions.ACTIONS.map((a) => a.key);
  assert.equal(new Set(chaves).size, chaves.length);
});

test("localizedActions traduz e mantém chave e categoria", () => {
  const t = translator("es");
  const traduzidas = actions.localizedActions(t);

  assert.equal(traduzidas.length, actions.ACTIONS.length);
  const login = traduzidas.find((a) => a.key === "login");
  assert.equal(login.category, "auth");
  assert.equal(login.label, "Entró");
});

test("nenhuma ação, categoria ou recurso sai sem rótulo em nenhum idioma", () => {
  for (const t of IDIOMAS) {
    for (const a of actions.localizedActions(t)) {
      assert.ok(a.label && !a.label.startsWith("actions."), `${t.lang}: ${a.key}`);
    }
    for (const c of actions.localizedCategories(t)) {
      assert.ok(c.label && !c.label.startsWith("categories."), `${t.lang}: ${c.key}`);
    }
    for (const [k, v] of Object.entries(actions.localizedTargetTypes(t))) {
      assert.ok(v && !v.startsWith("targetTypes."), `${t.lang}: ${k}`);
    }
  }
});

test("localizedTargetTypes devolve mapa, não lista — é assim que a tela usa", () => {
  const m = actions.localizedTargetTypes(translator("pt-BR"));
  assert.equal(typeof m, "object");
  assert.ok(!Array.isArray(m));
  assert.equal(m.workouts, "Treino");
});

test("auto preencher: KEYS acompanha FIELDS e isValid responde por ela", () => {
  assert.deepEqual(autoFill.KEYS, autoFill.FIELDS.map((f) => f.key));
  assert.equal(autoFill.isValid("workout.name"), true);
  assert.equal(autoFill.isValid("workout.inventado"), false);
  assert.equal(autoFill.isValid(undefined), false);
});

test("auto preencher: localized traduz rótulo, dica e o NOME do grupo", () => {
  const campos = autoFill.localized(translator("en"));
  const nome = campos.find((f) => f.key === "workout.name");

  assert.equal(nome.label, "Workout name");
  // `group` no catálogo é chave; aqui tem de sair como texto, porque a tela
  // agrupa os campos por ele.
  assert.equal(nome.group, "Workout");
});

test("auto preencher: multiline sobrevive à tradução", () => {
  // É o que decide se o campo é <textarea> ou <input>.
  const dica = autoFill.localized(translator("fr")).find((f) => f.key === "workout.tip");
  assert.equal(dica.multiline, true);
});

test("auto preencher: nenhum campo sai sem texto em nenhum idioma", () => {
  for (const t of IDIOMAS) {
    for (const f of autoFill.localized(t)) {
      assert.ok(f.label && !f.label.startsWith("autoFill."), `${t.lang}: ${f.key} rótulo`);
      assert.ok(f.hint && !f.hint.startsWith("autoFill."), `${t.lang}: ${f.key} dica`);
      assert.ok(f.group && !f.group.startsWith("autoFill."), `${t.lang}: ${f.key} grupo`);
    }
  }
});
