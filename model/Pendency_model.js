const { ObjectId } = require("mongodb");
const categorias = require("../lib/categoriasDePendencia.js");

// AS PENDÊNCIAS DE UMA PESSOA — o que está em aberto entre ela e a casa.
//
// *"a academia cadastrou camisa como pendência, para eu ser barrado na recepção
// para eles me entregarem a camisa"*.
//
// ── ELA EXISTE PARA FAZER ALGUÉM SER PARADO NO BALCÃO ───────────────────
//
// Esse é o propósito inteiro, e ele decide o desenho. Não é uma lista de
// tarefas, não é um CRM: é um bilhete grudado na ficha, que aparece na cara de
// quem atende antes de qualquer outra coisa, e some quando a coisa acontece.
//
// Por isso ela é curta — título, categoria, quem deve — e não tem prazo,
// responsável nem prioridade. Um campo a mais é um campo que a recepção vai
// deixar em branco.
//
// ── AS AUTOMÁTICAS NÃO MORAM AQUI ───────────────────────────────────────
//
// O documento obrigatório que falta é uma pendência também, e é CALCULADA: ela
// nasce quando o modelo é marcado como obrigatório e morre quando o arquivo é
// guardado. Gravá-la aqui exigiria criar uma linha para cada aluno no momento
// da marcação, e apagá-la em cada upload — duas chances de divergir do que a
// ficha mostra.
//
// `lib/pendencias.js` junta as duas fontes. Esta collection guarda só o que
// alguém escreveu à mão.
function Pendency_model(app) {
  this.app = app;
}

Pendency_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("pendencies");
};

const CAMPOS = {
  titulo: (v) => String(v || "").trim().slice(0, 160),
  categoria: (v) => (categorias.existe(v) ? String(v) : "outro"),
  // `aluno` ou `casa`. Ver `categoriasDePendencia.js`: é o que decide se ela
  // pode travar o acesso.
  quem: (v) => (String(v) === "casa" ? "casa" : "aluno"),
  note: (v) => String(v || "").trim().slice(0, 500),
};

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);

  return saida;
}

Pendency_model.prototype.listar = async function (person, { incluirResolvidas } = {}) {
  if (!ObjectId.isValid(person)) return [];

  const col = await this.collection();
  const filtro = { person: new ObjectId(person) };
  if (!incluirResolvidas) filtro.resolvidoEm = null;

  const docs = await col.find(filtro).sort({ resolvidoEm: 1, createdAt: -1 }).toArray();
  return docs.map(paraTela);
};

function paraTela(d) {
  return {
    id: String(d._id),
    origem: "manual",
    titulo: d.titulo,
    categoria: d.categoria,
    quem: d.quem,
    note: d.note || "",
    resolvida: !!d.resolvidoEm,
    resolvidoEm: d.resolvidoEm || null,
    resolvidoPorNome: d.resolvidoPorNome || "",
    createdAt: d.createdAt,
    createdByName: d.createdByName || "",
  };
}

Pendency_model.prototype.insert = async function (person, obj, quem) {
  if (!ObjectId.isValid(person)) return null;

  const doc = limpar(obj);
  if (!doc.titulo) return null;

  const col = await this.collection();
  const r = await col.insertOne({
    ...doc,
    person: new ObjectId(person),
    // `null`, e não ausente: a consulta das abertas filtra por `resolvidoEm:
    // null`, e um campo que não existe não casa com isso no Mongo.
    resolvidoEm: null,
    resolvidoPor: null,
    resolvidoPorNome: "",
    createdBy: quem?._id ? new ObjectId(String(quem._id)) : null,
    createdByName: String(quem?.name || "").slice(0, 120),
    createdAt: new Date(),
  });

  return r.insertedId;
};

// ── RESOLVER, e não apagar ────────────────────────────────────────────────
//
// A camisa entregue vira uma linha resolvida, com quem entregou e quando.
// Apagar apagaria a prova de que a casa cumpriu — e é justamente o que alguém
// vai querer conferir quando o aluno disser que nunca recebeu.
Pendency_model.prototype.resolver = async function (person, id, quem) {
  if (!ObjectId.isValid(person) || !ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id), person: new ObjectId(person), resolvidoEm: null },
    {
      $set: {
        resolvidoEm: new Date(),
        resolvidoPor: quem?._id ? new ObjectId(String(quem._id)) : null,
        resolvidoPorNome: String(quem?.name || "").slice(0, 120),
      },
    }
  );

  return r.matchedCount > 0;
};

Pendency_model.prototype.reabrir = async function (person, id) {
  if (!ObjectId.isValid(person) || !ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id), person: new ObjectId(person) },
    { $set: { resolvidoEm: null, resolvidoPor: null, resolvidoPorNome: "" } }
  );

  return r.matchedCount > 0;
};

// Apagar existe para o que foi criado errado — "camiseta" duas vezes. O caminho
// normal é RESOLVER.
Pendency_model.prototype.remove = async function (person, id) {
  if (!ObjectId.isValid(person) || !ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), person: new ObjectId(person) });
  return r.deletedCount > 0;
};

Pendency_model.prototype.removeAllOf = async function (person) {
  if (!ObjectId.isValid(person)) return 0;
  const col = await this.collection();
  const r = await col.deleteMany({ person: new ObjectId(person) });
  return r.deletedCount || 0;
};

Pendency_model.prototype.contarAbertasDe = async function (person) {
  if (!ObjectId.isValid(person)) return 0;
  const col = await this.collection();
  return col.countDocuments({ person: new ObjectId(person), resolvidoEm: null });
};

module.exports = Pendency_model;
module.exports.paraTela = paraTela;
