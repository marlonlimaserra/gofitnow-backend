const test = require("node:test");
const assert = require("node:assert/strict");

const Counter_model = require("../../model/Counter_model.js");

// O NÚMERO QUE SE FALA AO TELEFONE.
//
// *"senti falta de um #ID aqui... para quando eu perguntar para alguém 'qual a
// cobrança' ou 'qual fatura'?"*.
//
// O `_id` do Mongo tem 24 caracteres hexadecimais: ninguém dita isso, ninguém
// escreve sem errar, ninguém confere se leu certo. O que se fala é #12.

function montar(documentos = {}) {
  const chamadas = [];
  const model = new Counter_model({});

  model.collection = async () => ({
    async findOneAndUpdate(filtro, op, opcoes) {
      chamadas.push({ filtro, op, opcoes });
      const chave = filtro.chave;
      documentos[chave] = (documentos[chave] || 0) + (op.$inc?.seq || 0);
      return { seq: documentos[chave] };
    },
    async updateOne(filtro, op) {
      chamadas.push({ atualizar: { filtro, op } });
      return { matchedCount: 1 };
    },
  });

  return { model, chamadas, documentos };
}

test("a sequência começa em 1 e anda de um em um", async () => {
  const { model } = montar();

  assert.equal(await model.proximo("charges"), 1);
  assert.equal(await model.proximo("charges"), 2);
  assert.equal(await model.proximo("charges"), 3);
});

test("cada sequência é INDEPENDENTE", async () => {
  // "Qual a fatura?" e "qual o recebimento?" são duas perguntas. Uma sequência
  // só faria a fatura #12 conviver com o recibo #13 sem relação nenhuma.
  const { model } = montar();

  assert.equal(await model.proximo("charges"), 1);
  assert.equal(await model.proximo("payments"), 1);
  assert.equal(await model.proximo("charges"), 2);
});

test("é UMA operação atômica, e não ler-e-somar", async () => {
  // Ler o maior número e somar um é o jeito óbvio, e ele PERDE a corrida: dois
  // cadastros no mesmo instante recebem 12 e 12. O estrago é duas cobranças com
  // o mesmo número — exatamente o que este campo existe para impedir.
  const { model, chamadas } = montar();
  await model.proximo("charges");

  assert.equal(chamadas.length, 1, "uma ida ao banco, e só uma");
  assert.deepEqual(chamadas[0].op, { $inc: { seq: 1 } });
  assert.equal(chamadas[0].opcoes.upsert, true);
  assert.equal(chamadas[0].opcoes.returnDocument, "after");
});

test("a chave é `chave`, e NÃO `_id`", async () => {
  // Com `_id` fixo, o upsert da segunda conta bateria na unicidade do `_id`,
  // que é global — e o cliente seguinte não conseguiria criar cobrança nenhuma.
  // O `instance` entra sozinho no filtro (ver `lib/escopo.js`).
  const { model, chamadas } = montar();
  await model.proximo("charges");

  assert.deepEqual(chamadas[0].filtro, { chave: "charges" });
  assert.ok(!("_id" in chamadas[0].filtro));
});

test("driver que devolve `{ value }` também funciona", async () => {
  // O driver 6 devolve o documento direto; o 4 devolvia embrulhado. Um
  // `undefined` aqui vira cobrança SEM número, e ninguém nota até alguém
  // perguntar "qual é a #?".
  const model = new Counter_model({});
  model.collection = async () => ({
    findOneAndUpdate: async () => ({ value: { seq: 7 } }),
  });

  assert.equal(await model.proximo("charges"), 7);
});

test("resposta vazia não vira número zero nem NaN", async () => {
  const model = new Counter_model({});
  model.collection = async () => ({ findOneAndUpdate: async () => null });

  assert.equal(await model.proximo("charges"), 1);
});
