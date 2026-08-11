const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const TenantController = require("../../controllers/Tenant.js");
const themeLib = require("../../lib/theme.js");

const USER = { _id: "u1", name: "Marlon" };

function monta({ tenant, livre = true, viaApiKey = false } = {}) {
  const salvos = [];
  const reservas = [];

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify(req) {
          req._viaApiKey = viaApiKey;
          return USER;
        },
      },
    },
    api: {
      tenant: {
        async dataByUser() {
          return tenant;
        },
        async dataBySubdomain(s) {
          return tenant && tenant.subdomain === s ? tenant : undefined;
        },
        async isFree() {
          return livre;
        },
        async claim(userId, nome) {
          reservas.push(nome);
          return livre
            ? { ok: true, subdomain: nome, host: `${nome}.gofitnow.fit` }
            : { ok: false, erro: "taken" };
        },
        async setStatus() {},
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
  return { app, salvos, reservas };
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
  assert.ok(r.body.layouts.length >= 4);
  assert.ok(r.body.presets.length >= 4);
  assert.equal(typeof r.body.dnsReady, "boolean");
});
