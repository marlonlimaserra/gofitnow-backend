const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const TenantController = require("../../controllers/Tenant.js");
const themeLib = require("../../lib/theme.js");

const USER = { _id: "u1", name: "Marlon" };

function monta({
  tenant,
  livre = true,
  viaApiKey = false,
  pages = false,
  aponta = { ok: false, erro: "not_found" },
  certificado = { ok: true, status: "active" },
} = {}) {
  const salvos = [];
  const reservas = [];
  const dominios = [];
  const estados = [];
  const naCloudflare = [];
  const faxina = [];

  const app = fakeApp({
    // As integrações de rede entram como dublê: um teste que batesse na
    // Cloudflare ou no DNS de verdade seria um teste que falha no avião.
    cloudflare: {
      isConfigured: () => false,
      missingConfig: () => ["zoneId"],
      isPagesConfigured: () => pages,
      missingPagesConfig: () => ["token", "accountId"],
      async createSubdomain() {
        return { ok: true };
      },
      async addPagesDomain(host) {
        naCloudflare.push({ acao: "add", host });
        return { ok: true, host };
      },
      async removePagesDomain(host) {
        naCloudflare.push({ acao: "remove", host });
        return { ok: true };
      },
      async domainStatus() {
        return certificado;
      },
    },
    dnscheck: {
      async pointsTo() {
        return aponta;
      },
    },
    helpers: {
      ReqProtected: {
        async verify(req) {
          req._viaApiKey = viaApiKey;
          return USER;
        },
      },
    },
    api: {
      // O registro central: é ele que diz de quem é um endereço antes de
      // existir sessão.
      center: {
        async byHost(host) {
          if (!tenant) return undefined;
          const sub = tenant.subdomain ? `${tenant.subdomain}.gofitnow.fit` : null;
          return host === sub || host === tenant.customDomain
            ? { instance: "marlon" }
            : undefined;
        },
      },
      brandImage: {
        async pruneUnused(userId, emUso) {
          faxina.push(emUso);
          return 0;
        },
      },
      tenant: {
        async dataByUser() {
          return tenant;
        },
        async dataBySubdomain(s) {
          return tenant && tenant.subdomain === s ? tenant : undefined;
        },
        async dataByHost(host) {
          if (!tenant) return undefined;
          const sub = tenant.subdomain ? `${tenant.subdomain}.gofitnow.fit` : null;
          return host === sub || host === tenant.customDomain ? tenant : undefined;
        },
        async isFree() {
          return livre;
        },
        async isDomainFree() {
          return livre;
        },
        async claim(userId, nome) {
          reservas.push(nome);
          return livre
            ? { ok: true, subdomain: nome, host: `${nome}.gofitnow.fit` }
            : { ok: false, erro: "taken" };
        },
        async claimCustomDomain(userId, host) {
          dominios.push(host);
          return livre ? { ok: true, customDomain: host } : { ok: false, erro: "taken" };
        },
        async setStatus() {},
        async setCustomStatus(userId, status, erro) {
          estados.push({ status, erro: erro || null });
        },
        async removeCustomDomain() {
          estados.push({ status: "removido", erro: null });
        },
        async saveTheme(userId, entrada) {
          const limpo = themeLib.sanitize(entrada);
          salvos.push(limpo);
          return limpo;
        },
        publicTheme(doc) {
          const t = themeLib.sanitize(doc?.theme);
          return { theme: t, scale: themeLib.scale(t.brand) };
        },
      },
    },
  });

  TenantController(app);
  return { app, salvos, reservas, dominios, estados, naCloudflare, faxina };
}

test("o tema público sai sem sessão nenhuma", async () => {
  const { app } = monta({ tenant: { subdomain: "marlon", theme: { brand: "#2563eb" } } });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.theme.brand, "#2563eb");
  assert.equal(r.body.custom, true);
});

test("o tema público NÃO entrega de quem é o domínio", async () => {
  // Um endereço aberto não pode dizer quem existe nem de quem é.
  const { app } = monta({
    tenant: { subdomain: "marlon", user: "u1", theme: { brand: "#2563eb" } },
  });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  const texto = JSON.stringify(r.body);
  assert.ok(!texto.includes("u1"), "vazou o id do dono");
  assert.deepEqual(Object.keys(r.body).sort(), ["custom", "scale", "theme"]);
});

