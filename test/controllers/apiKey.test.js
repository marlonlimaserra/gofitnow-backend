const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const ApiKeyController = require("../../controllers/ApiKey.js");
const ApiKeyModel = require("../../model/ApiKey_model.js");
const apiDocs = require("../../lib/apiDocs.js");
const permissions = require("../../lib/permissions.js");
const { execSync } = require("node:child_process");

const USER = { _id: "u1", name: "Marlon", permissions: ["people.view"] };

function monta({ viaApiKey = false, ativas = 0, chave } = {}) {
  const criadas = [];
  const revogadas = [];

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
      apiKey: {
        async list() {
          return [{ _id: "k1", name: "Integração", prefix: "abcd1234", revoked: false }];
        },
        async countActive() {
          return ativas;
        },
        async create(userId, name) {
          const doc = { _id: "k9", user: userId, name, prefix: "novopre", revokedAt: null };
          criadas.push(doc);
          return { doc, key: "gfn_novopre_segredo" };
        },
        async data() {
          return chave;
        },
        async revoke(userId, id) {
          revogadas.push(id);
          return true;
        },
        filter: (d) => {
          const { hash, ...rest } = d;
          return rest;
        },
      },
      apiCall: {
        async list() {
          return { rows: [], total: 0 };
        },
        async summary() {
          return { total: 0, last24h: 0, errors: 0, lastAt: null };
        },
      },
    },
  });

  ApiKeyController(app);
  return { app, criadas, revogadas };
}

test("listar devolve as chaves, o teto e o limite por minuto", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/api-keys");

  assert.equal(r.status, 200);
  assert.equal(r.body.max, ApiKeyModel.MAXIMO_POR_CONTA);
  assert.equal(r.body.rateLimit, 60);
  assert.equal(r.body.rows[0].prefix, "abcd1234");
});

test("criar devolve o segredo UMA vez", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/api-keys", { body: { name: "Integração" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.key, "gfn_novopre_segredo");
});

test("listar NUNCA devolve o segredo", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/api-keys");
  assert.equal("key" in r.body.rows[0], false);
});

test("criar exige um nome de ao menos 2 letras", async () => {
  const { app, criadas } = monta();

  for (const name of ["", " ", "a", undefined]) {
    const r = await call(app, "post", "/api-keys", { body: { name } });
    assert.equal(r.status, 400, JSON.stringify(name));
  }
  assert.equal(criadas.length, 0);
});

test("uma chave de API não pode criar outra chave", async () => {
  // Senão uma credencial vazada se multiplica e sobrevive à revogação.
  const { app, criadas } = monta({ viaApiKey: true });
  const r = await call(app, "post", "/api-keys", { body: { name: "Outra" } });

  assert.equal(r.status, 403);
  assert.equal(r.body.code, "api_key_cannot_manage");
  assert.equal(criadas.length, 0);
});

test("uma chave de API não pode revogar chave", async () => {
  const { app, revogadas } = monta({ viaApiKey: true, chave: { _id: "k1" } });
  const r = await call(app, "delete", "/api-keys/k1", { params: { id: "k1" } });

  assert.equal(r.status, 403);
  assert.equal(revogadas.length, 0);
});

test("no teto de chaves, recusa e diz qual é o teto", async () => {
  const { app, criadas } = monta({ ativas: ApiKeyModel.MAXIMO_POR_CONTA });
  const r = await call(app, "post", "/api-keys", { body: { name: "Mais uma" } });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "too_many_api_keys");
  assert.match(r.body.msg, new RegExp(String(ApiKeyModel.MAXIMO_POR_CONTA)));
  assert.equal(criadas.length, 0);
});

test("revogar chave que não é sua dá 404", async () => {
  const { app, revogadas } = monta({ chave: undefined });
  const r = await call(app, "delete", "/api-keys/k1", { params: { id: "k1" } });

  assert.equal(r.status, 404);
  assert.equal(revogadas.length, 0);
});

test("revogar a própria chave funciona e vira registro de auditoria", async () => {
  const { app, revogadas } = monta({ chave: { _id: "k1", name: "Integração", prefix: "abcd1234" } });
  const r = await call(app, "delete", "/api-keys/k1", { params: { id: "k1" } });

  assert.equal(r.status, 200);
  assert.deepEqual(revogadas, ["k1"]);
  assert.equal(app.registrados.at(-1).action, "revoke_api_key");
});

test("criar também vira registro de auditoria, com o prefixo e sem o segredo", async () => {
  const { app } = monta();
  await call(app, "post", "/api-keys", { body: { name: "Integração" } });

  const log = app.registrados.at(-1);
  assert.equal(log.action, "create_api_key");
  assert.equal(log.data.extra.prefix, "novopre");
  assert.equal(JSON.stringify(log).includes("segredo"), false, "o segredo vazou para o log");
});

test("as mensagens saem no idioma do pedido", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/api-keys", {
    body: { name: "" },
    headers: { "accept-language": "fr" },
  });
  assert.match(r.body.msg, /Donnez un nom/);
});

