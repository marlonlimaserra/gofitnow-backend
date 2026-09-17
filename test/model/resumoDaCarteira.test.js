const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Finance_model = require("../../model/Finance_model.js");

// OS TRÊS CARTÕES DO FINANCEIRO SÃO DA JANELA, NÃO DO FILTRO.
//
// "cada vez que eu troco de aba, os valores ali em cima mudam" — e mudavam
// porque o status entrava no filtro do BANCO: a lista vinha recortada e o
// resumo era calculado sobre o recorte. Clicar em "Pagas" zerava "a receber".
//
// A pergunta dos cartões é "como está o mês". Ela não muda porque alguém quis
// ver só uma parte da lista. Este arquivo prende isso: é o tipo de defeito que
// volta na próxima vez que alguém mexer no filtro, e que não quebra nada
// visivelmente — só mostra um número errado com toda a confiança.
const HOJE = new Date("2026-09-17T12:00:00Z");

function fakeModel(cobrancas, pagos = {}) {
  const model = new Finance_model({});

  model.charges = async () => ({
    find: () => ({
      sort: () => ({ toArray: async () => cobrancas }),
    }),
  });

  model.payments = async () => ({
    aggregate: () => ({
      toArray: async () =>
        Object.entries(pagos).map(([id, total]) => ({ _id: new ObjectId(id), total })),
    }),
  });

  return model;
}

const A = "6a7f8e18ac5f3b34bb4e4701";
const B = "6a7f8e18ac5f3b34bb4e4702";
const C = "6a7f8e18ac5f3b34bb4e4703";

const COBRANCAS = [
  // aberta, vence no futuro
  { _id: new ObjectId(A), student: new ObjectId(), amount: 10000, status: "open",
    dueDate: new Date("2026-09-30T12:00:00Z"), currency: "BRL" },
  // paga
  { _id: new ObjectId(B), student: new ObjectId(), amount: 5000, status: "paid",
    dueDate: new Date("2026-09-10T12:00:00Z"), currency: "BRL" },
  // cancelada
  { _id: new ObjectId(C), student: new ObjectId(), amount: 3000, status: "canceled",
    dueDate: new Date("2026-09-12T12:00:00Z"), currency: "BRL" },
];

const PAGOS = { [B]: 5000 };

test("o resumo é o MESMO com qualquer filtro de status", async () => {
  const model = fakeModel(COBRANCAS, PAGOS);

  const todos = await model.carteira({ de: "2026-09-01", ate: "2026-09-30" });
  const abertas = await model.carteira({ de: "2026-09-01", ate: "2026-09-30", status: "open" });
  const pagas = await model.carteira({ de: "2026-09-01", ate: "2026-09-30", status: "paid" });
  const atrasadas = await model.carteira({ de: "2026-09-01", ate: "2026-09-30", status: "late" });

  assert.deepEqual(abertas.resumo, todos.resumo, "'Em aberto' não pode mexer nos cartões");
  assert.deepEqual(pagas.resumo, todos.resumo, "'Pagas' não pode mexer nos cartões");
  assert.deepEqual(atrasadas.resumo, todos.resumo, "'Atrasadas' não pode mexer nos cartões");
});

test("o filtro recorta as LINHAS, e recorta de verdade", async () => {
  // O outro lado da moeda: consertar o resumo não pode custar o filtro.
  const model = fakeModel(COBRANCAS, PAGOS);

  const todos = await model.carteira({});
  const abertas = await model.carteira({ status: "open" });
  const pagas = await model.carteira({ status: "paid" });
  const canceladas = await model.carteira({ status: "canceled" });

  assert.equal(todos.rows.length, 3);
  assert.deepEqual(abertas.rows.map((r) => r.id), [A]);
  assert.deepEqual(pagas.rows.map((r) => r.id), [B]);
  assert.deepEqual(canceladas.rows.map((r) => r.id), [C]);
});

test("o resumo conta o que entrou e o que falta na janela", async () => {
  const model = fakeModel(COBRANCAS, PAGOS);
  const { resumo } = await model.carteira({});

  // Cancelada não é dinheiro a receber: ela foi desfeita.
  assert.equal(resumo.recebido, 5000, "os R$ 50 que entraram");
  assert.equal(resumo.aReceber, 10000, "só a aberta");
});