test("host desconhecido devolve o tema padrão, não 404", async () => {
  // A tela de login tem de abrir bonita em qualquer endereço, inclusive num
  // digitado errado.
  const { app } = monta({ tenant: undefined });
  for (const host of ["ninguem.gofitnow.fit", "outro.com", "app.gofitnow.fit", ""]) {
    const r = await call(app, "get", "/public/theme", { query: { host } });
    assert.equal(r.status, 200, host);
    assert.equal(r.body.custom, false, host);
    assert.equal(r.body.theme.brand, themeLib.defaults().brand, host);
  }
});

test("o tema público vem com a escala pronta", async () => {
  const { app } = monta({ tenant: { subdomain: "marlon", theme: { brand: "#dc2626" } } });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.equal(Object.keys(r.body.scale).length, 10);
  assert.match(r.body.scale["600"], /^#[0-9a-f]{6}$/);
});

test("escolher domínio reserva o nome", async () => {
  const { app, reservas } = monta();
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "Marlon" } });

  assert.equal(r.status, 200);
  assert.deepEqual(reservas, ["marlon"]);
  assert.equal(r.body.host, "marlon.gofitnow.fit");
});

test("nome inválido é recusado antes de reservar", async () => {
  const { app, reservas } = monta();
  for (const ruim of ["a", "com espaço", "com.ponto", "-x", ""]) {
    const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: ruim } });
    assert.equal(r.status, 400, JSON.stringify(ruim));
  }
  assert.deepEqual(reservas, []);
});

test("nome reservado do sistema é recusado", async () => {
  const { app } = monta();
  for (const r of ["api", "www", "admin"]) {
    const res = await call(app, "post", "/me/tenant/domain", { body: { subdomain: r } });
    assert.equal(res.status, 400, r);
  }
});

test("nome de outra conta responde 409", async () => {
  const { app } = monta({ livre: false });
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "marlon" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "taken");
});

test("sem credencial de DNS o nome fica reservado assim mesmo", async () => {
  // Quem escolheu não pode perder o nome porque a integração não está ligada.
  const { app, reservas } = monta();
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "marlon" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.status, "pending");
  assert.equal(r.body.dnsReady, false);
  assert.deepEqual(reservas, ["marlon"]);
});

test("uma chave de API não escolhe domínio", async () => {
  const { app, reservas } = monta({ viaApiKey: true });
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "marlon" } });

  assert.equal(r.status, 403);
  assert.deepEqual(reservas, []);
});

test("a checagem de disponibilidade explica o motivo", async () => {
  const { app } = monta({ livre: true });
  assert.equal((await call(app, "get", "/me/tenant/available", { query: { subdomain: "x" } })).body.reason, "invalid");
  assert.equal((await call(app, "get", "/me/tenant/available", { query: { subdomain: "api" } })).body.reason, "reserved");

  const ok = await call(app, "get", "/me/tenant/available", { query: { subdomain: "marlon" } });
  assert.equal(ok.body.free, true);
  assert.equal(ok.body.host, "marlon.gofitnow.fit");
});

// ── Domínio próprio ─────────────────────────────────────────────────────────

test("o tema público também sai pelo domínio próprio do profissional", async () => {
  // É o ponto do recurso: `treinos.marlon.com.br` tem de abrir com a marca dele.
  const { app } = monta({
    tenant: { customDomain: "treinos.marlon.com.br", theme: { brand: "#7c3aed" } },
  });
  const r = await call(app, "get", "/public/theme", { query: { host: "treinos.marlon.com.br" } });

  assert.equal(r.body.custom, true);
  assert.equal(r.body.theme.brand, "#7c3aed");
});

test("cadastrar domínio próprio guarda o host e diz para onde apontar", async () => {
  const { app, dominios } = monta({ pages: true });
  const r = await call(app, "post", "/me/tenant/custom-domain", {
    body: { domain: "https://Treinos.Marlon.com.br/" },
  });

  assert.equal(r.status, 200);
  assert.deepEqual(dominios, ["treinos.marlon.com.br"], "guardou o host limpo, não o que foi colado");
  assert.equal(r.body.cnameTarget, "app.gofitnow.fit");
});

