const test = require("node:test");
const assert = require("node:assert/strict");

const domain = require("../../lib/domain.js");

test("aceita um subdomínio simples", () => {
  assert.equal(domain.normalize("marlon"), "marlon");
  assert.equal(domain.normalize("  Marlon  "), "marlon");
  assert.equal(domain.normalize("MARLON"), "marlon");
});

test("aceita letras, números e hífen no meio", () => {
  assert.equal(domain.normalize("personal-marlon"), "personal-marlon");
  assert.equal(domain.normalize("studio2"), "studio2");
});

test("recusa o que não pode virar host", () => {
  for (const ruim of [
    "",
    " ",
    "a",                       // curto demais
    "-comeca-com-hifen",
    "termina-com-hifen-",
    "com espaço",
    "com.ponto",
    "acentuação",
    "under_score",
    "x".repeat(64),            // passa do limite de rótulo DNS
    null,
    undefined,
    123,
  ]) {
    assert.equal(domain.normalize(ruim), null, JSON.stringify(ruim));
  }
});

test("nomes reservados não podem ser tomados", () => {
  // Alguém com "api" ou "www" sequestraria endereço do próprio produto.
  for (const r of ["www", "api", "app", "admin", "backend", "mail", "cdn", "static"]) {
    assert.equal(domain.isAvailableName(r), false, r);
  }
  assert.equal(domain.isAvailableName("marlon"), true);
});

test("monta o host completo a partir do subdomínio", () => {
  assert.equal(domain.hostOf("marlon"), "marlon." + domain.BASE_DOMAIN);
});

test("extrai o subdomínio de um host", () => {
  assert.equal(domain.subdomainOf("marlon." + domain.BASE_DOMAIN), "marlon");
  assert.equal(domain.subdomainOf("MARLON." + domain.BASE_DOMAIN.toUpperCase()), "marlon");
});

test("ignora a porta, que o navegador manda em desenvolvimento", () => {
  assert.equal(domain.subdomainOf(`marlon.${domain.BASE_DOMAIN}:5180`), "marlon");
});

test("host que não é do domínio base não tem subdomínio", () => {
  for (const h of ["outro.com", "app.gofitnow.fit", domain.BASE_DOMAIN, "", null]) {
    assert.equal(domain.subdomainOf(h), null, JSON.stringify(h));
  }
});

test("o host do app principal não é confundido com tema de ninguém", () => {
  // app.gofitnow.fit é o produto, não o domínio de um profissional.
  assert.equal(domain.subdomainOf("app.gofitnow.fit"), null);
});
