const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");

// O PRIMEIRO ACESSO de uma instância.
//
// Provisionar cria as collections e os índices — e mais nada. Um banco com 28
// collections e nenhum usuário é uma tela de login sem ninguém para entrar, que
// foi exatamente o que aconteceu com os dois primeiros clientes: o acesso saía
// de um `node database/init.js` no servidor, por ssh, um por um.
//
// Esta rota é aquele comando, alcançável pelo painel. Ela mora atrás de uma
// CHAVE DE SERVIÇO, não de sessão — e é isso que decide a regra mais importante
// daqui: ela cria o PRIMEIRO usuário e nunca um segundo. Um jeito de
// acrescentar administrador em qualquer cliente, atrás de uma chave só, seria
// uma porta de entrada para todos eles.
const CHAVE = "chave-interna-de-teste";

// A rota só existe com `INTERNAL_KEY` no ambiente — sem chave não há porta.
process.env.INTERNAL_KEY = CHAVE;
const InternalController = require("../../controllers/Internal.js");

function monta({ registrada = true, profissionais = 0, falha = null } = {}) {
  const criados = [];

  const app = fakeApp({
    crypto: require("crypto"),
    api: {
      center: {
        async byInstance(nome) {
          return registrada ? { instance: nome, active: true } : undefined;
        },
        forget() {},
      },
      user: {
        async countTrainers() {
          return profissionais;
        },
        async insertTrainer(dados) {
          if (falha) return { erro: falha };
          criados.push(dados);
          return "u1";
        },
      },
    },
  });

  InternalController(app);
  return { app, criados };
}

const DADOS = { name: "Bruna Sampaio", email: "Bruna@X.com ", password: "segredo123" };

const criarAcesso = (app, corpo, chave = CHAVE) =>
  call(app, "post", "/internal/instances/bruna/first-user", {
    body: corpo,
    headers: { "x-internal-key": chave },
  });

test("cria o primeiro usuário da instância", async () => {
  const { app, criados } = monta();

  const r = await criarAcesso(app, DADOS);

  assert.equal(r.status, 201);
  assert.equal(criados.length, 1);
  assert.equal(criados[0].email, "bruna@x.com", "o e-mail entra normalizado");
});

test("o primeiro é ADMINISTRADOR — o dono da casa precisa poder criar os outros", async () => {
  // Sem isto, o cliente entra e não consegue cadastrar ninguém: um acesso que
  // não serve para nada.
  const { app, criados } = monta();

  await criarAcesso(app, DADOS);

  assert.equal(criados[0].admin, true);
});

test("instância que JÁ tem gente dentro é recusada", async () => {
  // A regra que impede esta rota de virar uma porta de entrada para a casa dos
  // clientes: quem já tem acesso convida os outros por dentro do produto.
  const { app, criados } = monta({ profissionais: 1 });

  const r = await criarAcesso(app, DADOS);

  assert.equal(r.status, 409);
  assert.equal(r.body.msg, "already_has_users");
  assert.equal(criados.length, 0);
});

test("sem a chave interna, a rota NÃO EXISTE", async () => {
  // 404 e não 403: para quem não tem a chave, esta porta não está lá.
  const { app, criados } = monta();

  const r = await criarAcesso(app, DADOS, "chave-errada");

  assert.equal(r.status, 404);
  assert.equal(criados.length, 0);
});

test("instância que ninguém cadastrou é recusada", async () => {
  // Criar usuário num banco que nenhum registro reconhece deixaria uma conta
  // órfã num banco que nada apaga.
  const { app, criados } = monta({ registrada: false });

  const r = await criarAcesso(app, DADOS);

  assert.equal(r.status, 404);
  assert.equal(criados.length, 0);
});

test("senha curta é recusada antes de virar conta", async () => {
  const { app, criados } = monta();

  const r = await criarAcesso(app, { ...DADOS, password: "123" });

  assert.equal(r.status, 400);
  assert.equal(r.body.msg, "weak_password");
  assert.equal(criados.length, 0);
});

test("e-mail inválido é recusado — é por ele que se entra", async () => {
  const { app, criados } = monta();

  const r = await criarAcesso(app, { ...DADOS, email: "nao-e-email" });

  assert.equal(r.status, 400);
  assert.equal(r.body.msg, "invalid_email");
  assert.equal(criados.length, 0);
});

test("sem nome, recusa", async () => {
  const { app } = monta();

  const r = await criarAcesso(app, { ...DADOS, name: "  " });

  assert.equal(r.status, 400);
  assert.equal(r.body.msg, "invalid_name");
});

test("erro do modelo vira resposta, não estouro", async () => {
  const { app } = monta({ falha: "username" });

  const r = await criarAcesso(app, DADOS);

  assert.equal(r.status, 400);
});
