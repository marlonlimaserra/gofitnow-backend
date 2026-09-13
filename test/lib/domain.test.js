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

// ── Domínio completo ────────────────────────────────────────────────────────

test("aceita o domínio próprio do profissional", () => {
  assert.equal(domain.normalizeDomain("marlon.com.br"), "marlon.com.br");
  assert.equal(domain.normalizeDomain("  Treinos.Marlon.COM.BR "), "treinos.marlon.com.br");
  assert.equal(domain.normalizeDomain("a.com"), "a.com");
});

test("aceita o que a pessoa realmente cola da barra do navegador", () => {
  // Recusar isso viraria "domínio inválido" para um domínio válido.
  for (const entrada of [
    "https://marlon.com.br",
    "http://marlon.com.br/",
    "https://marlon.com.br/entrar?x=1",
    "marlon.com.br:443",
    "marlon.com.br.",
  ]) {
    assert.equal(domain.normalizeDomain(entrada), "marlon.com.br", entrada);
  }
});

test("recusa o que não é domínio", () => {
  for (const ruim of [
    "",
    "localhost",              // um rótulo só
    "marlon",
    "marlon.123",             // TLD numérico é IP disfarçado
    "192.168.0.1",
    "-x.com",
    "x-.com",
    "com espaço.br",
    "acentuação.br",
    "x".repeat(64) + ".com",  // passa do limite de rótulo
    ("a.".repeat(130) + "com"),
    null,
    undefined,
    123,
  ]) {
    assert.equal(domain.normalizeDomain(ruim), null, JSON.stringify(ruim));
  }
});

test("domínio nosso não entra pelo caminho de domínio próprio", () => {
  // Deixar passar pelos dois criaria dois donos possíveis para o mesmo host.
  for (const nosso of ["gofitnow.fit", "marlon.gofitnow.fit", "app.gofitnow.fit"]) {
    assert.equal(domain.isOwnDomain(nosso), true, nosso);
    assert.equal(domain.isUsableDomain(nosso), false, nosso);
  }

  assert.equal(domain.isOwnDomain("gofitnow.fit.br"), false, "sufixo parecido não é o nosso");
  assert.equal(domain.isUsableDomain("marlon.com.br"), true);
});

test("o alvo do CNAME é o app principal", () => {
  assert.equal(domain.CNAME_TARGET, "app." + domain.BASE_DOMAIN);
});

test("os TRÊS domínios nossos são lidos, e só um é escrito", () => {
  // LER aceita todos — é o que faz um endereço novo funcionar sem mexer no
  // cadastro de ninguém. ESCREVER continua num só, senão a mesma cliente passaria
  // a ter dois endereços canônicos.
  for (const host of ["bruna.vafit.app", "bruna.shapeapp.fit", "bruna.gofitnow.fit"]) {
    assert.equal(domain.subdomainOf(host), "bruna", host);
  }
  assert.equal(domain.subdomainOf("a.b.shapeapp.fit"), null);
  assert.ok(domain.isOwnDomain("shapeapp.fit"));
  assert.ok(domain.isOwnDomain("bruna.vafit.app"));
  assert.ok(!domain.isOwnDomain("treinos.marlon.com.br"));
  // domínio próprio do cliente não pode ser um dos nossos, nos três casos
  assert.ok(!domain.isUsableDomain("x.vafit.app"));
  assert.ok(!domain.isUsableDomain("x.shapeapp.fit"));
  assert.ok(!domain.isUsableDomain("x.gofitnow.fit"));
  // o endereço MOSTRADO segue no domínio canônico
  assert.equal(domain.BASE_DOMAIN, "vafit.app");
  assert.equal(domain.hostOf("bruna"), "bruna.vafit.app");
});

test("`gofitnow.fit` NÃO SAI da lista de leitura, nunca", () => {
  // Este caso existe por causa de um defeito que quase entrou em 13/09/2026.
  //
  // A lista era derivada: `${BASE_DOMAIN},shapeapp.fit,vafit.app`. Quando o
  // BASE_DOMAIN virou `vafit.app`, a expressão passou a dar
  // `vafit.app,shapeapp.fit,vafit.app` — e `gofitnow.fit` caiu fora.
  //
  // O estrago não é um endereço a menos. É `bruna.gofitnow.fit` deixar de ser
  // reconhecido como a Bruna: todo cliente tem o endereço antigo salvo no
  // navegador e no atalho da tela inicial, e a tela deles viraria "domínio não
  // identificado" no mesmo deploy — sem erro em lugar nenhum.
  //
  // Nenhuma troca de marca futura pode tirá-lo daqui.
  assert.ok(domain.BASE_DOMAINS.includes("gofitnow.fit"));
  assert.equal(domain.subdomainOf("bruna.gofitnow.fit"), "bruna");
});
