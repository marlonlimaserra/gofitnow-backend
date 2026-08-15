const { ObjectId } = require("mongodb");
const ai = require("../lib/ai.js");

// As conversas com o assistente.
//
// Ficam no banco DA INSTÂNCIA, junto de tudo que é do cliente. Uma conversa
// carrega nome, e-mail e telefone de quem foi cadastrado — é dado de paciente
// como qualquer outro, e o lugar dele é o banco dele. O central recebe só a
// contagem (ver Center_model#registrarUsoIa): quanto gastou, de qual instância.
//
// A conversa é regravada INTEIRA a cada turno, e não acrescentada pedaço a
// pedaço. Parece desperdício e não é: a tela já manda a conversa completa a cada
// turno (a API da Anthropic não guarda estado), então o servidor sempre tem a
// versão nova em mãos. Gravar o que ele recebeu é uma escrita e nunca diverge;
// costurar deltas seria inventar um jeito de a cópia do banco ficar diferente da
// que está na tela.
function AiSession_model(app) {
  this.app = app;
}

AiSession_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("ai_sessions");
};

// O título é a PRIMEIRA fala da pessoa, cortada.
//
// Não é o modelo que escreve: pedir um título custaria uma chamada a mais por
// conversa para produzir uma linha de lista. "cadastra a Ana Souza, ana@..."
// identifica a conversa tão bem quanto qualquer resumo, e sai de graça.
AiSession_model.prototype.titulo = function (messages) {
  const primeira = (messages || []).find((m) => m.role === "user");
  const blocos = Array.isArray(primeira?.content) ? primeira.content : [];
  const texto = blocos.find((b) => b.type === "text" && !String(b.text).startsWith("Tela aberta"));

  const cru = String(texto?.text || primeira?.content || "").trim();
  return cru.slice(0, 120) || "Conversa";
};

// Um turno gravado: a conversa nova por cima da antiga, o gasto somado.
//
// Devolve a sessão como a tela precisa vê-la. Sem `sessionId` ela nasce.
AiSession_model.prototype.registrarTurno = async function ({
  sessionId,
  userId,
  model,
  messages,
  usage,
  provider,
}) {
  const col = await this.collection();
  const agora = new Date();

  // Conversa que rodou na máquina do cliente custa zero, e é isso que fica
  // gravado. Os TOKENS continuam sendo guardados: eles dizem se o modelo local
  // está inflando o contexto, que é a pergunta útil quando não há fatura.
  const micros = ai.custoMicros(usage, model, provider);
  const existente = sessionId && ObjectId.isValid(sessionId) ? new ObjectId(sessionId) : null;

  if (existente) {
    // `$inc` no gasto e não uma leitura seguida de escrita: dois turnos que
    // terminassem juntos leriam o mesmo total e um sobrescreveria o outro.
    const atualizada = await col.findOneAndUpdate(
      { _id: existente, user: new ObjectId(userId) },
      {
        $set: { messages, model, updatedAt: agora },
        $inc: {
          costMicros: micros,
          turns: 1,
          "usage.input_tokens": Number(usage?.input_tokens || 0),
          "usage.output_tokens": Number(usage?.output_tokens || 0),
          "usage.cache_creation_input_tokens": Number(usage?.cache_creation_input_tokens || 0),
          "usage.cache_read_input_tokens": Number(usage?.cache_read_input_tokens || 0),
        },
      },
      { returnDocument: "after" }
    );

    // O driver 6 devolve o DOCUMENTO direto; o envelope `{ value }` é da API
    // antiga. Este código destruturava `{ value }`, que vinha sempre
    // `undefined` — e o `undefined` caía no insert logo abaixo. A conversa era
    // atualizada E clonada numa sessão nova, a cada turno: dez minutos de
    // conversa viraram quarenta registros, cada um com um pedaço do custo, o
    // histórico virou uma parede de "oi" e o contador do central ganhou uma
    // linha por turno em vez de uma por conversa.
    //
    // Nada quebrava visivelmente, e é por isso que passou: a resposta continuava
    // certa, o custo aparecia na tela, e só o registro ficava errado.
    //
    // As duas formas são aceitas, e o `_id` é quem decide — checar o documento
    // primeiro impede que um campo chamado `value` seja confundido com o
    // envelope antigo.
    const doc = atualizada?._id ? atualizada : atualizada?.value;

    // Sessão de outra conta, ou apagada no meio da conversa. Cai para uma nova
    // em vez de estourar: a pessoa está no meio de uma tarefa.
    if (doc?._id) return doc;
  }

  const doc = {
    user: new ObjectId(userId),
    title: this.titulo(messages),
    model,
    provider: ai.normalizeProvider(provider),
    messages,
    usage: ai.somarUsage({}, usage),
    costMicros: micros,
    turns: 1,
    createdAt: agora,
    updatedAt: agora,
  };

  const { insertedId } = await col.insertOne(doc);
  return { ...doc, _id: insertedId };
};

// A lista, sem as mensagens.
//
// A conversa de uma sessão passa fácil de 100 KB; devolver vinte delas para
// desenhar uma lista de títulos seria mandar megabytes para mostrar linhas.
AiSession_model.prototype.listar = async function (userId, limite = 30) {
  const col = await this.collection();

  return col
    .find({ user: new ObjectId(userId) })
    .project({ messages: 0 })
    .sort({ updatedAt: -1 })
    .limit(Math.min(Number(limite) || 30, 100))
    .toArray();
};

AiSession_model.prototype.data = async function (id, userId) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  // O `user` no filtro é a autorização: sem ele, um id adivinhado abriria a
  // conversa de outro profissional da mesma instância.
  return (await col.findOne({ _id: new ObjectId(id), user: new ObjectId(userId) })) || undefined;
};

AiSession_model.prototype.remover = async function (id, userId) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const { deletedCount } = await col.deleteOne({
    _id: new ObjectId(id),
    user: new ObjectId(userId),
  });
  return deletedCount > 0;
};

// O gasto do cliente inteiro, por período. É o que responde "quanto a IA custou
// este mês" sem somar sessão por sessão na tela.
AiSession_model.prototype.resumo = async function (desde) {
  const col = await this.collection();
  const filtro = desde ? { createdAt: { $gte: desde } } : {};

  const [linha] = await col
    .aggregate([
      { $match: filtro },
      {
        $group: {
          _id: null,
          sessions: { $sum: 1 },
          turns: { $sum: "$turns" },
          costMicros: { $sum: "$costMicros" },
        },
      },
    ])
    .toArray();

  return { sessions: 0, turns: 0, costMicros: 0, ...(linha || {}), _id: undefined };
};

module.exports = AiSession_model;
