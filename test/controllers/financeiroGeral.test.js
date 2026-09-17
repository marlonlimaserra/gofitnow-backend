const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const FinanceController = require("../../controllers/Finance.js");

// ── O FINANCEIRO DE TODO MUNDO (16/09/2026) ───────────────────────────────
//
// "acho que faltou um menu financeiro também, para ver tudo pendente, pago,
// relatórios etc."
//
// Tudo que existia era POR PESSOA. Funciona para a ficha de um aluno e não
// responde a pergunta do fim do mês — e com 217 pessoas a resposta exigia abrir
// 217 fichas: o dado existia e era inalcançável.
const USER = { _id: "u1", name: "Marlon" };
const ANA = "6a7f8e18ac5f3b34bb4e4723";
const BIA = "6a7cbba1d2908f75788e92bf";

function monta(rows, resumo, { tenantQuebrado = false } = {}) {
  const permissao = permiteTudo(USER);
  const pedidos = [];

  const app = fakeApp({
    ...permissao,
    api: {
      finance: {
        async carteira(filtros) {
          pedidos.push(filtros);
          return {
            rows,
            total: rows.length,
            pagina: Number(filtros.pagina) || 1,
            limite: Number(filtros.limite) || 15,
            resumo: resumo || { recebido: 0, aReceber: 0, atrasado: 0 },
          };
        },
      },
      // Devolve um MAP — é o que o modelo de verdade devolve, e foi onde eu
      // errei na primeira versão: acesso por colchete num Map dá `undefined`
      // sem erro, e o relatório sairia com "—" em toda linha.
      // A GERAÇÃO DA MENSALIDADE roda antes de ler a carteira: sem agendador,
      // quem materializa a cobrança do mês é quem vem olhar. O dobro precisa
      // existir — sem ele a rota estoura antes de chegar ao relatório.
      recurrence: {
        async gerar() {
          return 0;
        },
      },
      user: {
        // `contactsByIds` desde 17/09/2026: a rota passou a resolver nome,
        // e-mail e WhatsApp numa consulta só, porque os dois contatos vão para a
        // PLANILHA. O Map continua sendo Map — acesso por colchete nele dá
        // `undefined` sem erro, e o relatório sairia com "—" em toda linha.
        async contactsByIds() {
          return new Map([
            [ANA, { name: "Ana Paula", email: "ana@exemplo.com", phone: "(21) 90000-0001" }],
            [BIA, { name: "Bia Souza", email: "", phone: "" }],
          ]);
        },
      },
      tenant: {
        // O FUSO DA CONTA: a janela do mês é calculada nele desde 16/09/2026.
        //
        // Sem este método o dobro mentia sobre o `app.api.tenant` de verdade, e a
        // rota estourava com TypeError — seis testes de uma vez. Do lado do
        // servidor isso GRITA, o que é melhor que o silêncio do navegador.
        async timezoneOfInstance() {
          if (tenantQuebrado) throw new Error("configuração fora do ar");
          return "America/Sao_Paulo";
        },
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL"] };
        },
      },
    },
  });

  FinanceController(app);
  return { app, pedidos, pedidas: permissao.pedidas };
}

const LINHA = {
  id: "c1",
  student: ANA,
  description: "Mensalidade",
  amount: 20000,
  pago: 0,
  falta: 20000,
  dueDate: new Date("2026-09-01"),
  status: "open",
  origem: "manual",
  atrasada: true,
  diasDeAtraso: 15,
};

// ── O NOME, O CONTATO E A BUSCA SAÍRAM DAQUI ──────────────────────────────
//
// A rota resolvia os nomes numa segunda consulta e filtrava por eles com um
// `filter` em JavaScript. Os dois pararam de fazer sentido com a paginação
// (17/09/2026): buscar na página acharia "Ana" entre as quinze linhas
// carregadas e diria que não existe mais nenhuma.
//
// Agora a junção e a busca acontecem no MESMO pipeline que corta a página — e é
// lá que estão os casos (`test/model/carteiraPaginada.test.js`). O que sobrou
// para a rota é repassar o que veio e devolver o que o modelo respondeu.
test("a rota repassa a página inteira do modelo, sem remontar nada", async () => {
  const { app } = monta([LINHA]);
  const r = await call(app, "get", "/finance");

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows, [LINHA], "a linha sai como veio do modelo");
});

