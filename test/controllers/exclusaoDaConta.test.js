const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const AccountController = require("../../controllers/Account.js");

// ── O DONO DA INSTÂNCIA NÃO SE EXCLUI (16/09/2026) ────────────────────────
//
// O registro central guarda UM e-mail por instância, com índice único, e é por
// ele que se descobre para onde mandar quem chegou sem dizer a instância.
// Apagar essa conta deixa a instância viva com um dono que não existe: ninguém
// para cobrar, ninguém para avisar, e ninguém que consiga entrar para arrumar —
// enquanto a assinatura na Stripe continua correndo.
//
// A trava é no SERVIDOR. A tela também esconde o caminho, e esconder botão não
// é proteção: o endereço `/conta/excluir` é navegável de fora por exigência do
// Google Play.
const DONO = { _id: "u1", name: "Marlon", email: "Marlon@Exemplo.com " };
const OUTRO = { _id: "u2", name: "Pamela", email: "pam@exemplo.com" };

function monta(user, { emailNoRegistro = "marlon@exemplo.com", centralCai = false } = {}) {
  const pedidos = [];

  const app = fakeApp({
    ...permiteTudo(user),
    api: {
      center: {
        async byInstance() {
          if (centralCai) throw new Error("central fora do ar");
          return emailNoRegistro ? { instance: "marlon", email: emailNoRegistro } : undefined;
        },
      },
      user: {
        async papelNaExclusao() { return "trainer"; },
        async oQueVaiSumirNaExclusao() { return {}; },
        async exclusaoPedida() { return null; },
        async conferirSenha() { return true; },
        async pedirExclusaoDaConta(u, motivo) {
          pedidos.push({ motivo });
          return { feito: true, papel: "trainer", pedidaEm: new Date(), jaExistia: false };
        },
      },
    },
  });

  // `verify` é o que estas rotas usam (não `can`): exclusão da própria conta não
  // pede permissão nenhuma além de estar logado.
  app.helpers.ReqProtected.verify = async () => user;

  AccountController(app);
  return { app, pedidos };
}

test("o dono é BARRADO, e antes de a senha ser pedida", async () => {
  // Pedir a senha para recusar depois faria a pessoa digitar a senha dela para
  // ouvir que nunca podia.
  const { app, pedidos } = monta(DONO);
  const r = await call(app, "post", "/me/account/deletion", { body: {} });

  assert.equal(r.status, 403);
  assert.equal(r.body.code, "dono_da_instancia");
  assert.deepEqual(pedidos, [], "nem chegou a registrar pedido");
});

test("o dono é barrado MESMO mandando a senha certa", async () => {
  // A trava não é sobre provar identidade — é sobre a consequência.
  const { app, pedidos } = monta(DONO);
  const r = await call(app, "post", "/me/account/deletion", { body: { senha: "certa" } });

  assert.equal(r.status, 403);
  assert.equal(r.body.code, "dono_da_instancia");
  assert.deepEqual(pedidos, []);
});

test("a comparação ignora caixa e espaço", async () => {
  // O e-mail do usuário vem "Marlon@Exemplo.com " no cenário, de propósito: um
  // `===` cru deixaria o dono passar por causa de um espaço no fim.
  const { app } = monta(DONO, { emailNoRegistro: "marlon@exemplo.com" });
  const r = await call(app, "post", "/me/account/deletion", { body: { senha: "x" } });

  assert.equal(r.status, 403);
});

test("quem NÃO é o dono continua podendo se excluir", async () => {
  // A metade que importa do teste: uma trava que barra todo mundo não é trava, é
  // defeito. A recepcionista e o professor têm direito de sair.
  const { app, pedidos } = monta(OUTRO);
  const r = await call(app, "post", "/me/account/deletion", { body: { senha: "certa" } });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(pedidos.length, 1);
});

test("instância sem e-mail no registro não barra ninguém", async () => {
  // Registro incompleto não pode virar trava: sem e-mail gravado não há dono
  // identificado, e barrar "por precaução" trancaria a saída de todos.
  const { app } = monta(DONO, { emailNoRegistro: "" });
  const r = await call(app, "post", "/me/account/deletion", { body: { senha: "certa" } });

  assert.equal(r.status, 200);
});

test("central fora do ar DEIXA PASSAR, e isso é a escolha", async () => {
  // Exclusão de conta é direito da pessoa — a LGPD o garante e o Google Play
  // exige que o caminho exista na web. Trancá-lo porque um serviço nosso caiu
  // seria transformar indisponibilidade em negativa de direito.
  //
  // O outro lado: durante uma queda da central, o dono consegue pedir a própria
  // exclusão. É raro, é reversível (o pedido é uma fila que alguém atende, não
  // um apagar imediato), e é menos grave que travar a saída de todo mundo.
  const { app, pedidos } = monta(DONO, { centralCai: true });
  const r = await call(app, "post", "/me/account/deletion", { body: { senha: "certa" } });

  assert.equal(r.status, 200);
  assert.equal(pedidos.length, 1);
});

test("a tela é avisada por `dono`, para não oferecer o caminho", async () => {
  const doDono = await call(monta(DONO).app, "get", "/me/account/deletion");
  assert.equal(doDono.body.dono, true);

  const doOutro = await call(monta(OUTRO).app, "get", "/me/account/deletion");
  assert.equal(doOutro.body.dono, false);
});
