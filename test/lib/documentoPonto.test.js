const test = require("node:test");
const assert = require("node:assert");

const { documentoPonto, horas, batidas, situacao } = require("../../lib/documentoPonto.js");

// A FOLHA DE PONTO, montada no servidor.
//
// Ela nasceu para o APP: *"no aplicativo não tem os botões de imprimir nem
// xlsx"*. O app não desenha documento — pede o HTML pronto e entrega ao
// `expo-print`, que imprime ou vira PDF no aparelho.
//
// O que estes testes seguram:
//
//   1. AUTOSSUFICIÊNCIA. A folha vai para e-mail, para o `expo-print` e para
//      disco: um `src` externo sai em branco nas três.
//   2. O QUE NÃO PODE VAZAR. Ela é montada a partir da ficha inteira, onde
//      moram salário, PIS e conta bancária — e é um papel que circula na mão
//      de quem confere e do próprio funcionário.
//   3. AS PALAVRAS no lugar da cor. Impressora preto e branco não tem vermelho:
//      "Falta justificada" tem de estar escrito.
const FUNCIONARIO = {
  _id: "f1",
  name: "Bruna Lima",
  role: "Recepção",
  whatsapp: "(21) 98812-4471",
  email: "bruna@exemplo.com",
  salary: 250000,
  pis: "12345678901",
  bankAccount: "56789-0",
};

const DIAS = [
  {
    dia: "2026-09-01",
    semana: 2,
    batidas: [
      { entrada: "10:00", saida: "12:00" },
      { entrada: "14:00", saida: "18:00" },
    ],
    minutos: 360,
    falta: false,
    abonado: false,
    observacao: "",
    aberto: false,
  },
  {
    dia: "2026-09-02",
    semana: 3,
    batidas: [],
    minutos: 0,
    falta: true,
    abonado: true,
    observacao: "Atestado entregue",
    aberto: false,
  },
  {
    dia: "2026-09-05",
    semana: 6,
    batidas: [{ entrada: "08:00", saida: "" }],
    minutos: 0,
    falta: false,
    abonado: false,
    observacao: "",
    aberto: true,
  },
];

const montar = (extra = {}) =>
  documentoPonto({
    funcionario: FUNCIONARIO,
    mes: "2026-09",
    dias: DIAS,
    resumo: { previsto: 1131 },
    fuso: "America/Sao_Paulo",
    emitidoEm: "2026-09-21T12:00:00.000Z",
    ...extra,
  });

test("a folha é autossuficiente — sem link, script ou src externo", () => {
  const html = montar({
    foto: "data:image/jpeg;base64,AAAA",
    marca: "data:image/png;base64,BBBB",
  });

  assert.ok(!/<link\b/i.test(html), "não pode buscar folha de estilo");
  assert.ok(!/<script\b/i.test(html), "não pode carregar script");
  for (const src of html.match(/src="([^"]*)"/g) || []) {
    assert.ok(/src="(data:|cid:)/.test(src), `imagem externa na folha: ${src}`);
  }
});

test("diz de quem é: nome, cargo e o WhatsApp", () => {
  // *"no pdf faltou a foto da pessoa"*, *"também faltou pôr o whatsapp para
  // facilitar"*. O papel circula sem a tela ao lado.
  const html = montar();

  assert.ok(html.includes("Bruna Lima"));
  assert.ok(html.includes("Recepção"));
  assert.ok(html.includes("(21) 98812-4471"));
});

test("NADA de folha de pagamento entra no papel", () => {
  // A ficha inteira chega aqui, e é ela que tem salário, PIS e conta. Este é o
  // papel que o próprio funcionário assina e que fica numa pasta na recepção.
  const html = montar();

  for (const segredo of ["250000", "2.500", "12345678901", "56789-0"]) {
    assert.ok(!html.includes(segredo), `${segredo} não devia estar na folha`);
  }
});

test("o mês sai por extenso, no idioma de quem lê", () => {
  assert.ok(/setembro/i.test(montar()));
  assert.ok(/september/i.test(montar({ lang: "en" })));
});

test("cada dia leva as batidas, o total e o espaço para assinar", () => {
  const html = montar();

  assert.ok(html.includes("10:00–12:00   14:00–18:00"));
  assert.ok(html.includes("6h"), "o total do dia");
  // Uma linha pontilhada por dia — três dias, três linhas.
  assert.equal((html.match(/dotted/g) || []).length, DIAS.length);
});

test("a situação vira PALAVRA, porque papel não tem cor", () => {
  const html = montar();

  assert.ok(html.includes("Falta justificada"));
  assert.ok(html.includes("Atestado entregue"));
  assert.ok(html.includes("em aberto"));
});

test("o resumo traz trabalhado, previsto, saldo e FALTAS", () => {
  const html = montar();

  assert.ok(html.includes("6h"), "trabalhado");
  assert.ok(html.includes("18h51"), "previsto");
  assert.ok(html.includes("−12h51"), "saldo negativo com o sinal certo");
  assert.ok(/Faltas/.test(html));
});

test("sem jornada na ficha, previsto e saldo somem — não viram zero", () => {
  // Previsto é regra de três sobre a jornada semanal. Sem ela, um saldo
  // negativo gigante seria um número inventado com cara de oficial.
  const html = montar({ resumo: {} });

  assert.ok(!/Previsto/.test(html));
  assert.ok(!/Saldo/.test(html));
});

test("as duas assinaturas do pé estão lá", () => {
  const html = montar();

  assert.ok(html.includes("Assinatura do funcionário"));
  assert.ok(html.includes("Assinatura do responsável"));
});

test("o nome escapa — a folha pode ir para qualquer lugar", () => {
  const html = montar({ funcionario: { ...FUNCIONARIO, name: '<script>alert("x")</script>' } });

  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("a emissão leva data e hora, no fuso da CONTA", () => {
  // O servidor roda em UTC: sem o fuso, uma folha emitida às 21h de São Paulo
  // sairia com a data do dia seguinte.
  const html = montar({ emitidoEm: "2026-09-22T01:30:00.000Z" });

  assert.ok(html.includes("21/09/2026"), "22:30 em Brasília ainda é dia 21");
  assert.ok(!html.includes("{{dia}}"), "o rótulo tem de ser interpolado");
});

test("mês sem lançamento nenhum ainda é uma folha", () => {
  const html = montar({ dias: [], resumo: {} });

  assert.ok(html.includes("Bruna Lima"));
  assert.ok(html.includes("Assinatura do funcionário"));
});

// ── AS CONTAS, à parte ────────────────────────────────────────────────────

test("as horas saem em h e min, como na tela", () => {
  assert.equal(horas(440), "7h20");
  assert.equal(horas(480), "8h");
  assert.equal(horas(0), "0h");
  assert.equal(horas(undefined), "0h");
});

test("a batida ABERTA aparece como aberta, e não como dia cheio", () => {
  assert.equal(batidas({ batidas: [{ entrada: "14:00", saida: "" }] }), "14:00–…");
  assert.equal(batidas({}), "");
});

test("falta justificada não se confunde com falta seca", () => {
  const t = (chave) => chave;

  assert.equal(situacao(t, { falta: true, abonado: true }), "employees.excusedLabel");
  assert.equal(situacao(t, { falta: true }), "employees.absence");
  assert.equal(situacao(t, { aberto: true }), "employees.openPunch");
  assert.equal(situacao(t, { minutos: 480 }), "");
});
