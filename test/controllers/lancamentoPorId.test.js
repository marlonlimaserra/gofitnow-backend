const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const FinanceController = require("../../controllers/Finance.js");

// LER UM LANÇAMENTO PELO ID.
//
// *"esse modal é um modal que eu gostaria de abrir de qualquer lugar, aí salve
// na url o id da cobrança e o id do pagamento, assim se eu der f5 ou mandar
// para alguém, abre onde deveria"*.
//
// É isso que obriga estas rotas a existirem: enquanto o diálogo só abria de uma
// lista, a linha já estava na mão. Vindo de um LINK não há lista nenhuma — a
// tela tem o id e mais nada.
//
// E é isso que torna o VÍNCULO a parte mais importante daqui: um id que viaja
// num link é um id que pode ser adivinhado, digitado ou repassado.
const USER = { _id: "u1", name: "Marlon" };
const ALUNO = "6a7f8e18ac5f3b34bb4e4723";
const COBRANCA = "6a7f8e18ac5f3b34bb4e4801";

function monta({ cobranca = null, pagamento = null, vinculado = true } = {}) {
  const app = fakeApp({
    ...permiteTudo(USER),
    api: {
      finance: {
        async chargeData() {
          return cobranca;
        },
        async paymentData() {
          return pagamento;
        },
        async paymentsOfCharge() {
          return [{ _id: "pg1", amount: 2500, status: "paid" }];
        },
        async listCharges() {
          return [{ _id: COBRANCA, amount: 2500 }];
        },
        async paidByCharge() {
          return { [COBRANCA]: 2500 };
        },
      },
      user: {
        async dataStudent() {
          return vinculado ? { _id: ALUNO, name: "Teste tester", email: "x@y.z" } : undefined;
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL"] };
        },
      },
      recurrence: { async gerar() { return 0; } },
    },
  });

  FinanceController(app);
  return app;
}

test("a cobrança vem com o NOME de quem deve, para o título", async () => {
  // Sem ele o título diria "Editar cobrança —" e mais nada: vindo de um link,
  // não há lista de onde tirar o nome.
  const app = monta({ cobranca: { _id: COBRANCA, student: ALUNO, amount: 2500, numero: 12 } });
  const r = await call(app, "get", `/charges/${COBRANCA}`);

  assert.equal(r.status, 200);
  assert.equal(r.body.student.name, "Teste tester");
  assert.equal(r.body.charge.numero, 12);
});

test("e com os pagamentos e o catálogo, numa ida só", async () => {
  // O editor mostra o nome, o que já entrou e os estados possíveis. Buscar cada
  // coisa por conta seriam quatro idas para abrir uma janela, e ela piscaria em
  // quatro tempos.
  const app = monta({ cobranca: { _id: COBRANCA, student: ALUNO, amount: 2500 } });
  const r = await call(app, "get", `/charges/${COBRANCA}`);

  assert.equal(r.body.payments.length, 1);
  assert.equal(r.body.currency, "BRL");
  assert.ok(r.body.paymentStatus.some((s) => s.id === "canceled"));
});

test("cobrança de quem NÃO é meu aluno dá 404", async () => {
  // Um id que viaja num link é um id que pode ser adivinhado ou repassado. Sem
  // esta trava, ele abriria a cobrança de outro profissional.
  const app = monta({ cobranca: { _id: COBRANCA, student: ALUNO }, vinculado: false });
  const r = await call(app, "get", `/charges/${COBRANCA}`);

  assert.equal(r.status, 404);
  // 404 e não 403: dizer "existe, mas não é sua" já conta que ela existe.
  assert.ok(!JSON.stringify(r.body).includes("Teste tester"));
});

test("cobrança que não existe dá 404, e não uma janela vazia", async () => {
  const app = monta({ cobranca: null });
  assert.equal((await call(app, "get", `/charges/${COBRANCA}`)).status, 404);
});

test("o pagamento vem com as COBRANÇAS da pessoa, para o 'Referente a'", async () => {
  // É o único jeito de o seletor funcionar quando a janela abre de um link.
  const app = monta({ pagamento: { _id: "pg1", student: ALUNO, amount: 2500, numero: 7 } });
  const r = await call(app, "get", "/payments/pg1");

  assert.equal(r.status, 200);
  assert.equal(r.body.payment.numero, 7);
  assert.equal(r.body.charges.length, 1);
  assert.equal(r.body.paidByCharge[COBRANCA], 2500);
});

test("pagamento de quem não é meu aluno dá 404", async () => {
  const app = monta({ pagamento: { _id: "pg1", student: ALUNO }, vinculado: false });
  assert.equal((await call(app, "get", "/payments/pg1")).status, 404);
});
