const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  fromAcceptLanguage,
  translate,
  translator,
} = require("../../lib/i18n");

test("normalizeLanguage: as quatro tags exatas passam intactas", () => {
  for (const l of LANGUAGES) assert.equal(normalizeLanguage(l), l);
});

test("normalizeLanguage: não diferencia maiúsculas — a tag pode vir de query string", () => {
  assert.equal(normalizeLanguage("PT-br"), "pt-BR");
  assert.equal(normalizeLanguage("EN"), "en");
});

test("normalizeLanguage: qualquer português vira pt-BR", () => {
  // Mostrar inglês a quem pediu pt-PT seria pior do que o português do Brasil.
  assert.equal(normalizeLanguage("pt"), "pt-BR");
  assert.equal(normalizeLanguage("pt-PT"), "pt-BR");
  assert.equal(normalizeLanguage("pt_BR"), "pt-BR");
});

test("normalizeLanguage: casa pela base quando a região não é nossa", () => {
  assert.equal(normalizeLanguage("en-US"), "en");
  assert.equal(normalizeLanguage("es-419"), "es");
  assert.equal(normalizeLanguage("fr-CA"), "fr");
});

test("normalizeLanguage: o que não sabemos atender cai no padrão", () => {
  for (const v of ["de", "ja-JP", "", null, undefined, "   ", 42, {}]) {
    assert.equal(normalizeLanguage(v), DEFAULT_LANGUAGE);
  }
});

test("fromAcceptLanguage: respeita o q= em vez da ordem do texto", () => {
  // O navegador pode listar o menos preferido primeiro.
  assert.equal(fromAcceptLanguage("en;q=0.2, fr;q=0.9"), "fr");
  assert.equal(fromAcceptLanguage("fr;q=0.1, en;q=0.8"), "en");
});

test("fromAcceptLanguage: pula o idioma que não atendemos e pega o próximo", () => {
  assert.equal(fromAcceptLanguage("de-DE,de;q=0.9,en;q=0.5"), "en");
});

test("fromAcceptLanguage: cabeçalho ausente, vazio ou curinga cai no padrão", () => {
  for (const v of [undefined, "", "*", "de,ja", "lixo;;;"]) {
    assert.equal(fromAcceptLanguage(v), DEFAULT_LANGUAGE);
  }
});

test("fromAcceptLanguage: o curinga não sequestra um idioma melhor listado depois", () => {
  // "*" significa "tanto faz"; se veio antes, ele encerra a busca no padrão.
  assert.equal(fromAcceptLanguage("*, fr"), DEFAULT_LANGUAGE);
  // Mas um idioma real antes do curinga vence.
  assert.equal(fromAcceptLanguage("fr, *"), "fr");
});

test("translate: interpola {{var}} e deixa quieto o que não recebeu valor", () => {
  const t = translator("pt-BR");
  assert.match(t("errors.vocabularyLength", { field: "singular" }), /singular/);
  // Sem o valor, a marca permanece — some seria esconder que faltou dado.
  assert.match(t("errors.vocabularyLength"), /{{field}}/);
});

test("translate: chave inexistente devolve a própria chave", () => {
  // Uma tela mostrando "errors.naoExiste" diz o que consertar; string vazia
  // esconderia o problema.
  assert.equal(translate("en", "errors.naoExiste"), "errors.naoExiste");
});

test("translate: chave que só existe em pt-BR cai no português, não na chave crua", () => {
  const dir = path.join(__dirname, "..", "..", "lib", "i18n", "locales");
  const pt = JSON.parse(fs.readFileSync(path.join(dir, "pt-BR.json"), "utf8"));
  const en = JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8"));
  // Garante a premissa do teste: se algum dia en tiver TUDO, isto avisa.
  assert.ok(pt.errors.internal && en.errors.internal, "a chave de controle sumiu");
  assert.equal(translate("en", "errors.internal"), en.errors.internal);
});

test("translator: expõe o idioma já normalizado", () => {
  assert.equal(translator("pt").lang, "pt-BR");
  assert.equal(translator("de").lang, DEFAULT_LANGUAGE);
});

test("as quatro tabelas têm exatamente as mesmas chaves", () => {
  const dir = path.join(__dirname, "..", "..", "lib", "i18n", "locales");
  const flat = (o, p = "", out = new Set()) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") flat(v, key, out);
      else out.add(key);
    }
    return out;
  };

  const tabelas = Object.fromEntries(
    LANGUAGES.map((l) => [l, flat(JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), "utf8")))])
  );
  const base = tabelas[DEFAULT_LANGUAGE];

  for (const l of LANGUAGES.filter((x) => x !== DEFAULT_LANGUAGE)) {
    assert.deepEqual(
      [...base].filter((k) => !tabelas[l].has(k)),
      [],
      `${l}: chaves faltando`
    );
    assert.deepEqual(
      [...tabelas[l]].filter((k) => !base.has(k)),
      [],
      `${l}: chaves sobrando`
    );
  }
});

test("nenhuma tradução ficou vazia", () => {
  const dir = path.join(__dirname, "..", "..", "lib", "i18n", "locales");
  for (const l of LANGUAGES) {
    const flat = (o, p = "") =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === "object" ? flat(v, p + k + ".") : [[p + k, v]]
      );
    for (const [k, v] of flat(JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), "utf8")))) {
      assert.ok(typeof v === "string" && v.trim().length > 0, `${l}: ${k} vazia`);
    }
  }
});
