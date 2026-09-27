// AS CONTAS DE FORA QUE O CLIENTE LIGOU AO VAFIT.
//
// Hoje: Instagram. Amanhã: a Página do Facebook e o número do WhatsApp — por
// isso a collection tem `tipo` desde o primeiro dia, e não se chama
// `instagram_accounts`. Renomear collection em produção é migração; um campo a
// mais, não.
//
// ── POR QUE O TOKEN MORA AQUI, e não na central ─────────────────────────
//
// Ele é DO CLIENTE: é a conta dele, autorizada por ele, e só o sistema dele
// deve falar por ela. Na central, um defeito de escopo alcançaria as contas de
// todo mundo de uma vez. Aqui o `lib/escopo.js` já protege por construção.
//
// ── O token NUNCA volta para a tela ─────────────────────────────────────
//
// `paraTela` existe para isso, e é o único caminho que o controlador usa. Um
// token de 60 dias visível no navegador é a conta de Instagram de um cliente
// nas mãos de qualquer extensão instalada ali — e ele não expira quando a
// pessoa sai do sistema.
const COLLECTION = "connected_accounts";

function ContaConectada_model(app) {
  this.app = app;
}

ContaConectada_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection(COLLECTION);
};

// O que a tela pode ver. Tudo menos o token — e o token nem sequer é lido do
// banco, para não passear pela memória de uma rota que não precisa dele.
ContaConectada_model.prototype.paraTela = function (doc) {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    tipo: doc.tipo,
    externalId: doc.externalId,
    usuario: doc.usuario || "",
    nome: doc.nome || "",
    foto: doc.foto || "",
    escopos: doc.escopos || [],
    expiraEm: doc.expiraEm || null,
    conectadaEm: doc.conectadaEm || null,
    conectadaPor: doc.conectadaPor || null,
  };
};

ContaConectada_model.prototype.lista = async function (tipo) {
  const col = await this.collection();
  const filtro = tipo ? { tipo: String(tipo) } : {};
  const docs = await col
    .find(filtro, { projection: { token: 0 } })
    .sort({ conectadaEm: -1 })
    .toArray();
  return docs.map((d) => this.paraTela(d));
};

ContaConectada_model.prototype.porId = async function (id) {
  const col = await this.collection();
  const doc = await col.findOne({ _id: this.app.ObjectId.createFromHexString(String(id)) });
  return doc || null;
};

// ── Conectar de novo a MESMA conta substitui, não duplica ────────────────
//
// É o caminho comum: o token de 60 dias venceu, a pessoa clica em conectar
// outra vez. Sem esta chave, a lista encheria de linhas iguais e o webhook não
// saberia qual token usar — e escolheria o mais velho, que é o que não serve.
ContaConectada_model.prototype.guardar = async function (dados, user) {
  const col = await this.collection();
  const agora = new Date();

  const chave = { tipo: String(dados.tipo), externalId: String(dados.externalId) };

  await col.updateOne(
    chave,
    {
      $set: {
        ...chave,
        token: String(dados.token),
        expiraEm: dados.expiraEm || null,
        usuario: String(dados.usuario || ""),
        nome: String(dados.nome || ""),
        foto: String(dados.foto || ""),
        escopos: Array.isArray(dados.escopos) ? dados.escopos : [],
        conectadaEm: agora,
        conectadaPor: user ? String(user.name || user.email || "") : null,
      },
    },
    { upsert: true }
  );

  return col.findOne(chave, { projection: { token: 0 } });
};

ContaConectada_model.prototype.remover = async function (id) {
  const col = await this.collection();
  const r = await col.deleteOne({ _id: this.app.ObjectId.createFromHexString(String(id)) });
  return { ok: r.deletedCount > 0 };
};

module.exports = ContaConectada_model;
module.exports.COLLECTION = COLLECTION;
