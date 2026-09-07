const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const User_model = require("../../model/User_model.js");
const instanceContext = require("../../lib/instance.js");

// PEDIR A EXCLUSÃO DA PRÓPRIA CONTA.
//
// Este arquivo substituiu `excluirMinhaConta.test.js` em 02/09/2026, quando o
// Marlon cortou a exclusão automática: "não exclua automático, mande uma
// solicitação de exclusão lá para a central".
//
// O que ele segura agora é o contrário do que a versão anterior segurava. Antes
// eu testava que o aluno saía NA HORA; hoje o teste é que **ninguém sai**. Um
// caminho que ainda apagasse alguém direto seria pior que o defeito original:
// a tela diria "vamos entrar em contato" e o dado já teria ido.
//
// O papel continua sendo calculado, e continua importando: é o que diz ao
// painel o TAMANHO do que está sendo pedido antes de alguém ligar.
const EU = new ObjectId();

function monta({ tipo = "student", outrosAdmins = 0, jaTemPedido = false } = {}) {
  const eu = {
    _id: EU,
    name: "Quem quer sair",
    email: "quem@quer.sair",
    type: tipo,
    salt: "sal-de-teste",
  };

  // Se algum destes for chamado, o teste falha: nada pode apagar.
  const apagou = [];

  const users = {
    async deleteOne(q) {
      apagou.push("deleteOne:" + String(q._id));
      return { deletedCount: 1 };
    },
    async deleteMany() {
      apagou.push("deleteMany");
      return { deletedCount: 1 };
    },
    async findOne() {
      return eu;
    },
    async countDocuments(filtro) {
      return filtro?.type === "student" ? 216 : 2;
    },
  };

  const central = {
    pedidos: [],
    cancelou: 0,
    async pedirExclusao(instancia, dados) {
      if (jaTemPedido) return { ...dados, instance: instancia, jaExistia: true, pedidaEm: new Date(0) };
      const doc = { ...dados, instance: instancia, jaExistia: false, pedidaEm: new Date() };
      central.pedidos.push(doc);
      return doc;
    },
    async exclusaoPedida() {
      return jaTemPedido ? { estado: "pendente" } : undefined;
    },
    async cancelarExclusaoPedida() {
      central.cancelou += 1;
      return true;
    },
  };

  const link = { async deleteAllOf(id) { apagou.push("link:" + String(id)); } };
  const role = { async countActiveUsersWith() { return outrosAdmins; } };

  const app = { crypto, api: { center: central, link, role } };
  const user = new User_model(app);
  user.collection = async () => users;
  app.api.user = user;

  // A cascata do aluno existe e tem teste próprio (`deleteStudent.test.js`).
  // Aqui ela é armadilha: se alguém a chamar, o teste acusa.
  user.apagarTudoDoAluno = async (id) => {
    apagou.push("cascata:" + String(id));
    return true;
  };

  eu.password = user.hashPassword("senha", eu.salt);

  return { user, eu, central, apagou };
}

const naInstancia = (fn) => instanceContext.run("marlon", fn);

test("o aluno pede, e NADA é apagado", async () => {
  const { user, eu, central, apagou } = monta({ tipo: "student" });

  assert.equal(await user.papelNaExclusao(eu), "aluno");

  const r = await naInstancia(() => user.pedirExclusaoDaConta(eu, "não uso mais"));

  assert.equal(r.papel, "aluno");
  assert.equal(r.feito, true);

  // O PONTO do arquivo.
  assert.deepEqual(apagou, []);

  assert.equal(central.pedidos.length, 1);
  assert.equal(central.pedidos[0].motivo, "não uso mais");
  assert.equal(central.pedidos[0].papel, "aluno");
});