test("a busca, a ordem e a página chegam ao modelo", async () => {
  // Sem isto os três seriam enfeite: a tela pediria a página 3 ordenada por
  // nome e o servidor devolveria a primeira, por vencimento.
  const { app, pedidos } = monta([]);
  await call(app, "get", "/finance", {
    query: { q: "ana", sort: "person", dir: "asc", page: "3", limit: "50" },
  });

  assert.equal(pedidos[0].busca, "ana");
  assert.equal(pedidos[0].ordem, "person");
  assert.equal(pedidos[0].direcao, "asc");
  assert.equal(pedidos[0].pagina, "3");
  assert.equal(pedidos[0].limite, "50");
});

test("a CONTAGEM do recorte vai junto, senão a tela não sabe quantas páginas há", async () => {
  // Saber que a página veio cheia não é o mesmo que saber quantas existem.
  const { app } = monta([LINHA]);
  const r = await call(app, "get", "/finance");

  assert.equal(r.body.total, 1);
  assert.equal(r.body.pagina, 1);
  assert.equal(r.body.limite, 15);
});

test("a janela e o status chegam ao modelo", async () => {
  // Sem isto o filtro da tela seria enfeite: ela mostraria "setembro" e o
  // servidor devolveria tudo.
  const { app, pedidos } = monta([]);
  await call(app, "get", "/finance", { query: { de: "2026-09-01", ate: "2026-09-30", status: "late" } });

  assert.equal(pedidos[0].de, "2026-09-01");
  assert.equal(pedidos[0].ate, "2026-09-30");
  assert.equal(pedidos[0].status, "late");
});

test("a rota é fechada por finance.view", async () => {
  const { app, pedidas } = monta([]);
  await call(app, "get", "/finance");
  assert.ok(pedidas.includes("finance.view"));
});

test("a MOEDA da conta vai junto", async () => {
  // Os lançamentos antigos não têm a sua gravada, e é a padrão que os
  // interpreta — sem ela a tela chutaria "R$".
  const { app } = monta([LINHA]);
  const r = await call(app, "get", "/finance");
  assert.equal(r.body.currency, "BRL");
});

// ── A JANELA PEGA O DIA INTEIRO ──────────────────────────────────────────
//
// *"eu marquei como pago, deveria ter aparecido aqui."*
//
// O defeito: a tela manda `ate: "2026-09-30"`, e `new Date("2026-09-30")` é
// MEIA-NOITE UTC. Três cobranças de um aulão do dia 30/09 às 09:00 (12:00 UTC)
// caíam fora do Financeiro de setembro — e o resumo dizia "recebido no mês
// R$ 0,00" com dois pagamentos lançados.
//
// Não era só do aulão: toda cobrança COM HORA que vencesse no último dia da
// janela ficava de fora. As de compromisso herdam a hora do atendimento.

test("o FUSO da conta chega ao modelo", async () => {
  // É ele que faz o fim do dia 30 ser 03:00 UTC do dia 1º, e não 23:59 UTC do
  // dia 30 — três horas que contêm a cobrança da noite do último dia.
  const { app, pedidos } = monta([]);

  await call(app, "get", "/finance", { query: { de: "2026-09-01", ate: "2026-09-30" } });

  assert.equal(pedidos[0].fuso, "America/Sao_Paulo");
  assert.equal(pedidos[0].ate, "2026-09-30");
});

test("fuso que FALHA não derruba o relatório", async () => {
  // Uma leitura de configuração não pode custar a tela que mostra o dinheiro do
  // mês. Sem fuso, o modelo cai no padrão.
  const { app, pedidos } = monta([], undefined, { tenantQuebrado: true });

  const r = await call(app, "get", "/finance", { query: { de: "2026-09-01", ate: "2026-09-30" } });

  assert.equal(r.status, 200);
  assert.equal(pedidos[0].fuso, undefined);
});

// ── E A CONTA QUE O MODELO FAZ ──────────────────────────────────────────
//
// Direto na função, sem rota: é aritmética de fuso, e é onde o defeito morava.
test("o fim da janela cobre o dia inteiro no fuso da conta", () => {
  const tempo = require("../../lib/tempo.js");

  const antes = new Date("2026-09-30");
  const daAula = new Date("2026-09-30T12:00:00.000Z");

  // Como era: meia-noite UTC do dia 30 — a aula das 09:00 ficava fora.
  assert.equal(daAula <= antes, false);

  // Como é: 23:59:59.999 do dia 30 em São Paulo.
  const fim = new Date(
    tempo.instante({ ano: 2026, mes: 9, dia: 30, hora: 23, minuto: 59 }, "America/Sao_Paulo").getTime() +
      59999
  );

  assert.equal(daAula <= fim, true);

  // E não invade outubro: a cobrança do dia 1º continua fora.
  assert.equal(new Date("2026-10-01T12:00:00.000Z") <= fim, false);
});
