const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Finance_model = require("../../model/Finance_model.js");

// A MOEDA DE UM PAGAMENTO QUE QUITA UMA COBRANÇA É A DA COBRANÇA.
//
// O relato foi de olhar para a tela: "Registrar pagamento" mostrando Moeda USD e
// $ 25,00 com o "Referente a" apontando para uma cobrança de R$ 25,00. O que faz
// isso ser grave é o que NÃO acontece depois: erro nenhum. Quem soma o recebido
// soma `amount` e compara com o da cobrança — 2500 quita 2500 — então a cobrança
// aparece paga, o saldo fecha em zero, e a conta está errada em silêncio.
//
// Por isso a regra vive no modelo, e estes casos batem no modelo: são duas rotas
// (criar e editar) e a segunda é a perigosa, porque age depois de a conta já ter
// fechado certo uma vez.
const ALUNO = new ObjectId();
const AUTOR = new ObjectId();

const EM_REAIS = new ObjectId();
const PAGAMENTO = new ObjectId();

function fakeModel() {
  const model = new Finance_model({
    api: { counter: { proximo: async () => 1 } },
  });

  const cobrancas = [{ _id: EM_REAIS, amount: 2500, currency: "BRL", status: "open" }];
  const pagamentos = [{ _id: PAGAMENTO, amount: 2500, currency: "BRL", charge: EM_REAIS }];

  const gravado = { inseridos: [], mudancas: [] };

  const acha = (lista) => async (filtro) =>
    lista.find((d) => String(d._id) === String(filtro._id)) || null;

  model.charges = async () => ({ findOne: acha(cobrancas) });

  model.payments = async () => ({
    findOne: acha(pagamentos),
    insertOne: async (doc) => {
      gravado.inseridos.push(doc);
      return { insertedId: new ObjectId() };
    },
    updateOne: async (filtro, op) => {
      gravado.mudancas.push(op.$set || {});
      return { matchedCount: 1 };
    },
  });

  // `updatePayment` fecha recalculando o status da cobrança tocada; nada disso é
  // o que estes casos medem.
  model.recomputeChargeStatus = async () => {};
  model.paymentData = async () => pagamentos[0];

  return { model, gravado };
}

test("criar: apontar para a cobrança em reais grava em reais, mesmo pedindo USD", async () => {
  const { model, gravado } = fakeModel();

  await model.insertPayment(ALUNO, { amount: 2500, charge: String(EM_REAIS) }, AUTOR, "USD");

  assert.equal(gravado.inseridos[0].currency, "BRL");
});

test("criar avulso: sem cobrança, a moeda pedida vale", async () => {
  // Adiantamento em outra moeda é combinado legítimo. O que não existe é
  // combinado de quitar numa moeda uma dívida em outra.
  const { model, gravado } = fakeModel();

  await model.insertPayment(ALUNO, { amount: 2500 }, AUTOR, "USD");

  assert.equal(gravado.inseridos[0].currency, "USD");
});

test("editar: trocar a moeda de um pagamento ligado à cobrança não pega", async () => {
  const { model, gravado } = fakeModel();

  await model.updatePayment(String(PAGAMENTO), {
    amount: 2500,
    currency: "USD",
    charge: String(EM_REAIS),
  });

  assert.equal(gravado.mudancas[0].currency, "BRL");
});

test("editar sem falar de vínculo: a cobrança que o pagamento JÁ tem manda", async () => {
  // Este é o caminho por baixo: `{ currency: "USD" }` e mais nada. Sem ler o
  // vínculo atual, a regra valeria só para quem mandasse o formulário inteiro.
  const { model, gravado } = fakeModel();

  await model.updatePayment(String(PAGAMENTO), { currency: "USD" });

  assert.equal(gravado.mudancas[0].currency, "BRL");
});

test("editar desvinculando: virou avulso, e a moeda volta a ser escolha", async () => {
  const { model, gravado } = fakeModel();

  await model.updatePayment(String(PAGAMENTO), { currency: "USD", charge: null });

  assert.equal(gravado.mudancas[0].currency, "USD");
  assert.equal(gravado.mudancas[0].charge, null);
});
