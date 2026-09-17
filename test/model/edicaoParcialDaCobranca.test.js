const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Finance_model = require("../../model/Finance_model.js");

// ── O QUE SAIU DAQUI, e para onde ─────────────────────────────────────────
//
// Este arquivo começou guardando o RESUMO da carteira: "cada vez que eu troco de
// aba, os valores ali em cima mudam" — e mudavam porque o status entrava no
// filtro do banco, então a lista vinha recortada e o resumo era calculado sobre
// o recorte.
//
// A regra continua valendo, e continua sendo a mesma. O que mudou foi a FORMA:
// com a paginação (17/09/2026) a carteira virou uma agregação só, com `$facet`,
// e a separação entre "a janela inteira" e "o recorte" passou a ser a separação
// entre dois ramos do facet. Os casos que a protegem moram em
// `test/model/carteiraPaginada.test.js`, onde há como afirmá-la.
//
// Aqui ficou a outra metade, que é sobre outra coisa.

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