test("a documentação sai com base, limite, grupos e o que a conta pode", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/api-docs");

  assert.equal(r.body.rateLimit, 60);
  assert.ok(r.body.baseUrl.startsWith("http"));
  assert.ok(r.body.groups.length > 0);
  assert.deepEqual(r.body.permissions, ["people.view"]);
});

// ── A documentação PÚBLICA, que o site consome ────────────────────────────
//
// Mesma lista, sem sessão. Ela existe para a página /api do site, e o que ela não
// pode fazer é vazar o que é da conta de quem está olhando.
test("a documentação pública não pede sessão", async () => {
  // App próprio, com um `verify` que EXPLODE se for chamado.
  //
  // Contar chamadas seria mais frouxo: um `verify` que roda e devolve usuário
  // deixaria o teste passar, e a rota continuaria exigindo sessão em produção
  // para quem não tem nenhuma.
  let pediuSessao = false;

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify() {
          pediuSessao = true;
          throw new Error("a rota pública não pode pedir sessão");
        },
      },
    },
    api: {},
  });

  ApiKeyController(app);

  const r = await call(app, "get", "/public/api-docs");

  assert.equal(pediuSessao, false);
  assert.equal(r.status, 200);
  assert.ok(r.body.groups.length > 0);
});

test("a pública NÃO diz o que a conta alcança", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/public/api-docs");

  // `permissions` é o que a conta de quem está logado realmente pode — dado de
  // conta, e não de catálogo. Na rota pública não existe conta nenhuma, e mandar
  // uma lista qualquer seria pior que não mandar: quem integra a leria como "o
  // que a MINHA chave pode".
  assert.equal(r.body.permissions, undefined);
});

test("a pública traz base e limite, que é o que quem integra precisa antes de tudo", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/public/api-docs");

  assert.ok(r.body.baseUrl.startsWith("http"));
  assert.equal(r.body.rateLimit, 60);
});

test("a pública leva cache de CDN", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/public/api-docs");

  // A lista muda com deploy, não com o minuto — e é a página mais lida por quem
  // não está logado.
  assert.match(r.headers["cache-control"], /s-maxage=300/);
});

test("a pública sai traduzida pelo Accept-Language, como a outra", async () => {
  const { app } = monta();

  const pt = await call(app, "get", "/public/api-docs");
  const en = await call(app, "get", "/public/api-docs", { headers: { "accept-language": "en" } });

  assert.equal(pt.body.groups[0].title, "Pessoas");
  assert.equal(en.body.groups[0].title, "People");
});

test("as duas portas mostram as MESMAS rotas", async () => {
  const { app } = monta();

  const publica = await call(app, "get", "/public/api-docs");
  const privada = await call(app, "get", "/api-docs");

  const caminhos = (r) => r.body.groups.flatMap((g) => g.items.map((i) => i.method + " " + i.path));

  // Se divergirem, uma das duas está mentindo — e a que o cliente lê é a pública.
  assert.deepEqual(caminhos(publica), caminhos(privada));
});

test("a documentação sai traduzida", async () => {
  const { app } = monta();
  const pt = await call(app, "get", "/api-docs");
  const en = await call(app, "get", "/api-docs", { headers: { "accept-language": "en" } });

  assert.equal(pt.body.groups[0].title, "Pessoas");
  assert.equal(en.body.groups[0].title, "People");
});

test("toda rota documentada EXISTE mesmo no código", () => {
  // Documentar uma rota que não existe manda quem integra bater numa porta
  // fechada.
  const reais = new Set(
    execSync(`grep -rhoE 'app\\.(get|post|put|patch|delete)\\("[^"]+"' controllers`, {
      encoding: "utf8",
      cwd: process.cwd(),
    })
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /app\.(\w+)\("([^"]+)"/.exec(l);
        return `${m[1].toUpperCase()} ${m[2]}`;
      })
  );

  const faltando = apiDocs.ROTAS.filter((r) => !reais.has(`${r.method} ${r.path}`));
  assert.deepEqual(faltando.map((r) => `${r.method} ${r.path}`), []);
});

test("toda permissão citada na documentação existe no catálogo", () => {
  assert.deepEqual(apiDocs.validate(), []);
  for (const r of apiDocs.ROTAS) {
    if (r.permission) assert.equal(permissions.isValid(r.permission), true, r.permission);
  }
});

test("a documentação não expõe rota de autenticação", () => {
  // Login por chave seria uma segunda forma de virar sessão.
  for (const r of apiDocs.ROTAS) {
    assert.ok(!r.path.startsWith("/auth"), `${r.method} ${r.path} não devia estar documentada`);
  }
});

test("cada rota documentada traz método, caminho, resumo e permissão", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/api-docs");

  for (const g of r.body.groups) {
    for (const item of g.items) {
      assert.match(item.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
      assert.ok(item.path.startsWith("/"));
      assert.ok(item.summary && !item.summary.startsWith("apiDocs."), item.key);
      if (item.permission) {
        assert.ok(item.permissionLabel && !item.permissionLabel.startsWith("permissions."), item.key);
      }
    }
  }
});
