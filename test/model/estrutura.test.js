const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Equipment = require(path.join(__dirname, "..", "..", "model", "Equipment_model.js"));
const Supply = require(path.join(__dirname, "..", "..", "model", "Supply_model.js"));

// A ESTRUTURA DA CASA — o que se quebra e o que acaba.
//
// Os dois modelos guardam HISTÓRICO, e é disso que estes casos tratam. O saldo
// do estoque e o gasto de um aparelho não são campos que alguém digita: são
// consequências de um livro que só cresce. Um caso que verificasse o campo
// passaria mesmo com o livro errado.

const EQUIPAMENTO = "6a80de570056d24c09f5da61";
const INSUMO = "6a80de570056d24c09f5da62";
const OUTRO = "6a80de570056d24c09f5da63";

// O dobro do Mongo: anota tudo o que foi pedido, porque metade das regras
// aqui mora no FILTRO de um updateOne, não no valor gravado.
function banco() {
  const feito = { inseriu: [], atualizou: [], apagou: [], apagouMuitos: [], fotos: [] };
  const docs = {};

  const colecao = (nome) => ({
    insertOne: async (doc) => {
      feito.inseriu.push({ colecao: nome, doc });
      return { insertedId: "novo" };
    },
    updateOne: async (filtro, mudanca) => {
      feito.atualizou.push({ colecao: nome, filtro, mudanca });
      return { matchedCount: 1 };
    },
    deleteOne: async (filtro) => {
      feito.apagou.push({ colecao: nome, filtro });
      return { deletedCount: 1 };
    },
    deleteMany: async (filtro) => {
      feito.apagouMuitos.push({ colecao: nome, filtro });
      return { deletedCount: 2 };
    },
    findOne: async () => docs[nome] || null,
  });

  // A foto mora noutro modelo, e o equipamento só manda recados para ele: a
  // faxina depois de salvar e a remoção junto com o aparelho.
  const equipmentImage = {
    pruneUnused: async (id, emUso) => feito.fotos.push({ o: "faxina", id: String(id), emUso }),
    removeAllOf: async (id) => feito.fotos.push({ o: "apagouTodas", id: String(id) }),
  };

  return {
    feito,
    docs,
    app: {
      mongodb: { connectToServer: async () => ({ collection: colecao }) },
      api: { equipmentImage },
    },
  };
}

// ── O HISTÓRICO DE MANUTENÇÃO ─────────────────────────────────────────────

test("a manutenção guarda o valor, o fornecedor e quando é a próxima", async () => {
  // *"caso eu tiver que gastar dinheiro para fazer a manutenção, seria um
  // histórico dentro do equipamento, com as manutenções e o valor"*.
  const b = banco();
  const model = new Equipment(b.app);

  await model.lancarManutencao(
    EQUIPAMENTO,
    { tipo: "preventiva", custo: 18000, fornecedor: "Técnico do bairro", proximaEm: "2027-03-01" },
    { _id: OUTRO, name: "Marlon" }
  );

  const { doc } = b.feito.inseriu.find((x) => x.colecao === "equipment_maintenances");
  assert.equal(doc.custo, 18000);
  assert.equal(doc.fornecedor, "Técnico do bairro");
  assert.equal(doc.tipo, "preventiva");
  assert.equal(doc.proximaEm.getFullYear(), 2027);
  // Quem lançou fica na linha: seis meses depois, "quem chamou esse técnico?"
  // é uma pergunta real.
  assert.equal(doc.createdByName, "Marlon");
});

test("um tipo que não existe vira corretiva, e não entra cru no banco", async () => {
  const b = banco();
  await new Equipment(b.app).lancarManutencao(EQUIPAMENTO, { tipo: "gambiarra" }, {});

  assert.equal(b.feito.inseriu[0].doc.tipo, "corretiva");
});

test("custo negativo ou lixo conta como zero", async () => {
  // Um custo negativo somaria ao contrário no relatório — e o relatório é o
  // motivo de o campo existir.
  const b = banco();
  const model = new Equipment(b.app);

  await model.lancarManutencao(EQUIPAMENTO, { custo: -500 }, {});
  await model.lancarManutencao(EQUIPAMENTO, { custo: "não sei" }, {});

  assert.equal(b.feito.inseriu[0].doc.custo, 0);
  assert.equal(b.feito.inseriu[1].doc.custo, 0);
});

test("lançar manutenção só devolve à operação quem ESTAVA em manutenção", async () => {
  // A regra mora no filtro, não num if: um aparelho baixado que recebe uma
  // manutenção histórica não volta a funcionar por causa disso.
  const b = banco();
  await new Equipment(b.app).lancarManutencao(EQUIPAMENTO, {}, {});

  const volta = b.feito.atualizou.find((x) => x.colecao === "equipments");
  assert.equal(volta.filtro.estado, "manutencao");
  assert.equal(volta.mudanca.$set.estado, "ok");
});

test("apagar o equipamento leva o histórico junto", async () => {
  const b = banco();
  await new Equipment(b.app).remove(EQUIPAMENTO);

  const sobra = b.feito.apagouMuitos.find((x) => x.colecao === "equipment_maintenances");
  assert.ok(sobra, "as manutenções ficariam órfãs no banco");
  assert.equal(String(sobra.filtro.equipment), EQUIPAMENTO);
});

test("apagar o equipamento leva a FOTO junto", async () => {
  // Ela mora no R2. Um documento apagado sem ela deixa bytes pagos no balde
  // que nenhuma tela alcança de novo.
  const b = banco();
  await new Equipment(b.app).remove(EQUIPAMENTO);

  assert.deepEqual(b.feito.fotos, [{ o: "apagouTodas", id: EQUIPAMENTO }]);
});

