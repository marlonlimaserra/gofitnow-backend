const test = require("node:test");
const assert = require("node:assert/strict");

const instanceContext = require("../../lib/instance.js");

// Para qual BANCO cada coisa vai.
//
// O módulo lê MONGODB_URI na carga, então ele é exigido depois de a variável
// existir. Nenhum teste aqui abre conexão: o que se prova é o roteamento, que é
// decidido antes de qualquer ida ao servidor.
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/gofitnow";
const mongodb = require("../../config/mongodb.js");

const schema = require("../../database/schema.js");

test("o banco central sai da URI", () => {
  assert.equal(mongodb.centralName(), "gofitnow");
});

test("cada instância é um banco com prefixo do central", () => {
  assert.equal(mongodb.dbNameFor("marlon"), "gofitnow_marlon");
  assert.equal(mongodb.dbNameFor("outro"), "gofitnow_outro");
});

test("nome inválido não vira nome de banco", () => {
  // Sem isto, um nome vindo de fora escolheria em qual banco escrever.
  for (const ruim of ["../admin", "com.ponto", "", "admin", null]) {
    assert.equal(mongodb.dbNameFor(ruim), null, JSON.stringify(ruim));
  }
});

test("connectToServer NÃO funciona fora de uma requisição", async () => {
  // É o coração do isolamento: um modelo chamado sem instância tem de parar,
  // não escolher um banco por conta própria.
  await assert.rejects(() => mongodb.connectToServer(), /no_instance_in_context/);
});

test("o que é central e o que é por instância não se sobrepõem", () => {
  // Uma collection nos dois lados significaria dois lugares para a mesma
  // informação, e ninguém saberia qual está certo.
  const nos_dois = schema.CENTRAL.filter((c) => schema.POR_INSTANCIA.includes(c));
  assert.deepEqual(nos_dois, []);
});

test("o catálogo de exercícios é CENTRAL — igual para todo mundo", () => {
  assert.ok(schema.CENTRAL.includes("exercises"));
  assert.ok(!schema.POR_INSTANCIA.includes("exercises"));
});

test("o registro das instâncias é central; contas e treinos são da instância", () => {
  assert.ok(schema.CENTRAL.includes("center"));

  for (const c of ["users", "workouts", "professional_links", "roles", "tenants"]) {
    assert.ok(schema.POR_INSTANCIA.includes(c), c);
    assert.ok(!schema.CENTRAL.includes(c), c);
  }
});

test("`access_requests` não existe mais em lugar nenhum", () => {
  // O pedido de acesso saiu junto com o motivo dele: com um banco por cliente,
  // a conta de outra instância é outra conta.
  assert.ok(!schema.CENTRAL.includes("access_requests"));
  assert.ok(!schema.POR_INSTANCIA.includes("access_requests"));
});

test("o modelo de exercícios lê o banco CENTRAL, não o da instância", async () => {
  // Prova pelo comportamento: se ele usasse connectToServer, estouraria fora de
  // uma requisição — como os outros modelos fazem.
  const Exercise = require("../../model/Exercise_model.js");
  const chamadas = [];

  const model = new Exercise({
    mongodb: {
      async centralDb() {
        chamadas.push("central");
        return { collection: () => ({}) };
      },
      async connectToServer() {
        chamadas.push("instancia");
        return { collection: () => ({}) };
      },
    },
  });

  await model.collection();
  assert.deepEqual(chamadas, ["central"]);
});

test("o registro das instâncias também é central", async () => {
  const Center = require("../../model/Center_model.js");
  const chamadas = [];

  const model = new Center({
    mongodb: {
      async centralDb() {
        chamadas.push("central");
        return { collection: () => ({}) };
      },
      async connectToServer() {
        chamadas.push("instancia");
        return { collection: () => ({}) };
      },
    },
  });

  await model.collection();
  assert.deepEqual(chamadas, ["central"]);
});

test("um modelo comum lê o banco da INSTÂNCIA", async () => {
  // O contrário do de cima, e o caso da esmagadora maioria: quem não é
  // compartilhado tem de estar dentro do banco do cliente.
  const User = require("../../model/User_model.js");
  const chamadas = [];

  const model = new User({
    mongodb: {
      async centralDb() {
        chamadas.push("central");
        return { collection: () => ({}) };
      },
      async connectToServer() {
        chamadas.push("instancia");
        return { collection: () => ({}) };
      },
    },
  });

  await model.collection();
  assert.deepEqual(chamadas, ["instancia"]);
});

test("dentro do escopo, o nome do banco é o da instância do escopo", () => {
  // Confere que o roteamento acompanha o contexto, e não uma variável global.
  instanceContext.run("marlon", () => {
    assert.equal(mongodb.dbNameFor(instanceContext.required()), "gofitnow_marlon");
  });
  instanceContext.run("outro", () => {
    assert.equal(mongodb.dbNameFor(instanceContext.required()), "gofitnow_outro");
  });
});
