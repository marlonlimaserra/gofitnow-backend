const test = require("node:test");
const assert = require("node:assert/strict");

const cf = require("../../lib/cloudflare.js");

const ENV = {
  CLOUDFLARE_API_TOKEN: "tok",
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_ZONE_ID: "zone",
  CLOUDFLARE_PAGES_PROJECT: "gofitnow",
  CLOUDFLARE_PAGES_TARGET: "gofitnow.pages.dev",
};

// fetch de mentira: guarda o que foi chamado e responde o que o teste mandar.
function fakeFetch(respostas) {
  const chamadas = [];
  const fn = async (url, opts) => {
    chamadas.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null,
      auth: opts.headers.Authorization });
    const r = respostas.shift() ?? { success: true, result: {} };
    return { status: r.success ? 200 : 400, json: async () => r };
  };
  fn.chamadas = chamadas;
  return fn;
}

test("sem configuração, diz o que falta em vez de tentar", async () => {
  const r = await cf.createSubdomain("x.gofitnow.fit", { env: {}, fetchImpl: fakeFetch([]) });
  assert.equal(r.ok, false);
  assert.equal(r.erro, "cloudflare_not_configured");
  assert.deepEqual(r.faltando, ["token", "accountId", "zoneId"]);
});

test("isConfigured é falso enquanto faltar a zona — que é o caso do token de Pages", () => {
  assert.equal(cf.isConfigured({ ...ENV, CLOUDFLARE_ZONE_ID: "" }), false);
  assert.deepEqual(cf.missingConfig({ ...ENV, CLOUDFLARE_ZONE_ID: "" }), ["zoneId"]);
  assert.equal(cf.isConfigured(ENV), true);
});

test("cria o CNAME proxiado e liga o domínio ao projeto Pages", async () => {
  const f = fakeFetch([{ success: true, result: { id: "rec" } }, { success: true, result: {} }]);
  const r = await cf.createSubdomain("marlon.gofitnow.fit", { env: ENV, fetchImpl: f });

  assert.equal(r.ok, true);
  assert.equal(f.chamadas.length, 2);

  const dns = f.chamadas[0];
  assert.match(dns.url, /zones\/zone\/dns_records$/);
  assert.equal(dns.body.type, "CNAME");
  assert.equal(dns.body.name, "marlon.gofitnow.fit");
  assert.equal(dns.body.content, "gofitnow.pages.dev");
  assert.equal(dns.body.proxied, true, "sem proxy não sai certificado");

  const pages = f.chamadas[1];
  assert.match(pages.url, /pages\/projects\/gofitnow\/domains$/);
  assert.equal(pages.body.name, "marlon.gofitnow.fit");
});

test("manda o token no cabeçalho", async () => {
  const f = fakeFetch([{ success: true }, { success: true }]);
  await cf.createSubdomain("m.gofitnow.fit", { env: ENV, fetchImpl: f });
  assert.equal(f.chamadas[0].auth, "Bearer tok");
});

test("registro que já existe NÃO é falha — repetir tem de terminar no ar", async () => {
  const f = fakeFetch([
    { success: false, errors: [{ code: 81053, message: "record already exists" }] },
    { success: true },
  ]);
  const r = await cf.createSubdomain("marlon.gofitnow.fit", { env: ENV, fetchImpl: f });
  assert.equal(r.ok, true);
});

test("domínio já ligado ao Pages também não é falha", async () => {
  const f = fakeFetch([
    { success: true },
    { success: false, errors: [{ code: 8000009, message: "already exists" }] },
  ]);
  assert.equal((await cf.createSubdomain("m.gofitnow.fit", { env: ENV, fetchImpl: f })).ok, true);
});

test("erro de verdade no DNS para tudo e diz em que passo", async () => {
  const f = fakeFetch([{ success: false, errors: [{ code: 10000, message: "sem permissão" }] }]);
  const r = await cf.createSubdomain("m.gofitnow.fit", { env: ENV, fetchImpl: f });

  assert.equal(r.ok, false);
  assert.equal(r.passo, "dns");
  assert.match(r.erro, /sem permissão/);
  assert.equal(f.chamadas.length, 1, "não pode seguir para o Pages depois de falhar o DNS");
});

test("erro no Pages é reportado com o passo", async () => {
  const f = fakeFetch([{ success: true }, { success: false, errors: [{ code: 8000, message: "ruim" }] }]);
  const r = await cf.createSubdomain("m.gofitnow.fit", { env: ENV, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.passo, "pages");
});

test("resposta ilegível não estoura, vira erro tratado", async () => {
  const f = async () => ({ status: 502, json: async () => { throw new Error("não é json"); } });
  const r = await cf.createSubdomain("m.gofitnow.fit", { env: ENV, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.erro, /ileg[íi]vel/);
});

test("domainStatus consulta e devolve o estado", async () => {
  const f = fakeFetch([{ success: true, result: { status: "active" } }]);
  const r = await cf.domainStatus("marlon.gofitnow.fit", { env: ENV, fetchImpl: f });
  assert.equal(r.status, "active");
  assert.equal(f.chamadas[0].method, "GET");
});
