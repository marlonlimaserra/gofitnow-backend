const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Chat_model = require("../../model/Chat_model.js");

// A unicidade da conversa.
//
// Este arquivo existe por causa de um erro que passou por todos os testes e só
// apareceu em produção: o índice único estava sobre `members`, um ARRAY. Índice
// único em array no MongoDB é multikey — ele exige que cada ELEMENTO seja único
// na collection inteira, o que na prática dizia "cada pessoa participa de no
// máximo uma conversa". A primeira funcionava; a segunda de qualquer um
// devolvia erro interno.
//
// A unicidade agora é sobre `pairKey`, um escalar. É essa propriedade que os
// testes abaixo protegem: MESMA dupla → mesma chave; duplas diferentes →
// chaves diferentes.
const A = "6a7cbba1d2908f75788e92bf";
const B = "6a7e1eaab271491321c26067";
const C = "6a7e1eaab271491321c26099";

// Um dublê da collection que se comporta como o índice único de verdade: ele
// RECUSA um segundo documento com a mesma chave. Sem isso o teste passaria
// mesmo com o modelo gravando duas conversas para a mesma dupla.
function fakeCollection() {
  const docs = [];

  return {
    docs,
    async updateOne(filtro, alteracao, opcoes) {
      const achado = docs.find((d) => d.pairKey === filtro.pairKey);
      if (achado) return { matchedCount: 1 };

      if (opcoes?.upsert) {
        const novo = { _id: `c${docs.length + 1}`, ...alteracao.$setOnInsert };

        if (docs.some((d) => d.pairKey === novo.pairKey)) {
          const erro = new Error("E11000 duplicate key");
          erro.code = 11000;
          throw erro;
        }

        docs.push(novo);
      }

      return { matchedCount: 0 };
    },
    async findOne(filtro) {
      return docs.find((d) => d.pairKey === filtro.pairKey);
    },
  };
}

function monta() {
  const col = fakeCollection();
  const chat = new Chat_model({});
  chat.conversations = async () => col;
  return { chat, col };
}

test("abrir duas vezes a mesma dupla devolve a MESMA conversa", async () => {
  const { chat, col } = monta();

  const primeira = await chat.openWith(A, B);
  const segunda = await chat.openWith(A, B);

  assert.equal(String(primeira._id), String(segunda._id));
  assert.equal(col.docs.length, 1);
});

test("a ordem em que se abre não cria duas conversas", async () => {
  // O profissional abre com o cliente, o cliente abre com o profissional. Sem
  // ordenar os ids, seriam dois documentos e cada lado veria metade das
  // mensagens.
  const { chat, col } = monta();

  const daqui = await chat.openWith(A, B);
  const dela = await chat.openWith(B, A);

  assert.equal(String(daqui._id), String(dela._id));
  assert.equal(col.docs.length, 1);
});

test("a MESMA pessoa pode ter várias conversas", async () => {
  // O teste que o índice antigo reprovava. `A` fala com `B` e com `C`: são duas
  // conversas, e o único que se repete entre elas é o próprio `A`.
  const { chat, col } = monta();

  const comB = await chat.openWith(A, B);
  const comC = await chat.openWith(A, C);

  assert.notEqual(String(comB._id), String(comC._id));
  assert.equal(col.docs.length, 2);
});

test("os membros ficam gravados como ObjectId, ordenados", async () => {
  // A ordem é o que torna a chave estável; o tipo é o que faz a busca por
  // participante encontrar alguma coisa.
  const { chat } = monta();

  const conversa = await chat.openWith(B, A);

  assert.ok(conversa.members.every((m) => m instanceof ObjectId));
  assert.deepEqual(
    conversa.members.map(String),
    [A, B].sort()
  );
  assert.equal(conversa.pairKey, [A, B].sort().join("_"));
});

test("corrida de duas aberturas simultâneas não derruba a rota", async () => {
  // Dois pedidos chegando juntos passam os dois pela verificação de existência,
  // e um insere depois do outro. O perdedor recebe 11000 — e a conversa que ele
  // queria existe, criada pelo vencedor.
  const { chat, col } = monta();

  const [uma, outra] = await Promise.all([chat.openWith(A, B), chat.openWith(A, B)]);

  assert.equal(String(uma._id), String(outra._id));
  assert.equal(col.docs.length, 1);
});