// ── O FILTRO ACEITA VÁRIOS STATUS ─────────────────────────────────────────
//
// A tela virou multisseleção: *"jogo os status, em um multi select"*. "Em
// aberto MAIS atrasadas" é a pergunta de quem vai cobrar hoje, e antes ela
// exigia duas passadas na tela.
test("dois status somam, em vez de um substituir o outro", async () => {
  const model = fakeModel(COBRANCAS, PAGOS);

  const so = await model.carteira({ status: "open" });
  const dois = await model.carteira({ status: "open,canceled" });

  assert.deepEqual(so.rows.map((r) => r.id), [A]);
  assert.deepEqual(dois.rows.map((r) => r.id).sort(), [A, C].sort());
});

test("`late` continua valendo junto dos gravados", async () => {
  // Uma aberta VENCIDA: pedir "paid,late" tem de trazê-la ao lado da paga.
  const vencida = {
    _id: new ObjectId("6a7f8e18ac5f3b34bb4e4704"),
    student: new ObjectId(),
    amount: 7000,
    status: "open",
    dueDate: new Date("2026-08-01T12:00:00Z"),
    currency: "BRL",
  };
  const model = fakeModel([...COBRANCAS, vencida], PAGOS);

  const r = await model.carteira({ status: "paid,late" });
  const ids = r.rows.map((x) => x.id).sort();

  assert.deepEqual(ids, [B, "6a7f8e18ac5f3b34bb4e4704"].sort());
});

test("status desconhecido é tratado como SEM filtro, e não como nada", async () => {
  // Um valor velho guardado no navegador não pode esvaziar a tela.
  const model = fakeModel(COBRANCAS, PAGOS);
  const r = await model.carteira({ status: "banana" });
  assert.equal(r.rows.length, 3);
});

// ── EDITAR PARCIAL NÃO PODE APAGAR O RESTO ────────────────────────────────
//
// `PUT /charges/:id` com `{ status: "canceled" }` gravava o documento INTEIRO:
// `amount: 0`, `description: ""`, `note: ""` e o vencimento de HOJE. Cinco
// cobranças reais foram destruídas assim em 17/09/2026, pelas ações em lote —
// a primeira chamada parcial que o sistema teve.
//
// O defeito estava no modelo desde sempre; o formulário só nunca o disparou,
// porque manda todos os campos em toda gravação.
function modeloDeEdicao() {
  const model = new Finance_model({});
  const gravado = [];

  model.charges = async () => ({
    updateOne: async (filtro, op) => {
      gravado.push(op.$set);
      return { matchedCount: 1 };
    },
    findOne: async () => null,
  });

  return { model, gravado };
}

test("mudar só o status não toca em valor, descrição nem vencimento", async () => {
  const { model, gravado } = modeloDeEdicao();

  await model.updateCharge("6a7f8e18ac5f3b34bb4e4701", { status: "canceled" });

  const set = gravado[0];
  assert.equal(set.status, "canceled");
  assert.equal("amount" in set, false, "valor não pode entrar no $set");
  assert.equal("description" in set, false, "descrição não pode entrar no $set");
  assert.equal("dueDate" in set, false, "vencimento não pode entrar no $set");
  assert.equal("note" in set, false, "observação não pode entrar no $set");
});

test("o formulário, que manda tudo, continua gravando tudo", async () => {
  // O outro lado: proteger a edição parcial não pode custar a edição completa.
  const { model, gravado } = modeloDeEdicao();

  await model.updateCharge("6a7f8e18ac5f3b34bb4e4701", {
    amount: 2500,
    dueDate: "2026-09-30",
    description: "Mensalidade",
    status: "open",
    note: "combinado por telefone",
  });

  const set = gravado[0];
  assert.equal(set.amount, 2500);
  assert.equal(set.description, "Mensalidade");
  assert.equal(set.status, "open");
  assert.equal(set.note, "combinado por telefone");
});

test("string vazia é uma EDIÇÃO, e apaga de propósito", async () => {
  // Apagar a descrição é um ato legítimo. O que não podia era apagá-la sem
  // ninguém ter pedido — e a diferença entre as duas coisas é o campo estar
  // presente no corpo.
  const { model, gravado } = modeloDeEdicao();

  await model.updateCharge("6a7f8e18ac5f3b34bb4e4701", { description: "" });

  assert.equal(gravado[0].description, "");
  assert.equal("amount" in gravado[0], false);
});
