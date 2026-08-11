const test = require("node:test");
const assert = require("node:assert/strict");

const permissions = require("../../lib/permissions.js");
const { translator } = require("../../lib/i18n");

test("ALL cobre todos os itens de todos os grupos, sem repetir", () => {
  const doCatalogo = permissions.GROUPS.flatMap((g) => g.items.map((i) => i.key));
  assert.deepEqual([...permissions.ALL].sort(), [...doCatalogo].sort());
  assert.equal(new Set(permissions.ALL).size, permissions.ALL.length, "há chave repetida");
});

test("sanitize descarta o que não está no catálogo", () => {
  // Um erro de digitação não pode ficar guardado dentro de um tipo: pareceria
  // uma permissão de verdade que simplesmente nunca casa.
  assert.deepEqual(permissions.sanitize(["people.view", "people.inventada"]), ["people.view"]);
  assert.deepEqual(permissions.sanitize(["roles.manage", "", null, 0, {}]), ["roles.manage"]);
});

test("sanitize devolve na ordem do catálogo, não na ordem recebida", () => {
  // Assim dois tipos com as mesmas permissões guardam a MESMA lista, e o diff
  // do histórico não acusa mudança onde não houve.
  const a = permissions.sanitize(["roles.manage", "people.view"]);
  const b = permissions.sanitize(["people.view", "roles.manage"]);
  assert.deepEqual(a, b);
});

test("sanitize remove duplicatas", () => {
  assert.deepEqual(permissions.sanitize(["people.view", "people.view"]), ["people.view"]);
});

test("sanitize aceita só array", () => {
  for (const v of [undefined, null, "people.view", 7, {}]) {
    assert.deepEqual(permissions.sanitize(v), []);
  }
});

test("isValid responde pelo catálogo", () => {
  assert.equal(permissions.isValid("people.view"), true);
  assert.equal(permissions.isValid("people.inventada"), false);
  assert.equal(permissions.isValid(undefined), false);
});

test("nenhuma permissão aposentada voltou a ser válida", () => {
  // Uma chave nunca é reaproveitada com outro significado: quem tivesse a
  // antiga ganharia a nova de graça.
  for (const k of permissions.RETIRED) {
    assert.equal(permissions.isValid(k), false, `${k} voltou ao catálogo`);
  }
});

test("localized traduz título, descrição, rótulo e dica — e preserva as chaves", () => {
  const en = permissions.localized(translator("en"));

  assert.equal(en.length, permissions.GROUPS.length);
  assert.deepEqual(
    en.map((g) => g.key),
    permissions.GROUPS.map((g) => g.key)
  );

  const pessoas = en[0];
  assert.equal(pessoas.title, "People");
  assert.equal(pessoas.items[0].key, "people.view");
  assert.equal(pessoas.items[0].label, "View people");
  assert.ok(pessoas.items[0].hint.length > 0);
});

test("localized não deixa chave crua vazando como texto em nenhum idioma", () => {
  // Uma permissão sem tradução sairia com "permissions.items.x.label" na tela.
  for (const lng of ["pt-BR", "en", "es", "fr"]) {
    for (const g of permissions.localized(translator(lng))) {
      assert.ok(!g.title.startsWith("permissions."), `${lng}: ${g.key} sem título`);
      assert.ok(!g.description.startsWith("permissions."), `${lng}: ${g.key} sem descrição`);
      for (const i of g.items) {
        assert.ok(!i.label.startsWith("permissions."), `${lng}: ${i.key} sem rótulo`);
        assert.ok(!i.hint.startsWith("permissions."), `${lng}: ${i.key} sem dica`);
      }
    }
  }
});

test("localized não vaza texto entre idiomas", () => {
  const pt = permissions.localized(translator("pt-BR"))[0].title;
  const fr = permissions.localized(translator("fr"))[0].title;
  assert.notEqual(pt, fr);
});
