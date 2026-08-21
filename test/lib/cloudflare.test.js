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

// ── Domínio próprio do profissional ─────────────────────────────────────────

test("o domínio próprio não precisa da zona — é o que destrava com o token de hoje", () => {
  const semZona = { ...ENV, CLOUDFLARE_ZONE_ID: "" };
  assert.equal(cf.isConfigured(semZona), false, "o subdomínio ainda espera o DNS");
  assert.equal(cf.isPagesConfigured(semZona), true, "o domínio próprio já dá para ligar");
  assert.deepEqual(cf.missingPagesConfig({}), ["token", "accountId"]);
});

test("ligar domínio próprio NÃO toca no DNS", async () => {
  // O DNS é do profissional. Uma chamada a mais aqui seria mexer em zona alheia.
  const f = fakeFetch([{ success: true, result: {} }]);
  const r = await cf.addPagesDomain("treinos.marlon.com.br", { env: ENV, fetchImpl: f });

  assert.equal(r.ok, true);
  assert.equal(f.chamadas.length, 1);
  assert.match(f.chamadas[0].url, /pages\/projects\/gofitnow\/domains$/);
  assert.equal(f.chamadas[0].body.name, "treinos.marlon.com.br");
});

test("domínio próprio já ligado não é falha", async () => {
  const f = fakeFetch([{ success: false, errors: [{ code: 8000009, message: "already exists" }] }]);
  assert.equal((await cf.addPagesDomain("m.com.br", { env: ENV, fetchImpl: f })).ok, true);
});

test("erro de verdade ao ligar o domínio próprio é reportado", async () => {
  const f = fakeFetch([{ success: false, errors: [{ code: 8000, message: "ruim" }] }]);
  const r = await cf.addPagesDomain("m.com.br", { env: ENV, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.passo, "pages");
});

test("sem token nem tenta ligar o domínio próprio", async () => {
  const r = await cf.addPagesDomain("m.com.br", { env: {}, fetchImpl: fakeFetch([]) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.faltando, ["token", "accountId"]);
});

test("remover o domínio desliga só do projeto", async () => {
  const f = fakeFetch([{ success: true }]);
  const r = await cf.removePagesDomain("m.com.br", { env: ENV, fetchImpl: f });

  assert.equal(r.ok, true);
  assert.equal(f.chamadas[0].method, "DELETE");
  assert.match(f.chamadas[0].url, /domains\/m\.com\.br$/);
});

test("remover o que já não está lá dá o mesmo resultado que remover", async () => {
  const f = fakeFetch([{ success: false, errors: [{ code: 8000007, message: "Domain not found" }] }]);
  assert.equal((await cf.removePagesDomain("m.com.br", { env: ENV, fetchImpl: f })).ok, true);
});

test("domainStatus consulta e devolve o estado", async () => {
  const f = fakeFetch([{ success: true, result: { status: "active" } }]);
  const r = await cf.domainStatus("marlon.gofitnow.fit", { env: ENV, fetchImpl: f });
  assert.equal(r.status, "active");
  assert.equal(f.chamadas[0].method, "GET");
});

// ── O CURINGA ───────────────────────────────────────────────────────────────
//
// Quem serve `*.gofitnow.fit` é um Worker com rota curinga. Nesse arranjo o
// cadastro não fala com a Cloudflare: nem DNS, nem domínio no Pages, nem espera
// de certificado.
const ENV_CURINGA = { CLOUDFLARE_WILDCARD_ROUTE: "1" };

// `fetch` que ESTOURA. É a única forma de provar "nenhuma chamada saiu": um
// espião que conta chamadas passaria igual se o código chamasse e ignorasse.
const semRede = () => {
  throw new Error("não deveria chamar a Cloudflare");
};

test("com curinga, o subdomínio não gasta uma chamada — nem credencial exige", async () => {
  assert.equal(cf.isConfigured(ENV_CURINGA, "novo.gofitnow.fit"), true);
  assert.deepEqual(cf.missingConfig(ENV_CURINGA, "novo.gofitnow.fit"), []);

  const r = await cf.createSubdomain("novo.gofitnow.fit", { env: ENV_CURINGA, fetchImpl: semRede });
  assert.deepEqual(r, { ok: true, host: "novo.gofitnow.fit", curinga: true });
});

test("com curinga, o endereço já nasce pronto — a tela de espera não trava", async () => {
  const r = await cf.domainStatus("novo.gofitnow.fit", { env: ENV_CURINGA, fetchImpl: semRede });
  assert.equal(r.ok, true);
  assert.equal(r.status, "active");
});

test("o curinga vale só para o domínio base — o domínio próprio do cliente não muda", async () => {
  assert.equal(cf.usaCuringa("treinos.marlon.com.br", ENV_CURINGA), false);

  const r = await cf.createSubdomain("treinos.marlon.com.br", {
    env: ENV_CURINGA,
    fetchImpl: semRede,
  });
  assert.equal(r.ok, false);
  assert.equal(r.erro, "cloudflare_not_configured");

  // E o estado dele continua sendo pergunta de verdade ao Pages.
  const f = fakeFetch([{ success: true, result: { status: "active" } }]);
  const s = await cf.domainStatus("treinos.marlon.com.br", { env: { ...ENV, ...ENV_CURINGA }, fetchImpl: f });
  assert.equal(s.status, "active");
  assert.equal(f.chamadas.length, 1);
});

test("o próprio domínio base, sem subdomínio, não é curinga", () => {
  // `gofitnow.fit` não casa com `*.gofitnow.fit` — e não é endereço de cliente.
  assert.equal(cf.usaCuringa("gofitnow.fit", ENV_CURINGA), false);
});

test("sem a chave, nada muda: o caminho antigo continua exigindo a zona", async () => {
  assert.equal(cf.usaCuringa("novo.gofitnow.fit", {}), false);
  const r = await cf.createSubdomain("novo.gofitnow.fit", { env: {}, fetchImpl: semRede });
  assert.equal(r.ok, false);
  assert.deepEqual(r.faltando, ["token", "accountId", "zoneId"]);
});
