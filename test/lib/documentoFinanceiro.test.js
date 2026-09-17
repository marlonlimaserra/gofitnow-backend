const test = require("node:test");
const assert = require("node:assert");

const { documentoFinanceiro, dinheiro, somar } = require("../../lib/documentoFinanceiro.js");

// O EXTRATO FINANCEIRO, montado no servidor.
//
// O que estes testes seguram é o que faz o desenho valer: a folha é
// AUTOSSUFICIENTE (vai para e-mail, para o `expo-print` e para disco), nada que
// veio do banco entra sem escapar, e os totais são do que está NA FOLHA — não o
// saldo da conta inteira, que não bateria com as linhas abaixo dele.

const PESSOA = {
  _id: "p1",
  name: "Giovana Lacerda",
  phone: "(21) 99999-0000",
  email: "giovana@exemplo.com",
};

const COBRANCAS = [
  { _id: "c1", amount: 25000, dueDate: "2026-09-30T00:00:00.000Z", description: "Mensalidade" },
  { _id: "c2", amount: 8000, dueDate: "2026-09-17T00:00:00.000Z", description: "Avaliação Física" },
];

const PAGAMENTOS = [
  { _id: "g1", charge: "c1", amount: 25000, date: "2026-09-10T14:30:00.000Z", method: "pix", status: "paid" },
  { _id: "g2", charge: "c2", amount: 3000, date: "2026-09-12T00:00:00.000Z", method: "cash", status: "paid" },
];

const montar = (extra = {}) =>
  documentoFinanceiro({
    person: PESSOA,
    charges: COBRANCAS,
    payments: PAGAMENTOS,
    moeda: "BRL",
    fuso: "America/Sao_Paulo",
    emitidoEm: "2026-09-17T12:00:00.000Z",
    ...extra,
  });