test("cadastrar domínio próprio NÃO precisa da credencial de DNS", async () => {
  // O DNS é do profissional. Isto é o que destrava o recurso com o token de hoje.
  const { app, naCloudflare } = monta({ pages: true });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.status, 200);
  assert.deepEqual(naCloudflare, [{ acao: "add", host: "marlon.com.br" }], "só o Pages, nada de DNS");
});

test("enquanto o CNAME não aponta, o domínio fica pendente", async () => {
  const { app, estados } = monta({ pages: true, aponta: { ok: false, erro: "not_found" } });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.body.customStatus, "pending");
  assert.equal(r.body.customError, "not_found");
  assert.deepEqual(estados.at(-1), { status: "pending", erro: "not_found" });
});

test("CNAME apontado e certificado pronto põe o domínio no ar", async () => {
  const { app } = monta({
    pages: true,
    aponta: { ok: true, via: "cname", found: "app.gofitnow.fit" },
    certificado: { ok: true, status: "active" },
  });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.body.customStatus, "active");
  assert.equal(r.body.pointedAt, "app.gofitnow.fit");
});

test("CNAME certo mas certificado ainda saindo não é 'no ar'", async () => {
  // Dizer "no ar" aqui mandaria a pessoa abrir um endereço com erro de SSL.
  const { app } = monta({
    pages: true,
    aponta: { ok: true, found: "app.gofitnow.fit" },
    certificado: { ok: true, status: "pending" },
  });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.body.customStatus, "pending");
  assert.equal(r.body.customError, "certificate_pending");
});

test("domínio inválido é recusado antes de guardar", async () => {
  const { app, dominios } = monta({ pages: true });
  for (const ruim of ["", "marlon", "localhost", "com espaço.br", "192.168.0.1"]) {
    const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: ruim } });
    assert.equal(r.status, 400, JSON.stringify(ruim));
  }
  assert.deepEqual(dominios, []);
});

test("endereço nosso não entra como domínio próprio", async () => {
  // Senão o mesmo host teria dois donos possíveis.
  const { app, dominios } = monta({ pages: true });
  for (const nosso of ["marlon.gofitnow.fit", "gofitnow.fit"]) {
    const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: nosso } });
    assert.equal(r.status, 400, nosso);
    assert.equal(r.body.code, "ours", nosso);
  }
  assert.deepEqual(dominios, []);
});

test("domínio de outra conta responde 409", async () => {
  const { app } = monta({ pages: true, livre: false });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "taken");
});

test("uma chave de API não cadastra nem remove domínio próprio", async () => {
  const { app, dominios } = monta({ pages: true, viaApiKey: true, tenant: { customDomain: "m.com.br" } });

  assert.equal((await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "m.com.br" } })).status, 403);
  assert.equal((await call(app, "delete", "/me/tenant/custom-domain")).status, 403);
  assert.deepEqual(dominios, []);
});

test("verificar de novo tenta religar ao Pages antes de conferir", async () => {
  // Quem ficou com o cadastro falhado tem de sair do buraco apertando o botão.
  const { app, naCloudflare } = monta({
    pages: true,
    tenant: { customDomain: "marlon.com.br", customStatus: "failed" },
    aponta: { ok: true, found: "app.gofitnow.fit" },
  });
  const r = await call(app, "post", "/me/tenant/custom-domain/verify");

  assert.equal(r.status, 200);
  assert.equal(r.body.customStatus, "active");
  assert.deepEqual(naCloudflare, [{ acao: "add", host: "marlon.com.br" }]);
});

test("verificar sem domínio cadastrado é 404", async () => {
  const { app } = monta({ pages: true, tenant: { subdomain: "marlon" } });
  const r = await call(app, "post", "/me/tenant/custom-domain/verify");

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "no_domain");
});

test("remover apaga do banco mesmo com a Cloudflare fora do ar", async () => {
  // Senão o endereço fica preso a alguém que já não o quer, e ninguém mais usa.
  const { app, estados, naCloudflare } = monta({
    pages: false,
    tenant: { customDomain: "marlon.com.br" },
  });
  const r = await call(app, "delete", "/me/tenant/custom-domain");

  assert.equal(r.status, 200);
  assert.equal(r.body.customDomain, "");
  assert.deepEqual(estados.at(-1), { status: "removido", erro: null });
  assert.deepEqual(naCloudflare, [], "sem credencial não tenta, e o banco já ficou limpo");
});

