const test = require("node:test");
const assert = require("node:assert/strict");

const { centavos } = require("../../model/Service_model.js");
const Finance_model = require("../../model/Finance_model.js");

// Dinheiro.
//
// Este arquivo existe porque errar aqui é diferente de errar um layout: o
// número vai para um relatório financeiro, e o centavo é exatamente o que
// ninguém perdoa.
//
// Duas decisões estão sob teste. A primeira: TUDO em centavos inteiros —
// `1.1 + 2.2` em ponto flutuante dá 3.3000000000000003. A segunda: o campo
// aceita as duas pontuações, porque as duas são digitadas.

test("o valor vira centavos inteiros", () => {
  assert.equal(centavos("120"), 12000);
  assert.equal(centavos("0"), 0);
});

test("vírgula e ponto decimal valem o mesmo", () => {
  // O separador decimal é vírgula em português e ponto em inglês, e o mesmo
  // campo recebe os dois. Recusar um deles seria recusar metade dos usuários.
  assert.equal(centavos("120,50"), 12050);
  assert.equal(centavos("120.50"), 12050);
});

test("o separador de MILHAR não é decimal", () => {
  // "1.200" é mil e duzentos, não um e vinte. A regra: o último separador é o
  // decimal, e só quando sobram uma ou duas casas depois dele.
  assert.equal(centavos("1.200"), 120000);
  assert.equal(centavos("1,200"), 120000);
  assert.equal(centavos("R$ 1.200,00"), 120000);
  assert.equal(centavos("1,200.00"), 120000);
});

test("uma casa decimal é dezena de centavo, não unidade", () => {
  // "12,5" é doze e cinquenta, não doze e cinco.
  assert.equal(centavos("12,5"), 1250);
});

test("o que não é número vira zero, e não NaN", () => {
  // NaN gravado num campo de dinheiro contamina toda soma que o encontrar, e
  // some da tela sem erro nenhum.
  for (const lixo of ["", "abc", null, undefined, "R$"]) {
    assert.equal(centavos(lixo), 0, JSON.stringify(lixo));
  }
});

test("valor negativo vira ZERO, e não o positivo dele", () => {
  // Um "-50" digitado por engano não pode virar 50: seria inventar um valor
  // que ninguém escreveu, e a cobrança sairia certa por acidente. Zero é
  // recusável pelo formulário, que exige valor.
  assert.equal(centavos("-50"), 0);
});

test("número já em centavos passa inteiro", () => {
  // É como o próprio sistema devolve o valor de um serviço para gerar a
  // cobrança: ele já está em centavos e não pode ser multiplicado de novo.
  assert.equal(centavos(12000), 12000);
});

// ── O saldo ───────────────────────────────────────────────────────────────

function monta({ charges = [], payments = [] } = {}) {
  const finance = new Finance_model({});
  finance.listCharges = async () => charges;
  finance.listPayments = async () => payments;
  return finance;
}

test("o saldo é o que foi cobrado menos o que entrou", async () => {
  const finance = monta({
    charges: [{ _id: "c1", amount: 12000, status: "open", currency: "BRL" }],
    payments: [{ amount: 5000, charge: "c1", currency: "BRL" }],
  });

  assert.deepEqual(await finance.balanceOf("aaaaaaaaaaaaaaaaaaaaaaa1", "BRL"), {
    BRL: { charged: 12000, paid: 5000, balance: 7000 },
  });
});

test("moedas diferentes NÃO se somam", async () => {
  // A razão de o saldo ser um mapa: R$ 100 + US$ 100 não é 200 de coisa
  // nenhuma, e um total somando os dois seria um número que não existe em
  // lugar nenhum do mundo.
  const finance = monta({
    charges: [
      { _id: "c1", amount: 10000, status: "open", currency: "BRL" },
      { _id: "c2", amount: 10000, status: "open", currency: "USD" },
    ],
    payments: [{ amount: 10000, charge: "c1", currency: "BRL" }],
  });

  assert.deepEqual(await finance.balanceOf("aaaaaaaaaaaaaaaaaaaaaaa1", "BRL"), {
    BRL: { charged: 10000, paid: 10000, balance: 0 },
    USD: { charged: 10000, paid: 0, balance: 10000 },
  });
});

test("lançamento antigo, sem moeda gravada, entra na padrão", async () => {
  // Os que existiam antes deste campo. Deixá-los fora do saldo os faria sumir
  // do total sem nenhum aviso.
  const finance = monta({
    charges: [{ _id: "c1", amount: 12000, status: "open" }],
    payments: [{ amount: 2000 }],
  });

  assert.deepEqual(await finance.balanceOf("aaaaaaaaaaaaaaaaaaaaaaa1", "BRL"), {
    BRL: { charged: 12000, paid: 2000, balance: 10000 },
  });
});

test("cobrança cancelada não conta como dívida", async () => {
  // Ela continua existindo como registro do que foi desfeito — mas cobrar por
  // ela seria cobrar duas vezes por um acerto já feito.
  const finance = monta({
    charges: [
      { _id: "c1", amount: 12000, status: "open" },
      { _id: "c2", amount: 9000, status: "canceled" },
    ],
    payments: [],
  });

  const saldo = await finance.balanceOf("aaaaaaaaaaaaaaaaaaaaaaa1", "BRL");
  assert.equal(saldo.BRL.charged, 12000);
  assert.equal(saldo.BRL.balance, 12000);
});

test("pagamento adiantado deixa o saldo NEGATIVO", async () => {
  // Quem pagou mais do que deve tem crédito, e o número tem de dizer isso. Um
  // saldo travado em zero esconderia o crédito de quem pagou o semestre.
  const finance = monta({
    charges: [{ _id: "c1", amount: 12000, status: "open" }],
    payments: [{ amount: 30000, charge: null }],
  });

  assert.equal((await finance.balanceOf("aaaaaaaaaaaaaaaaaaaaaaa1", "BRL")).BRL.balance, -18000);
});

test("somas de centavos não escorregam", async () => {
  // O motivo de tudo ser inteiro: em reais, 1,10 + 2,20 + 3,30 daria
  // 6.6000000000000005.
  const finance = monta({
    charges: [{ _id: "c1", amount: 660, status: "open" }],
    payments: [{ amount: 110 }, { amount: 220 }, { amount: 330 }],
  });

  assert.equal((await finance.balanceOf("aaaaaaaaaaaaaaaaaaaaaaa1", "BRL")).BRL.balance, 0);
});

test("quanto já foi pago de CADA cobrança", async () => {
  // É o que deixa a tela marcar o que está quitado sem uma consulta por linha.
  const finance = monta({
    charges: [],
    payments: [
      { amount: 5000, charge: "c1" },
      { amount: 3000, charge: "c1" },
      { amount: 9000, charge: "c2" },
      // Avulso: não pertence a cobrança nenhuma e não pode ser somado a uma.
      { amount: 1000, charge: null },
    ],
  });

  assert.deepEqual(await finance.paidByCharge("aaaaaaaaaaaaaaaaaaaaaaa1"), {
    c1: 8000,
    c2: 9000,
  });
});
