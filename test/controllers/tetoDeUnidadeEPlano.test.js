const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const UnitController = require("../../controllers/Unit.js");
const MembershipController = require("../../controllers/Membership.js");

// OS TETOS DE UNIDADE E DE PLANO DA CASA.
//
// *"crie esses limites na central, só para evitar abuso"*.
//
// Estes dois são diferentes dos outros doze limites do produto, e é isso que
// os casos daqui guardam: eles não protegem o nosso servidor, protegem as
// NOSSAS PÁGINAS. A unidade entra no mapa de parceiros do site da VAFIT; o
// plano, na vitrine que a gente hospeda.
//
// Um teto furado aqui não é uma conta usando demais — é o nosso site virando
// quadro de avisos de quem cadastrar mais rápido.

function monta({ teto, quantos, controller }) {
  const criados = [];

  const app = fakeApp({
    api: {
      center: {
        async limitsFor() {
          return teto === undefined ? {} : { units: teto, memberships: teto };
        },
      },
      unit: {
        async insert(obj) {
          criados.push(obj);
          return "novo";
        },
        async data() {
          return { _id: "novo", name: "x" };
        },
        async list() { return []; },
        async listActive() { return []; },
      },
      membership: {
        async insert(obj) {
          criados.push(obj);
          return "novo";
        },
        async rascunho() {
          criados.push({ rascunho: true });
          return "novo";
        },
        async duplicate() {
          criados.push({ clone: true });
          return "novo";
        },
        async data() {
          return { _id: "novo", name: "x" };
        },
      },
      membershipBenefit: { async list() { return []; } },
      membershipImage: {},
      unitImage: {},
      tenant: {
        async currencyFor() { return "BRL"; },
        async currencyOfInstance() { return { currency: "BRL" }; },
      },
    },
    helpers: { ReqProtected: { async can() { return { _id: "u1", name: "Marlon" }; } } },
    // O contador do teto vai ao banco: aqui ele devolve quantos já existem.
    mongodb: {
      async connectToServer() {
        return { collection: () => ({ countDocuments: async () => quantos }) };
      },
    },
  });

  controller(app);
  return { app, criados };
}

test("no teto, criar UNIDADE é recusado com 409", async () => {
  // 409 e não 403: teto é estado do mundo ("apague algo e volte"), e quem lê o
  // código precisa saber que existe conserto do lado de cá.
  const { app, criados } = monta({ teto: 3, quantos: 3, controller: UnitController });

  const r = await call(app, "post", "/units", { body: { name: "Quarta" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "plan_limit");
  assert.equal(criados.length, 0, "criou mesmo depois de recusar");
});

test("abaixo do teto, cria", async () => {
  const { app, criados } = monta({ teto: 3, quantos: 2, controller: UnitController });

  const r = await call(app, "post", "/units", { body: { name: "Terceira" } });

  assert.equal(r.status, 201);
  assert.equal(criados.length, 1);
});

test("plano SEM o limite não proíbe nada — o que ele não diz, ele não proíbe", async () => {
  // Todo plano que existe hoje está assim. Chegar com um número apertaria
  // contas que já existem, no dia do deploy e sem aviso.
  const { app, criados } = monta({ teto: undefined, quantos: 900, controller: UnitController });

  const r = await call(app, "post", "/units", { body: { name: "Nona" } });

  assert.equal(r.status, 201);
  assert.equal(criados.length, 1);
});

test("no teto, criar PLANO DA CASA é recusado", async () => {
  const { app, criados } = monta({ teto: 2, quantos: 2, controller: MembershipController });

  const r = await call(app, "post", "/memberships", { body: { name: "Terceiro" } });

  assert.equal(r.status, 409);
  assert.equal(criados.length, 0);
});

test("e o RASCUNHO também — senão o teto se fura criando e nunca salvando", async () => {
  // O rascunho nasce no clique de "Novo plano", antes de digitar qualquer
  // coisa. Deixá-lo fora da conta abriria a porta dos fundos.
  const { app, criados } = monta({ teto: 2, quantos: 2, controller: MembershipController });

  const r = await call(app, "post", "/memberships/draft", { body: {} });

  assert.equal(r.status, 409);
  assert.equal(criados.length, 0);
});

test("e o CLONE também — é o caminho mais fácil de multiplicar", async () => {
  const { app, criados } = monta({ teto: 2, quantos: 2, controller: MembershipController });

  const r = await call(app, "post", "/memberships/m1/clone", { body: {} });

  assert.equal(r.status, 409);
  assert.equal(criados.length, 0);
});

test("a recusa diz O QUE estourou e QUAL é o teto", async () => {
  // Sem os dois, a mensagem viraria "não foi possível" — e quem a lê não tem
  // como saber se apaga algo ou se troca de plano.
  const { app } = monta({ teto: 3, quantos: 3, controller: UnitController });

  const r = await call(app, "post", "/units", { body: { name: "x" } });

  assert.equal(r.body.limit, "units");
  assert.equal(r.body.max, 3);
  assert.match(r.body.msg, /3/);
});
