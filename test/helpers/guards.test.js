const test = require("node:test");
const assert = require("node:assert/strict");

const AuthSession = require("../../helper/AuthSession.js");
const ReqProtected = require("../../helper/ReqProtected.js");
const { translator } = require("../../lib/i18n");

function resposta() {
  const r = { status: 200, body: undefined };
  const res = {
    status(c) {
      r.status = c;
      return res;
    },
    send(b) {
      r.body = b;
      return res;
    },
  };
  return { r, res };
}

const req = (headers = {}, lang = "pt-BR") => ({ headers, t: translator(lang), lang });

function monta({ sessao, usuario, roleName = "Tipo", permissoes = [], admin = false } = {}) {
  const apagados = [];
  const app = {
    api: {
      auth: {
        // `verify` devolve a sessão, ou false — é o contrato que o AuthSession
        // real espera.
        async verify() {
          return sessao === undefined ? false : sessao;
        },
        async deleteToken(t) {
          apagados.push(t);
        },
      },
      user: {
        async data() {
          return usuario;
        },
        async withRole(doc) {
          return { ...doc, roleName, permissions: permissoes, admin };
        },
      },
    },
    helpers: {},
  };
  app.helpers.authSession = new AuthSession(app);
  app.helpers.ReqProtected = new ReqProtected(app);
  // A porta da chave de API existe mas está fechada nestes casos: aqui o que
  // se testa é a porta da SESSÃO. A da chave tem suíte própria.
  app.helpers.apiKeyAuth = { present: () => false };
  return { app, apagados };
}

test("sem o cabeçalho session: 401 e nada mais acontece", async () => {
  const { app } = monta();
  const { r, res } = resposta();

  assert.equal(await app.helpers.authSession.protect(req(), res), false);
  assert.equal(r.status, 401);
  assert.match(r.body.msg, /não informada/);
});

test("token que não existe: 401", async () => {
  const { app } = monta({ sessao: undefined });
  const { r, res } = resposta();

  assert.equal(await app.helpers.authSession.protect(req({ session: "abc" }), res), false);
  assert.equal(r.status, 401);
  assert.match(r.body.msg, /inválida ou expirada/);
});

test("a mensagem do 401 sai no idioma do pedido", async () => {
  const { app } = monta();
  const { r, res } = resposta();

  await app.helpers.authSession.protect(req({}, "fr"), res);
  assert.match(r.body.msg, /Session non fournie/);
});

test("token válido apontando para conta desativada derruba a sessão", async () => {
  // Não basta recusar: o token tem de morrer, senão continua valendo.
  const { app, apagados } = monta({
    sessao: { token: "tok", user: "u1" },
    usuario: { _id: "u1", active: 0 },
  });
  const { r, res } = resposta();

  assert.equal(await app.helpers.ReqProtected.verify(req({ session: "tok" }), res), false);
  assert.equal(r.status, 401);
  assert.deepEqual(apagados, ["tok"]);
});

test("token válido apontando para conta apagada também derruba a sessão", async () => {
  const { app, apagados } = monta({ sessao: { token: "tok", user: "u1" }, usuario: null });
  const { res } = resposta();

  await app.helpers.ReqProtected.verify(req({ session: "tok" }), res);
  assert.deepEqual(apagados, ["tok"]);
});

test("sem a permissão: 403, e a chave exigida vai na resposta", async () => {
  const { app } = monta({
    sessao: { token: "tok", user: "u1" },
    usuario: { _id: "u1", active: 1 },
    permissoes: ["people.view"],
  });
  const { r, res } = resposta();

  assert.equal(await app.helpers.ReqProtected.can(req({ session: "tok" }), res, "roles.manage"), false);
  assert.equal(r.status, 403);
  assert.equal(r.body.permission, "roles.manage");
});

test("com a permissão: devolve o usuário", async () => {
  const { app } = monta({
    sessao: { token: "tok", user: "u1" },
    usuario: { _id: "u1", active: 1 },
    permissoes: ["people.view"],
  });
  const { res } = resposta();

  const user = await app.helpers.ReqProtected.can(req({ session: "tok" }), res, "people.view");
  assert.equal(user._id, "u1");
});

// O interruptor mestre do admin NÃO vive aqui: quem expande `admin` na lista
// completa é o withRole do modelo, e o guarda só lê a lista pronta. O teste
// disso está em test/model/withRole.test.js, na camada que decide.

test("canAll exige TODAS e denuncia a primeira que falta", async () => {
  const { app } = monta({
    sessao: { token: "tok", user: "u1" },
    usuario: { _id: "u1", active: 1 },
    permissoes: ["people.view"],
  });
  const { r, res } = resposta();

  const ok = await app.helpers.ReqProtected.canAll(req({ session: "tok" }), res, [
    "people.view",
    "workouts.manage",
  ]);
  assert.equal(ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.body.permission, "workouts.manage");
});

test("canAll passa quando tem todas", async () => {
  const { app } = monta({
    sessao: { token: "tok", user: "u1" },
    usuario: { _id: "u1", active: 1 },
    permissoes: ["people.view", "workouts.manage"],
  });
  const { res } = resposta();

  const user = await app.helpers.ReqProtected.canAll(req({ session: "tok" }), res, [
    "people.view",
    "workouts.manage",
  ]);
  assert.equal(user._id, "u1");
});