test("a checagem de disponibilidade responde para domínio inteiro também", async () => {
  const { app } = monta({ livre: true });

  const ok = await call(app, "get", "/me/tenant/available", { query: { domain: "marlon.com.br" } });
  assert.equal(ok.body.free, true);
  assert.equal(ok.body.host, "marlon.com.br");

  const nosso = await call(app, "get", "/me/tenant/available", { query: { domain: "x.gofitnow.fit" } });
  assert.equal(nosso.body.reason, "ours");

  const ruim = await call(app, "get", "/me/tenant/available", { query: { domain: "localhost" } });
  assert.equal(ruim.body.reason, "invalid");
});

test("a tela recebe o alvo do CNAME e o estado do domínio próprio", async () => {
  const { app } = monta({ tenant: { customDomain: "marlon.com.br", customStatus: "pending" } });
  const r = await call(app, "get", "/me/tenant");

  assert.equal(r.body.customDomain, "marlon.com.br");
  assert.equal(r.body.customStatus, "pending");
  assert.equal(r.body.cnameTarget, "app.gofitnow.fit");
  assert.equal(typeof r.body.pagesReady, "boolean");
});

test("salvar tema limpa o que veio de fora", async () => {
  const { app, salvos } = monta();
  const r = await call(app, "put", "/me/tenant/theme", {
    body: { brand: "red; background: url(x)", layout: "inventado", photos: ["javascript:alert(1)"] },
  });

  assert.equal(r.status, 200);
  assert.equal(salvos[0].brand, themeLib.defaults().brand);
  assert.equal(salvos[0].layout, themeLib.defaults().layout);
  assert.deepEqual(salvos[0].photos, []);
});

test("salvar tema recolhe as imagens que ele deixou de usar", async () => {
  // Trocar a logo não pode deixar a antiga pendurada no banco, e uma imagem
  // enviada e não usada também não fica.
  const { app, faxina } = monta();
  await call(app, "put", "/me/tenant/theme", {
    body: {
      logo: "https://backend.gofitnow.fit/public/brand/a",
      photo: "https://backend.gofitnow.fit/public/brand/b",
      photos: ["https://backend.gofitnow.fit/public/brand/c"],
    },
  });

  assert.equal(faxina.length, 1);
  assert.equal(faxina[0].length, 3, "a logo, a foto e as do carrossel, todas de uma vez");
});

test("a faxina falhando NÃO derruba o salvar", async () => {
  // O tema já está gravado; falhar aqui faria a tela dizer que não salvou o
  // que salvou.
  const { app } = monta();
  app.api.brandImage.pruneUnused = async () => {
    throw new Error("banco fora do ar");
  };

  const r = await call(app, "put", "/me/tenant/theme", { body: { brand: "#2563eb" } });
  assert.equal(r.status, 200);
});

test("salvar tema devolve a escala junto, para a tela aplicar de imediato", async () => {
  const { app } = monta();
  const r = await call(app, "put", "/me/tenant/theme", { body: { brand: "#2563eb" } });
  assert.equal(r.body.theme.brand, "#2563eb");
  assert.equal(Object.keys(r.body.scale).length, 10);
});

test("a tela do profissional recebe o que precisa para se montar", async () => {
  const { app } = monta({ tenant: { subdomain: "marlon", status: "pending", theme: {} } });
  const r = await call(app, "get", "/me/tenant");

  assert.equal(r.body.host, "marlon.gofitnow.fit");
  assert.equal(r.body.status, "pending");
  assert.ok(r.body.layouts.length >= 3, "as composições");
  assert.ok(r.body.backgrounds.length >= 4, "os fundos, que agora são escolha à parte");
  assert.ok(r.body.effects.length >= 3);
  assert.ok(r.body.motions.length >= 3);
  assert.ok(r.body.logoRange.min < r.body.logoRange.max);
  assert.ok(r.body.speedRange.min < r.body.speedRange.max);
  assert.ok(r.body.presets.length >= 4);
  assert.equal(typeof r.body.dnsReady, "boolean");
});
