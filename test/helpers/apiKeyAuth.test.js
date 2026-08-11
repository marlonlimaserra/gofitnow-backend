const test = require("node:test");
const assert = require("node:assert/strict");

const ApiKeyAuth = require("../../helper/ApiKeyAuth.js");
const rateLimit = require("../../lib/rateLimit.js");
const { translator } = require("../../lib/i18n");

const CHAVE = { _id: "k1", user: "u1", prefix: "abcd1234", name: "Integração" };

function monta({ chave = CHAVE, usuario = { _id: "u1", active: 1 } } = {}) {
  const registrados = [];
  const tocadas = [];

  const app = {
    api: {
      apiKey: {
        async verify(k) {
          return k === "gfn_abcd1234_valida" ? chave : undefined;
        },
        touch(id) {
          tocadas.push(id);
        },
      },
      apiCall: {
        record(d) {
          registrados.push(d);
        },
      },
      user: {
        async data() {
          return usuario;
        },
        async withRole(doc) {
          return { ...doc, permissions: ["people.view"], admin: false };
        },
      },
    },
  };

  return { auth: new ApiKeyAuth(app), registrados, tocadas };
}

function resposta() {
  const r = { status: 200, body: undefined, headers: {} };
  const res = {
    status(c) {
      r.status = c;
      return res;
    },
    send(b) {
      r.body = b;
      return res;
    },
    setHeader(k, v) {
      r.headers[k] = v;
    },
  };
  return { r, res };
}

const req = (headers = {}, lang = "pt-BR") => ({
  headers,
  method: "GET",
  originalUrl: "/people",
  clientIp: "203.0.113.9",
  t: translator(lang),
});

test.beforeEach(() => rateLimit.reset());

test("lê a chave do Authorization: Bearer", () => {
  const { auth } = monta();
  assert.equal(auth.readKey(req({ authorization: "Bearer gfn_x" })), "gfn_x");
  assert.equal(auth.readKey(req({ authorization: "bearer gfn_x" })), "gfn_x", "case-insensitive");
});

test("lê a chave do X-API-Key", () => {
  // Duas formas aceitas para quem integra não ter de descobrir qual é.
  const { auth } = monta();
  assert.equal(auth.readKey(req({ "x-api-key": "gfn_x" })), "gfn_x");
});

test("sem chave, present() é falso — e é o que deixa o 401 de sessão acontecer", () => {
  const { auth } = monta();
  assert.equal(auth.present(req()), false);
  assert.equal(auth.present(req({ authorization: "Bearer gfn_x" })), true);
});

test("chave válida devolve o usuário com as permissões dele", async () => {
  const { auth, tocadas } = monta();
  const { res } = resposta();

  const user = await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res);
  assert.equal(user._id, "u1");
  assert.deepEqual(user.permissions, ["people.view"]);
  assert.deepEqual(tocadas, ["k1"], "o último uso tem de ser registrado");
});

test("chave inválida: 401 e a tentativa vai para o log", async () => {
  // É justamente o que o dono precisa ver: alguém usando chave que não vale.
  const { auth, registrados } = monta();
  const { r, res } = resposta();

  assert.equal(await auth.protect(req({ authorization: "Bearer gfn_errada" }), res), false);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "invalid_api_key");
  assert.equal(registrados.length, 1);
  assert.equal(registrados[0].status, 401);
  assert.equal(registrados[0].ip, "203.0.113.9");
});

test("sem chave nenhuma: 401 com código próprio", async () => {
  const { auth } = monta();
  const { r, res } = resposta();

  assert.equal(await auth.protect(req(), res), false);
  assert.equal(r.body.code, "no_api_key");
});

test("os cabeçalhos de limite acompanham toda resposta autenticada", async () => {
  const { auth } = monta();
  const { r, res } = resposta();

  await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res);
  assert.equal(r.headers["X-RateLimit-Limit"], 60);
  assert.equal(r.headers["X-RateLimit-Remaining"], 59);
});

test("passando de 60 numa janela: 429, com Retry-After e registro", async () => {
  const { auth, registrados } = monta();
  const pedido = req({ authorization: "Bearer gfn_abcd1234_valida" });

  for (let i = 0; i < 60; i++) await auth.protect(pedido, resposta().res);

  const { r, res } = resposta();
  assert.equal(await auth.protect(pedido, res), false);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "rate_limited");
  assert.ok(r.headers["Retry-After"] >= 1);
  assert.equal(registrados.at(-1).status, 429);
  assert.equal(registrados.at(-1).prefix, "abcd1234", "o log tem de dizer QUAL chave estourou");
});

test("a mensagem de limite diz o número e o tempo de espera", async () => {
  const { auth } = monta();
  const pedido = req({ authorization: "Bearer gfn_abcd1234_valida" });
  for (let i = 0; i < 60; i++) await auth.protect(pedido, resposta().res);

  const { r, res } = resposta();
  await auth.protect(pedido, res);
  assert.match(r.body.msg, /60/);
  assert.ok(!/{{/.test(r.body.msg), "sobrou marca de interpolação");
});

test("as mensagens saem no idioma do pedido", async () => {
  const { auth } = monta();
  const { r, res } = resposta();

  await auth.protect(req({ authorization: "Bearer gfn_errada" }, "fr"), res);
  assert.match(r.body.msg, /Clé d’API invalide/);
});

test("chave de conta desativada não entra", async () => {
  // Desativar a conta tem de fechar TODAS as portas, não só o login.
  const { auth } = monta({ usuario: { _id: "u1", active: 0 } });
  const { r, res } = resposta();

  assert.equal(await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res), false);
  assert.equal(r.status, 401);
});

test("chave de conta apagada não entra", async () => {
  const { auth } = monta({ usuario: null });
  const { r, res } = resposta();

  assert.equal(await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res), false);
  assert.equal(r.status, 401);
});

test("marca a requisição como vinda de chave", async () => {
  // É o que impede uma chave de criar outras chaves.
  const { auth } = monta();
  const pedido = req({ authorization: "Bearer gfn_abcd1234_valida" });

  await auth.protect(pedido, resposta().res);
  assert.equal(pedido._viaApiKey, true);
  assert.equal(pedido._apiKey._id, "k1");
});
