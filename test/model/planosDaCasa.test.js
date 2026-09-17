const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Membership_model = require("../../model/Membership_model.js");
const MembershipCategory_model = require("../../model/MembershipCategory_model.js");

// OS PLANOS QUE A ACADEMIA VENDE, e as linhas que os comparam.
//
// *"como pretendo oferecer para academias, ai eu crio a recorrencia com um
// plano"* e *"dentro de planos crie uma aba categoria de plano, pode colar
// essas coisas ai de sim ou nao"*.
//
// `membership` e não `plan`: "plano" neste servidor já é o do PRODUTO, o que
// nós vendemos para a academia. Eu escrevi `controllers/Plan.js` por cima do
// que existia antes de perceber — os testes do checkout acusaram.

const A = new ObjectId("6a7f8e18ac5f3b34bb4e4a01");
const B = new ObjectId("6a7f8e18ac5f3b34bb4e4a02");

function colecaoFalsa(docs = []) {
  const escritas = [];
  return {
    docs,
    escritas,
    find: () => ({ sort: () => ({ toArray: async () => docs }) }),
    findOne: async (f) => docs.find((d) => String(d._id) === String(f._id)) || null,
    countDocuments: async (f) => {
      if (!f || !Object.keys(f).length) return docs.length;
      escritas.push({ contar: f });
      return docs.filter((d) => String(d.categorias?.[0] || d.membership || "") === String(Object.values(f)[0])).length;
    },
    insertOne: async (doc) => {
      escritas.push({ inserir: doc });
      return { insertedId: A };
    },
    updateOne: async (f, op) => {
      escritas.push({ atualizar: op.$set, onde: f });
      return { matchedCount: 1 };
    },
    updateMany: async (f, op) => {
      escritas.push({ atualizarVarios: op.$set, onde: f });
      return { matchedCount: 1 };
    },
    deleteOne: async () => ({ deletedCount: 1 }),
  };
}

function montarPlano({ planos = [], recorrencias = [] } = {}) {
  const col = colecaoFalsa(planos);
  const recs = colecaoFalsa(recorrencias);

  const model = new Membership_model({ api: { recurrence: { collection: async () => recs } } });
  model.collection = async () => col;

  return { model, col, recs };
}

test("o plano guarda IDS de categoria, sem repetir e sem lixo", async () => {
  // A lista chega do formulário e pode vir com o mesmo id duas vezes (dois
  // cliques) ou com texto que não é id nenhum. Guardar os dois faria a tabela
  // desenhar a mesma linha duas vezes.
  const { model, col } = montarPlano();

  await model.insert({
    name: "Black",
    amount: 15990,
    categorias: [String(A), String(A), "não é id", String(B), null],
  });

  const doc = col.escritas.find((e) => e.inserir).inserir;
  assert.equal(doc.categorias.length, 2);
  assert.deepEqual(doc.categorias.map(String), [String(A), String(B)]);
});

test("só UM destaque por conta — o novo tira o dos outros", async () => {
  // Na vitrine ele é o cartão amarelo, o "Mais vantajoso". Dois gritando ao
  // mesmo tempo não destacam nada, e a tela não saberia qual desenhar em cima.
  const { model, col } = montarPlano();

  await model.insert({ name: "Black", destaque: true });

  const limpeza = col.escritas.find((e) => e.atualizarVarios);
  assert.ok(limpeza, "os outros precisam ser desmarcados");
  assert.deepEqual(limpeza.atualizarVarios, { destaque: false });
  assert.equal(limpeza.onde.destaque, true, "só mexe em quem estava destacado");
});

test("editar MESCLA — o que a chamada não menciona, ela não toca", async () => {
  // A lição que `updateCharge` custou caro: montar o documento inteiro a cada
  // escrita transforma um PUT parcial em apagamento silencioso.
  const { model, col } = montarPlano({ planos: [{ _id: A, name: "Black", amount: 15990 }] });

  await model.update(String(A), { active: false });

  const gravado = col.escritas.find((e) => e.atualizar).atualizar;
  assert.deepEqual(Object.keys(gravado).sort(), ["active", "updatedAt"]);
  assert.equal(gravado.amount, undefined, "o preço não pode ser zerado por tabela");
});

test("apagar um plano que alguém assinou é RECUSADO, com o número", async () => {
  // A recorrência guarda o id dele como origem, e uma origem que aponta para o
  // nada é uma linha que ninguém explica meses depois. O NÚMERO vai junto: "não
  // dá" sem dizer quantos deixa a pessoa procurando onde.
  const { model } = montarPlano({
    planos: [{ _id: A, name: "Black" }],
    recorrencias: [{ _id: B, membership: A }],
  });

  const r = await model.remove(String(A));
  assert.equal(r.erro, "inUse");
  assert.equal(r.quantas, 1);
});

test("plano sem assinante nenhum apaga", async () => {
  const { model } = montarPlano({ planos: [{ _id: A, name: "Black" }] });
  assert.deepEqual(await model.remove(String(A)), { ok: true });
});

test("a fidelidade é número de MESES, contida em faixa sã", async () => {
  // Um dia ela vai decidir alguma coisa — quanto falta para cancelar sem multa.
  // "12 meses" escrito à mão não decide nada, e 9999 meses não é fidelidade.
  const { model, col } = montarPlano();

  await model.insert({ name: "Black", fidelidadeMeses: "12" });
  assert.equal(col.escritas.find((e) => e.inserir).inserir.fidelidadeMeses, 12);

  col.escritas.length = 0;
  await model.insert({ name: "X", fidelidadeMeses: -5 });
  assert.equal(col.escritas.find((e) => e.inserir).inserir.fidelidadeMeses, 0, "sem fidelidade");
});

// ── AS CATEGORIAS: as linhas da tabela ────────────────────────────────────

function montarCategoria({ categorias = [], planos = [] } = {}) {
  const col = colecaoFalsa(categorias);
  const dosPlanos = colecaoFalsa(planos);

  const model = new MembershipCategory_model({
    api: { membership: { collection: async () => dosPlanos } },
  });
  model.collection = async () => col;

  return { model, col };
}

test("categoria sem nome não entra", async () => {
  // Uma linha em branco na tabela de comparação é uma linha que ninguém
  // consegue responder sim nem não.
  const { model } = montarCategoria();
  assert.equal(await model.insert({ name: "   " }), null);
});

test("apagar uma categoria marcada em algum plano é RECUSADO", async () => {
  // Apagar mudaria calado o que três planos oferecem, e quem apagou não veria
  // nenhum deles.
  const { model } = montarCategoria({
    categorias: [{ _id: A, name: "Acesso a aulas coletivas" }],
    planos: [{ _id: B, categorias: [A] }],
  });

  const r = await model.remove(String(A));
  assert.equal(r.erro, "inUse");
  assert.equal(r.quantos, 1);
});

test("a ordem é gravada inteira, de uma vez", async () => {
  // "Meio reordenada" é um estado que ninguém sabe consertar olhando a tela.
  const { model, col } = montarCategoria();
  await model.reorder([String(B), String(A)]);

  const ordens = col.escritas.filter((e) => e.atualizar).map((e) => e.atualizar.order);
  assert.deepEqual(ordens, [0, 1]);
});

test("reordenar com lixo no meio não grava lixo", async () => {
  const { model, col } = montarCategoria();
  await model.reorder([String(A), "não é id", String(B)]);

  assert.equal(col.escritas.filter((e) => e.atualizar).length, 2);
});