test("a folha é autossuficiente — sem link, script ou src externo", () => {
  const html = montar({
    foto: "data:image/jpeg;base64,AAAA",
    marca: "data:image/png;base64,BBBB",
  });

  assert.ok(!/<link\b/i.test(html), "não pode buscar folha de estilo");
  assert.ok(!/<script\b/i.test(html), "não pode carregar script");
  // Toda imagem é `data:` (ou `cid:`, na versão de e-mail) — nunca um endereço
  // que exija sessão, que sairia em branco no e-mail e no PDF.
  for (const src of html.match(/src="[^"]*"/g) || []) {
    assert.ok(/^src="(data:|cid:)/.test(src), `imagem externa: ${src}`);
  }
});

test("nada do banco entra sem escapar", () => {
  const html = documentoFinanceiro({
    person: { name: '<script>alert("x")</script>' },
    charges: [{ _id: "c1", amount: 1000, description: "<b>negrito</b>", dueDate: "2026-09-01" }],
    payments: [{ _id: "g1", charge: "c1", amount: 1000, date: "2026-09-01", method: "pix", note: '"aspas"' }],
  });

  assert.ok(!html.includes("<script>alert"), "o nome não pode virar tag");
  assert.ok(!html.includes("<b>negrito</b>"), "a descrição não pode virar tag");
  assert.ok(html.includes("&lt;b&gt;negrito&lt;/b&gt;"));
});

test("os totais são do que está na folha", () => {
  // Duas cobranças (R$ 250 + R$ 80) e dois pagamentos (R$ 250 + R$ 30).
  assert.deepStrictEqual(somar(COBRANCAS, PAGAMENTOS), {
    cobrado: 33000,
    recebido: 28000,
    saldo: 5000,
  });

  // Com o recorte de UMA cobrança, o topo soma só ela.
  assert.deepStrictEqual(somar([COBRANCAS[1]], [PAGAMENTOS[1]]), {
    cobrado: 8000,
    recebido: 3000,
    saldo: 5000,
  });
});

test("cancelada não conta como dívida, pendente e reembolsado não contam como pago", () => {
  const total = somar(
    [...COBRANCAS, { _id: "c3", amount: 99900, status: "canceled" }],
    [
      ...PAGAMENTOS,
      { _id: "g3", charge: "c1", amount: 50000, status: "pending" },
      { _id: "g4", charge: "c1", amount: 50000, status: "refunded" },
    ]
  );

  assert.strictEqual(total.cobrado, 33000, "a cancelada existe como registro, não como dívida");
  assert.strictEqual(total.recebido, 28000, "promessa e estorno não são dinheiro que entrou");
});

test("a situação de cada cobrança é calculada, não lida do campo", () => {
  const html = montar();

  // c1 está coberta pelos pagamentos → "Paga", mesmo sem `status: "paid"`
  // gravado em lugar nenhum.
  assert.ok(html.includes("Paga"), "cobrança coberta tem de aparecer como paga");
  // c2 venceu em 17/09 e ainda falta receber.
  assert.ok(html.includes("Vencida") || html.includes("Em aberto"));
});

test("saldo negativo vira CRÉDITO, e não um 'a receber' negativo", () => {
  const html = documentoFinanceiro({
    person: PESSOA,
    charges: [{ _id: "c1", amount: 10000, dueDate: "2026-09-01" }],
    payments: [{ _id: "g1", charge: "c1", amount: 30000, date: "2026-09-01", method: "pix" }],
  });

  assert.ok(html.includes("Crédito"), "quem pagou adiantado tem crédito");
  assert.ok(!html.includes("-R$"), "nunca um valor negativo na folha");
});

test("o dinheiro sai na língua da MOEDA, não na de quem lê", () => {
  // Mesma escolha do `formatarMoeda` da tela: o separador pertence à moeda.
  assert.strictEqual(dinheiro(123456, "BRL").replace(/ /g, " "), "R$ 1.234,56");
  assert.strictEqual(dinheiro(123456, "USD").replace(/ /g, " "), "$1,234.56");
  // Moeda inválida cai na padrão em vez de derrubar a folha.
  assert.ok(dinheiro(1000, "XXX").includes("10"));
});

test("a foto e a logo entram embutidas, e a folha sai inteira sem elas", () => {
  const com = montar({ foto: "data:image/jpeg;base64,AAAA", marca: "data:image/png;base64,BBBB" });
  assert.ok(com.includes("data:image/jpeg;base64,AAAA"), "a foto da pessoa");
  assert.ok(com.includes("data:image/png;base64,BBBB"), "a logo da casa");

  const sem = montar();
  assert.ok(!sem.includes("<img"), "sem foto e sem logo, nenhum quadrado vazio");
  assert.ok(sem.includes("Giovana Lacerda"));
});

test("os pagamentos avulsos ganham seção própria", () => {
  const html = montar({
    payments: [
      ...PAGAMENTOS,
      { _id: "g9", amount: 15000, date: "2026-09-05", method: "transfer", note: "adiantamento" },
    ],
  });

  assert.ok(html.includes("adiantamento"), "o avulso precisa aparecer em algum lugar");
  // Sem esta seção ele entraria no "Recebido" do topo sem uma linha que o
  // explique, e a soma pareceria errada.
  assert.ok(html.includes("Pagamentos"));
});

test("o nome da forma vem do catálogo da conta", () => {
  const html = montar({ formas: { pix: "PIX da loja" } });
  assert.ok(html.includes("PIX da loja"));
  // Chave fora do catálogo cai na tradução: "cash" tem de sair como "Dinheiro".
  assert.ok(html.includes("Dinheiro"));
});

test("a data é do FUSO da conta, e o dia puro não anda", () => {
  // 30/09 gravado como meia-noite UTC é um DIA, não um instante: formatá-lo no
  // fuso empurraria para 29/09 e a folha mostraria um vencimento que não existe.
  const html = montar();
  assert.ok(html.includes("30/09/2026"), "o vencimento não pode andar um dia");
});

test("sem lançamento nenhum, a folha diz isso em vez de sair em branco", () => {
  const html = documentoFinanceiro({ person: PESSOA, charges: [], payments: [] });
  assert.ok(html.includes("Nada lançado ainda."));
});
