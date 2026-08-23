const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const AuthController = require("../../controllers/Auth.js");
const UserController = require("../../controllers/User.js");

// O USUÁRIO que sai pela API vem VESTIDO com o que é da conta.
//
// O vocabulário mora na conta, mas a interface inteira o lê de
// `user.peopleSingular` — e o documento do usuário ainda carrega um FÓSSIL: a
// palavra que o dono escolheu no cadastro, gravada por `updateSelf` e nunca mais
// atualizada.
//
// O defeito que este arquivo pega: o `GET /me` vestia e o `/auth/verify` NÃO — e
// é o verify que o app usa para botar. Salvar a palavra nova funcionava, a tela
// trocava na hora... e o F5 ressuscitava a antiga. Um F5 que desfaz o que foi
// salvo faz a pessoa desconfiar do salvar inteiro.
const FOSSIL = {
  _id: "u1",
  name: "Marlon",
  type: "trainer",
  // O fóssil: o que ficou gravado no documento no dia do cadastro.
  peopleSingular: "paciente",
  peoplePlural: "pacientes",
};

function monta({ verificado = FOSSIL } = {}) {
  const app = fakeApp({
    api: {
      tenant: {
        // A palavra DA CONTA, que é a que vale.
        wordsOfInstance: async () => ({ singular: "aluno", plural: "alunos" }),
        languageOfInstance: async () => "pt-BR",
        // O vestir de verdade, do modelo — é ele que está em teste aqui, então
        // entra inteiro em vez de um dublê.
        async vestirComAConta(usuario) {
          const Tenant = require("../../model/Tenant_model.js");
          return Tenant.prototype.vestirComAConta.call(this, usuario);
        },
      },
      auth: { registerToken: async () => "tok" },
      // Quantos profissionais acompanham esta pessoa — o vestir passou a
      // carregar isso junto, para a tela saber já no boot se oferece a área de
      // quem é atendido.
      link: { countProfessionalsOf: async () => 0 },
      user: {
        authenticate: async () => FOSSIL,
        withRole: async (u) => ({ ...u, roleName: "Administrador" }),
        data: async () => FOSSIL,
      },
      passwordReset: {},
    },
    helpers: {
      ReqProtected: {
        verify: async () => verificado,
        has: () => true,
      },
    },
  });

  // O vestir de verdade lê `this.app.api` — sem esta linha ele cai no catch e
  // devolve o fóssil, que é exatamente o defeito que este arquivo existe para
  // pegar. (Foi o que aconteceu quando o campo `acompanhado` entrou: três
  // testes falharam por causa do dublê, não do código.)
  app.api.tenant.app = app;

  AuthController(app);
  UserController(app);
  return app;
}

test("o /auth/verify devolve a palavra DA CONTA, não o fóssil do documento", async () => {
  const app = monta();

  const res = await call(app, "get", "/auth/verify");

  assert.equal(res.status, 200);
  assert.equal(res.body.user.peopleSingular, "aluno");
  assert.equal(res.body.user.peoplePlural, "alunos");
});

test("o login idem — a resposta dele vira o `user` do app até o próximo boot", async () => {
  const app = monta();

  const res = await call(app, "post", "/auth", {
    body: { email: "m@x.com", password: "x" },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.peopleSingular, "aluno");
  // E o vestir não pode desfazer o withRole: os dois compõem.
  assert.equal(res.body.user.roleName, "Administrador");
});

test("o /me continua vestindo — é o mesmo vestir, num lugar só", async () => {
  const app = monta();

  const res = await call(app, "get", "/me");

  assert.equal(res.status, 200);
  assert.equal(res.body.peopleSingular, "aluno");
  assert.equal(res.body.accountLanguage, "pt-BR");
});

test("a conta indisponível NÃO derruba o verify — cai no fóssil, que funciona", async () => {
  const app = monta();
  app.api.tenant.wordsOfInstance = async () => {
    throw new Error("banco fora");
  };

  const res = await call(app, "get", "/auth/verify");

  // A rota responde: sem ela ninguém entra em nada. A palavra fica a que der.
  assert.equal(res.status, 200);
  assert.equal(res.body.user.peopleSingular, "paciente");
});