test("o profissional com colegas pede, e NADA é apagado", async () => {
  const { user, eu, central, apagou } = monta({ tipo: "trainer", outrosAdmins: 2 });

  assert.equal(await user.papelNaExclusao(eu), "profissional");

  const r = await naInstancia(() => user.pedirExclusaoDaConta(eu, ""));

  assert.equal(r.papel, "profissional");
  assert.deepEqual(apagou, []);
  assert.equal(central.pedidos[0].papel, "profissional");
});

test("o ÚLTIMO admin é 'dono', e o pedido leva o tamanho da casa", async () => {
  const { user, eu, central, apagou } = monta({ tipo: "trainer", outrosAdmins: 0 });

  assert.equal(await user.papelNaExclusao(eu), "dono");

  await naInstancia(() => user.pedirExclusaoDaConta(eu, "vou fechar"));

  assert.deepEqual(apagou, []);

  const pedido = central.pedidos[0];
  assert.equal(pedido.papel, "dono");
  // Os números vão NO PEDIDO: é o que ele lê antes de ligar, sem ter de abrir o
  // banco do cliente para descobrir o peso do que está sendo pedido.
  assert.deepEqual(pedido.oQueVaiSumir, { alunos: 216, profissionais: 2 });
  assert.equal(pedido.nome, "Quem quer sair");
  assert.equal(pedido.email, "quem@quer.sair");
});

test("a instância sai do CONTEXTO, não de um argumento", async () => {
  const { user, eu, central } = monta();

  await instanceContext.run("bruna", () => user.pedirExclusaoDaConta(eu, ""));

  // Passá-la à mão abriria a porta para registrar o pedido na instância errada
  // — e este banco é o central, onde o escopo não protege ninguém.
  assert.equal(central.pedidos[0].instance, "bruna");
});

test("aluno e profissional NÃO levam contagem — ela é do dono", async () => {
  const aluno = monta({ tipo: "student" });
  await naInstancia(() => aluno.user.pedirExclusaoDaConta(aluno.eu, ""));
  assert.deepEqual(aluno.central.pedidos[0].oQueVaiSumir, {});

  const pro = monta({ tipo: "trainer", outrosAdmins: 3 });
  await naInstancia(() => pro.user.pedirExclusaoDaConta(pro.eu, ""));
  assert.deepEqual(pro.central.pedidos[0].oQueVaiSumir, {});
});

test("pedir de novo devolve `jaExistia` — e é o que cala o e-mail", async () => {
  // Sem esta marca, apertar o botão três vezes mandaria três e-mails para quem
  // já foi avisado. Ver controllers/Account.js.
  const { user, eu } = monta({ jaTemPedido: true });

  const r = await naInstancia(() => user.pedirExclusaoDaConta(eu, "de novo"));

  assert.equal(r.jaExistia, true);
});

test("desistir chama o central e não apaga nada", async () => {
  const { user, eu, central, apagou } = monta();

  assert.equal(await naInstancia(() => user.cancelarExclusaoDaConta(eu)), true);
  assert.equal(central.cancelou, 1);
  assert.deepEqual(apagou, []);
});

test("a senha é conferida contra o hash, não contra o texto", async () => {
  const { user } = monta();

  assert.equal(await user.conferirSenha(String(EU), "senha"), true);
  assert.equal(await user.conferirSenha(String(EU), "outra"), false);
  assert.equal(await user.conferirSenha(String(EU), ""), false);
  // Id inválido chega da sessão; uma sessão estranha não pode derrubar a rota.
  assert.equal(await user.conferirSenha("nao-e-id", "senha"), false);
});

test("conta sem senha definida não passa pela conferência", async () => {
  const { user, eu } = monta();
  eu.password = null;
  eu.salt = null;

  // É o estado do aluno cadastrado pelo profissional e sem acesso concedido.
  // Sem isto, `hashPassword(x, null) === null` poderia virar um "true" por
  // acidente e dispensar a senha justamente em quem não tem uma.
  assert.equal(await user.conferirSenha(String(EU), "qualquer"), false);
  assert.equal(await user.conferirSenha(String(EU), ""), false);
});
