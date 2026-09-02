const { ObjectId } = require("mongodb");

// O SUPORTE, do lado de quem PAGA por ele.
//
// O profissional abre um chamado daqui; quem responde é a equipe da GoFitNow, no
// painel. Não é o suporte que ele dá aos alunos dele — é o que ele recebe da
// gente.
//
// ── TUDO MORA NO CENTRAL ──────────────────────────────────────────────────
//
// Chamado, perguntas frequentes e o número do WhatsApp são NOSSOS: a mesma
// resposta serve a todo cliente, e a fila de quem atende tem de ser uma só. Por
// isso `centralDb()`, como o programa de afiliados já faz.
//
// ── E O CENTRAL NÃO TEM ESCOPO ────────────────────────────────────────────
//
// `lib/escopo.js` protege o banco do cliente injetando `instance` em todo
// filtro. O central NÃO passa por ele. Então toda consulta daqui que fale de um
// cliente filtra por instância À MÃO — e é por isso que a instância é parâmetro
// obrigatório em tudo aqui embaixo, e não um detalhe que se possa esquecer.
function Support_model(app) {
  this.app = app;
}

Support_model.prototype.tickets = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("tickets");
};

Support_model.prototype.mensagens = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("ticket_messages");
};

// ── AS PERGUNTAS FREQUENTES ───────────────────────────────────────────────
//
// Só as ativas, na ordem que o painel escolheu.
Support_model.prototype.faq = async function () {
  const db = await this.app.mongodb.centralDb();

  try {
    return await db
      .collection("faq_posts")
      .find({ ativo: { $ne: false } }, { projection: { titulo: 1, resposta: 1 } })
      .sort({ ordem: 1, titulo: 1 })
      .limit(100)
      .toArray();
  } catch (erro) {
    // Central fora do ar não pode derrubar a tela de ajuda: sem perguntas, o
    // ticket e o WhatsApp continuam lá, que é justamente do que a pessoa
    // precisa quando alguma coisa está fora do ar.
    return [];
  }
};

// O WhatsApp de quem atende. Desligado, ou sem número, a tela não mostra o botão
// — link para o vazio é pior que uma opção a menos.
Support_model.prototype.whatsapp = async function () {
  const db = await this.app.mongodb.centralDb();

  try {
    const docs = await db
      .collection("settings")
      .find({ key: { $in: ["support.whatsapp.enabled", "support.whatsapp.number", "support.whatsapp.message"] } })
      .toArray();

    const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));
    // Só dígitos: o link do WhatsApp não aceita parênteses nem hífen, e é o tipo
    // de coisa que alguém digita bonito na tela de configuração.
    const numero = String(v["support.whatsapp.number"] || "").replace(/\D/g, "");

    if (!numero || v["support.whatsapp.enabled"] === false) return null;

    return { numero, mensagem: String(v["support.whatsapp.message"] || "") };
  } catch (erro) {
    return null;
  }
};

// ── OS CHAMADOS DESTE CLIENTE ─────────────────────────────────────────────
//
// `instance` no filtro, sempre. Sem ela a lista traria a de todo mundo — e este
// é o banco onde isso é possível.
Support_model.prototype.meus = async function (instance) {
  const nome = String(instance || "");
  if (!nome) return [];

  const col = await this.tickets();
  return col
    .find({ instance: nome }, { projection: { mensagens: 0 } })
    .sort({ ultimaMensagemEm: -1 })
    .limit(50)
    .toArray();
};

Support_model.prototype.data = async function (instance, id) {
  const nome = String(instance || "");
  if (!nome || !ObjectId.isValid(id)) return undefined;

  const col = await this.tickets();
  // O id NO FILTRO junto da instância: um id adivinhado de outro cliente não
  // pode abrir a conversa dele.
  const doc = await col.findOne({ _id: new ObjectId(id), instance: nome });
  if (!doc) return undefined;

  const msgs = await this.mensagens();
  doc.mensagens = await msgs.find({ ticket: doc._id }).sort({ criadoEm: 1 }).toArray();

  return doc;
};

Support_model.prototype.marcarLido = async function (instance, id) {
  const nome = String(instance || "");
  if (!nome || !ObjectId.isValid(id)) return false;

  const col = await this.tickets();
  const r = await col.updateOne(
    { _id: new ObjectId(id), instance: nome },
    { $set: { novoParaCliente: false } }
  );
  return r.matchedCount > 0;
};

// Quantos chamados têm resposta que este cliente ainda não leu. É o número do
// selinho no ícone de ajuda.
Support_model.prototype.naoLidos = async function (instance) {
  const nome = String(instance || "");
  if (!nome) return 0;

  try {
    const col = await this.tickets();
    return await col.countDocuments({ instance: nome, novoParaCliente: true });
  } catch (erro) {
    return 0;
  }
};

module.exports = Support_model;
