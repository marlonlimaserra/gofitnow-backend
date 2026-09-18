const test = require("node:test");
const assert = require("node:assert/strict");

const status = require("../../lib/statusDePagamento.js");

// OS ESTADOS DE UM PAGAMENTO.
//
// `canceled` entrou em 18/09/2026: *"é que cancelou, mas o pagamento ficou
// pago, acho melhor por um status cancelado"*. Ele cancelou a cobrança e o
// pagamento continuou contando como recebido.

test("só `paid` é dinheiro", () => {
  assert.deepEqual(status.ENTRAM, ["paid"]);
  assert.deepEqual(status.NAO_ENTRAM.sort(), ["canceled", "pending", "refunded"]);
});

test("cancelado e reembolsado são ESTADOS DIFERENTES", () => {
  // Para o saldo dão no mesmo, e é por isso que seria tentador reusar um. Para
  // quem lê o histórico meses depois, não: "reembolsado" diz que houve
  // devolução, e devolução que não houve é uma conversa com o cliente que
  // ninguém quer ter.
  assert.ok(status.IDS.includes("canceled"));
  assert.ok(status.IDS.includes("refunded"));
  assert.equal(status.entrou({ status: "canceled" }), false);
  assert.equal(status.entrou({ status: "refunded" }), false);
});

test("AUSENTE é pago — e isso é sobre o passado", () => {
  // Lançamento anterior a este campo não o tem. Ler ausência como "pendente"
  // reescreveria o saldo de todo mundo que já usava o sistema, sozinho.
  assert.equal(status.entrou({}), true);
  assert.equal(status.entrou({ status: undefined }), true);
  assert.equal(status.normalizar(undefined), "paid");
});

test("estado inventado cai em `paid`, e não some da conta", () => {
  // Um pagamento com estado que ninguém reconhece é dinheiro que entrou até
  // alguém dizer o contrário — sumir dele seria pior que mostrá-lo.
  assert.equal(status.normalizar("inventado"), "paid");
  assert.equal(status.entrou({ status: "inventado" }), true);
});

test("o filtro do banco casa com o AUSENTE", () => {
  // `{ status: "paid" }` não casa com documento sem o campo. `$nin` casa.
  const filtro = status.filtroDeEntrada();
  assert.deepEqual(filtro, { status: { $nin: status.NAO_ENTRAM } });
  assert.ok(!JSON.stringify(filtro).includes('"paid"'));
});

test("o catálogo viaja com o rótulo já traduzido", () => {
  const lista = status.paraTela((k) => `[${k}]`);
  assert.equal(lista.length, status.IDS.length);
  assert.deepEqual(lista[0], {
    id: "paid",
    label: "[finance.paymentStatus.paid]",
    tom: "ok",
    entra: true,
  });
});