test("salvar faz a faxina das fotos que não foram escolhidas", async () => {
  // Subir a foto e salvar são dois pedidos; entre um e outro dá para trocar a
  // foto três vezes. O que sobra são bytes órfãos, e o dono da verdade é o
  // equipamento GRAVADO.
  const b = banco();
  b.docs.equipments = { _id: EQUIPAMENTO, photo: OUTRO };

  await new Equipment(b.app).update(EQUIPAMENTO, { name: "Esteira 1" });

  assert.deepEqual(b.feito.fotos, [{ o: "faxina", id: EQUIPAMENTO, emUso: [OUTRO] }]);
});

test("uma manutenção só é apagada pelo equipamento dona dela", async () => {
  // Sem o `equipment` no filtro, o id de uma manutenção de outro aparelho
  // apagaria a linha alheia.
  const b = banco();
  await new Equipment(b.app).removerManutencao(EQUIPAMENTO, OUTRO);

  const { filtro } = b.feito.apagou[0];
  assert.equal(String(filtro.equipment), EQUIPAMENTO);
  assert.equal(String(filtro._id), OUTRO);
});

test("um id inválido não vira manutenção nenhuma", async () => {
  const b = banco();
  const r = await new Equipment(b.app).lancarManutencao("nada disso", { custo: 100 }, {});

  assert.equal(r, null);
  assert.equal(b.feito.inseriu.length, 0);
});

test("o gasto acumulado é null, e não zero, quando ninguém perguntou", async () => {
  // A ficha aberta sozinha não faz o $lookup da lista. Devolver 0 diria "este
  // aparelho nunca custou nada", que é outra afirmação.
  const { paraTela } = Equipment;

  assert.equal(paraTela({ _id: EQUIPAMENTO, name: "Esteira" }).gastoEmManutencao, null);
  assert.equal(paraTela({ _id: EQUIPAMENTO, name: "Esteira", gastoEmManutencao: 0 }).gastoEmManutencao, 0);
});

// ── O LIVRO DO ESTOQUE ────────────────────────────────────────────────────

test("a saída grava o efeito no saldo com sinal, e o saldo depois", async () => {
  const b = banco();
  b.docs.supplies = { _id: INSUMO, name: "Desinfetante", saldo: 10 };

  const r = await new Supply(b.app).movimentar(INSUMO, { tipo: "saida", quantidade: 3 }, {});

  const { doc } = b.feito.inseriu.find((x) => x.colecao === "supply_moves");
  assert.equal(doc.quantidade, -3);
  assert.equal(doc.saldoDepois, 7);
  assert.equal(r.depois, 7);
});

test("o ajuste DEFINE o saldo, ele não soma", async () => {
  // Quem conta a prateleira digita o que viu — 4 galões. Somar 4 a um saldo
  // de 10 daria 14, que é exatamente o número errado que a contagem veio
  // corrigir.
  const b = banco();
  b.docs.supplies = { _id: INSUMO, name: "Desinfetante", saldo: 10 };

  await new Supply(b.app).movimentar(INSUMO, { tipo: "ajuste", quantidade: 4 }, {});

  const { doc } = b.feito.inseriu[0];
  assert.equal(doc.saldoDepois, 4);
  assert.equal(doc.quantidade, -6);
});

test("o saldo do insumo e o livro são gravados no mesmo gesto", async () => {
  const b = banco();
  b.docs.supplies = { _id: INSUMO, saldo: 2 };

  await new Supply(b.app).movimentar(INSUMO, { tipo: "entrada", quantidade: 5 }, {});

  assert.equal(b.feito.atualizou[0].mudanca.$set.saldo, 7);
});

test("o custo só existe na entrada", async () => {
  // Na saída o que sai é consumo. Carimbar preço nela seria inventar um custo
  // médio que este módulo não calcula — e o total do relatório contaria o
  // mesmo dinheiro duas vezes.
  const b = banco();
  b.docs.supplies = { _id: INSUMO, saldo: 10 };
  const model = new Supply(b.app);

  await model.movimentar(INSUMO, { tipo: "entrada", quantidade: 2, custo: 4500 }, {});
  await model.movimentar(INSUMO, { tipo: "saida", quantidade: 2, custo: 4500 }, {});

  assert.equal(b.feito.inseriu[0].doc.custo, 4500);
  assert.equal(b.feito.inseriu[1].doc.custo, 0);
});

test("movimento de quantidade zero não vira linha", async () => {
  const b = banco();
  b.docs.supplies = { _id: INSUMO, saldo: 10 };

  const r = await new Supply(b.app).movimentar(INSUMO, { tipo: "saida", quantidade: 0 }, {});

  assert.equal(r, null);
  assert.equal(b.feito.inseriu.length, 0);
});

test("um ajuste para zero é válido — é o que esvazia a prateleira", async () => {
  // A exceção do caso acima: zerar a contagem é um lançamento legítimo, e o
  // único jeito de dizer "acabou".
  const b = banco();
  b.docs.supplies = { _id: INSUMO, saldo: 10 };

  await new Supply(b.app).movimentar(INSUMO, { tipo: "ajuste", quantidade: 0 }, {});

  assert.equal(b.feito.inseriu[0].doc.saldoDepois, 0);
});

test("movimentar um insumo que não existe não grava nada", async () => {
  const b = banco();
  b.docs.supplies = null;

  const r = await new Supply(b.app).movimentar(INSUMO, { tipo: "saida", quantidade: 1 }, {});

  assert.equal(r, null);
  assert.equal(b.feito.inseriu.length, 0);
});
