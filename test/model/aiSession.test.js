const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const AiSession_model = require("../../model/AiSession_model.js");

// Uma conversa é UMA sessão.
//
// Era: cada turno criava uma sessão nova. Dez minutos de conversa viraram
// quarenta registros no banco, cada um com um pedaço do custo, o histórico da
// tela virou uma parede de "oi" repetido e o contador do central ganhou uma
// linha por turno em vez de uma por conversa.
//
// A causa era uma linha: `const { value } = await col.findOneAndUpdate(...)`.
// O envelope `{ value }` é da API antiga do driver; o driver 6 devolve o
// DOCUMENTO direto. `value` vinha sempre `undefined`, e o `undefined` caía no
// insert logo abaixo — a conversa era atualizada E clonada.
//
// Nada quebrava visivelmente: a resposta continuava certa, o custo aparecia na
// tela. Só o registro ficava errado. Por isso o dublê abaixo imita a forma de
// resposta do DRIVER DE VERDADE — é o detalhe que o teste existe para prender.
function fakeCollection({ envelope = "driver6", achou = true } = {}) {
  const chamadas = { update: [], insert: [] };

  const col = {
    async findOneAndUpdate(filtro, mudanca, opcoes) {
      chamadas.update.push({ filtro, mudanca, opcoes });
      if (!achou) return envelope === "driver6" ? null : { value: null };

      const doc = {
        _id: filtro._id,
        user: filtro.user,
        title: "oi",
        messages: mudanca.$set.messages,
        turns: 7,
        costMicros: 123456,
      };
      return envelope === "driver6" ? doc : { value: doc };
    },
    async insertOne(doc) {
      chamadas.insert.push(doc);
      return { insertedId: new ObjectId() };
    },
  };

  const model = new AiSession_model({});
  model.collection = async () => col;

  return { model, chamadas };
}

const USUARIO = new ObjectId();
const SESSAO = new ObjectId();

const TURNO = {
  userId: USUARIO,
  model: "claude-opus-5",
  messages: [{ role: "user", content: "oi" }],
  usage: { input_tokens: 1000, output_tokens: 200 },
  provider: "anthropic",
};

test("com sessão existente, o turno ATUALIZA — não cria outra", async () => {
  const { model, chamadas } = fakeCollection();

  const saida = await model.registrarTurno({ ...TURNO, sessionId: String(SESSAO) });

  assert.equal(chamadas.update.length, 1);
  assert.equal(chamadas.insert.length, 0, "criar uma sessão por turno foi o defeito");
  assert.equal(String(saida._id), String(SESSAO));
  assert.equal(saida.turns, 7, "o total volta do banco, não de uma conta na mão");
});

test("a forma antiga do driver continua entendida", async () => {
  // Se o driver voltar a embrulhar em `{ value }`, o registro não pode voltar a
  // se partir em quarenta pedaços em silêncio.
  const { model, chamadas } = fakeCollection({ envelope: "driver5" });

  const saida = await model.registrarTurno({ ...TURNO, sessionId: String(SESSAO) });

  assert.equal(chamadas.insert.length, 0);
  assert.equal(String(saida._id), String(SESSAO));
});

test("sem sessão nenhuma, ela nasce", async () => {
  const { model, chamadas } = fakeCollection();

  await model.registrarTurno(TURNO);

  assert.equal(chamadas.update.length, 0, "não há o que atualizar");
  assert.equal(chamadas.insert.length, 1);
  assert.equal(chamadas.insert[0].turns, 1);
  assert.equal(chamadas.insert[0].title, "oi", "o título sai da primeira fala");
});

test("id inválido não vira consulta — nasce uma sessão", async () => {
  const { model, chamadas } = fakeCollection();

  await model.registrarTurno({ ...TURNO, sessionId: "não-é-um-id" });

  assert.equal(chamadas.update.length, 0);
  assert.equal(chamadas.insert.length, 1);
});

test("sessão de OUTRA conta cai para uma nova em vez de estourar", async () => {
  // O dono entra no filtro: um id adivinhado não alcança a conversa de ninguém.
  // Não achar, aqui, é o caso normal de uma sessão apagada no meio da conversa —
  // e a pessoa está no meio de uma tarefa.
  const { model, chamadas } = fakeCollection({ achou: false });

  const saida = await model.registrarTurno({ ...TURNO, sessionId: String(SESSAO) });

  assert.equal(chamadas.update.length, 1);
  assert.equal(chamadas.insert.length, 1);
  assert.ok(saida._id);
});

test("o dono vai no FILTRO da atualização, não só no documento", async () => {
  const { model, chamadas } = fakeCollection();

  await model.registrarTurno({ ...TURNO, sessionId: String(SESSAO) });

  assert.equal(String(chamadas.update[0].filtro.user), String(USUARIO));
});

test("o gasto e os turnos são somados pelo banco, não relidos e reescritos", async () => {
  // Dois turnos que terminassem juntos leriam o mesmo total e um sobrescreveria
  // o outro.
  const { model, chamadas } = fakeCollection();

  await model.registrarTurno({ ...TURNO, sessionId: String(SESSAO) });

  const inc = chamadas.update[0].mudanca.$inc;
  assert.equal(inc.turns, 1);
  assert.ok(inc.costMicros > 0);
  assert.equal(inc["usage.input_tokens"], 1000);
  assert.equal(inc["usage.output_tokens"], 200);
});

test("a atualização pede o documento DEPOIS da escrita", async () => {
  // Com o de antes, a tela mostraria o custo de um turno atrás.
  const { model, chamadas } = fakeCollection();

  await model.registrarTurno({ ...TURNO, sessionId: String(SESSAO) });

  assert.equal(chamadas.update[0].opcoes.returnDocument, "after");
});
