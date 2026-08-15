const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Finance_model = require("../../model/Finance_model.js");

// Nem todo pagamento registrado é dinheiro que entrou.
//
// O status é declarado, e não deduzido como o da cobrança: só quem registrou
// sabe se o Pix combinado caiu, se o cheque é pré-datado, ou se o dinheiro
// voltou. O que este arquivo prende é a CONTA — porque um pendente somado como
// recebido faz a tela dizer que a pessoa está quite quando ela não está.
const ALUNO = new ObjectId();

function fakeModel({ cobrancas = [], pagamentos = [] } = {}) {
  const model = new Finance_model({});
  model.listCharges = async () => cobrancas;
  model.listPayments = async () => pagamentos;
  return model;
}

const pagamento = (amount, extra = {}) => ({ amount, currency: "BRL", ...extra });

test("pagamento sem status nenhum conta como recebido", async () => {
  // Todo lançamento anterior a este campo existir está assim. Ler ausência como
  // pendente reescreveria o passado: o saldo de quem já usava o sistema mudaria
  // sozinho, sem ninguém ter tocado em nada.
  const model = fakeModel({
    cobrancas: [{ amount: 10000, currency: "BRL", status: "open" }],
    pagamentos: [pagamento(10000)],
  });

  const saldo = await model.balanceOf(ALUNO, "BRL");

  assert.equal(saldo.BRL.paid, 10000);
  assert.equal(saldo.BRL.balance, 0);
});

test("pendente NÃO entra no saldo — é promessa, não dinheiro", async () => {
  const model = fakeModel({
    cobrancas: [{ amount: 10000, currency: "BRL", status: "open" }],
    pagamentos: [pagamento(10000, { status: "pending" })],
  });

  const saldo = await model.balanceOf(ALUNO, "BRL");

  assert.equal(saldo.BRL.paid, 0);
  assert.equal(saldo.BRL.balance, 10000, "continua devendo os cem reais");
});

test("reembolsado sai do saldo — o dinheiro entrou e VOLTOU", async () => {
  const model = fakeModel({
    cobrancas: [{ amount: 10000, currency: "BRL", status: "open" }],
    pagamentos: [pagamento(10000, { status: "refunded" })],
  });

  const saldo = await model.balanceOf(ALUNO, "BRL");

  assert.equal(saldo.BRL.paid, 0);
  assert.equal(saldo.BRL.balance, 10000);
});

test("o lançamento reembolsado não some — ele fica como histórico", async () => {
  // Apagar seria perder o registro de que o dinheiro passou por ali. O que ele
  // deixa de ser é receita.
  const model = fakeModel({
    pagamentos: [pagamento(10000, { status: "refunded" })],
  });

  const lista = await model.listPayments(ALUNO);
  assert.equal(lista.length, 1);
});

test("misturados, só os pagos somam", async () => {
  const model = fakeModel({
    cobrancas: [{ amount: 30000, currency: "BRL", status: "open" }],
    pagamentos: [
      pagamento(10000, { status: "paid" }),
      pagamento(5000, { status: "pending" }),
      pagamento(7000, { status: "refunded" }),
      pagamento(3000),
    ],
  });

  const saldo = await model.balanceOf(ALUNO, "BRL");

  assert.equal(saldo.BRL.paid, 13000, "10000 do pago + 3000 do sem status");
  assert.equal(saldo.BRL.charged, 30000);
  assert.equal(saldo.BRL.balance, 17000);
});

// ── O que cada cobrança já recebeu ───────────────────────────────────────

test("pendente não quita cobrança", async () => {
  // Sem esta regra a cobrança sumiria da lista de quem ainda deve, por causa de
  // um pagamento que ainda não aconteceu.
  const cobranca = new ObjectId();
  const model = fakeModel({
    pagamentos: [pagamento(10000, { charge: cobranca, status: "pending" })],
  });

  const porCobranca = await model.paidByCharge(ALUNO);

  assert.equal(porCobranca[String(cobranca)], undefined);
});

test("reembolsado devolve a cobrança para o aberto", async () => {
  const cobranca = new ObjectId();
  const model = fakeModel({
    pagamentos: [
      pagamento(4000, { charge: cobranca, status: "paid" }),
      pagamento(6000, { charge: cobranca, status: "refunded" }),
    ],
  });

  const porCobranca = await model.paidByCharge(ALUNO);

  assert.equal(porCobranca[String(cobranca)], 4000, "só os quarenta que ficaram");
});

test("pago quita, como sempre quitou", async () => {
  const cobranca = new ObjectId();
  const model = fakeModel({
    pagamentos: [pagamento(10000, { charge: cobranca })],
  });

  const porCobranca = await model.paidByCharge(ALUNO);

  assert.equal(porCobranca[String(cobranca)], 10000);
});

// ── O que é gravado ──────────────────────────────────────────────────────

function fakeInsert() {
  const gravados = [];
  const model = new Finance_model({});
  model.payments = async () => ({
    async insertOne(doc) {
      gravados.push(doc);
      return { insertedId: new ObjectId() };
    },
    async updateOne(filtro, mudanca) {
      gravados.push(mudanca.$set);
      return { matchedCount: 1 };
    },
  });
  return { model, gravados };
}

test("os três status são gravados como vieram", async () => {
  for (const status of ["paid", "pending", "refunded"]) {
    const { model, gravados } = fakeInsert();
    await model.insertPayment(ALUNO, { amount: "100,00", status }, null, "BRL");
    assert.equal(gravados[0].status, status);
  }
});

test("status inventado vira pago em vez de derrubar o lançamento", async () => {
  // O valor vem de uma lista fechada na tela; um erro aqui é mais provável ser
  // navegador com versão velha que má-fé. Recusar perderia o dinheiro que a
  // pessoa está tentando registrar.
  const { model, gravados } = fakeInsert();

  await model.insertPayment(ALUNO, { amount: "100,00", status: "meio-pago" }, null, "BRL");

  assert.equal(gravados[0].status, "paid");
});

test("sem status, nasce pago — é o caso normal", async () => {
  const { model, gravados } = fakeInsert();

  await model.insertPayment(ALUNO, { amount: "100,00" }, null, "BRL");

  assert.equal(gravados[0].status, "paid");
});

test("editar troca o status", async () => {
  const { model, gravados } = fakeInsert();

  await model.updatePayment(new ObjectId(), { amount: "100,00", status: "refunded" });

  assert.equal(gravados[0].status, "refunded");
});
