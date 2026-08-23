const { ObjectId } = require("mongodb");
const crypto = require("crypto");

// O LINK que a pessoa recebe para responder a própria anamnese.
//
//   anamnesis_links → um link ativo por (profissional, pessoa)
//
// ── POR QUE O TOKEN FICA EM CLARO AQUI, E NÃO EM HASH ─────────────────────
//
// O `password_resets` guarda só o hash, e por um motivo forte: aquele token dá
// acesso à CONTA, que é muito mais do que a linha do banco onde ele mora. Hash
// protege o caso em que o depósito de tokens vaza e o alvo não.
//
// Aqui os dois são o MESMO depósito. Este token dá direito a escrever uma
// anamnese e a ler o primeiro nome da pessoa — tudo dentro do banco que
// precisaria ter vazado para alguém ler o token. Hash não protegeria de nada, e
// custaria a coisa que faz o recurso funcionar: poder mostrar o MESMO link de
// novo. Sem isso, reabrir o dialog teria de gerar outro token, e o link que o
// profissional mandou ontem morreria porque ele abriu a tela hoje.
//
// A defesa real está em outro lugar: o link vence, é único por pessoa, e quase
// não lê (ver abaixo).
//
// ── O QUE ESTE LINK PODE, E O QUE ELE NÃO PODE ────────────────────────────
//
// Ele é uma credencial pública: quem tem o endereço, entra. Então ele foi
// desenhado para dar o MENOS possível.
//
//   • ESCREVE, quase não lê. A tela pública devolve o primeiro nome da pessoa (para
//     ela saber que é dela) e o nome do espaço. NÃO devolve o que já foi
//     respondido — se o link cair num grupo de WhatsApp, ninguém lê a anamnese
//     de ninguém.
//   • VENCE. Quinze dias; depois disso o endereço deixa de existir, e o índice
//     TTL varre a linha.
//   • É ÚNICO por pessoa. Gerar outro invalida o anterior na hora — é a única
//     defesa real para um link que foi parar no lugar errado.
//   • NÃO apaga nada. A resposta da pessoa preenche o que está vazio e não
//     sobrescreve o que o profissional escreveu (ver o controller).
const DIAS_DE_VALIDADE = 15;

function AnamnesisLink_model(app) {
  this.app = app;
}

AnamnesisLink_model.prototype.diasDeValidade = DIAS_DE_VALIDADE;

AnamnesisLink_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("anamnesis_links");
};

// Cria e devolve o token CRU — a única vez que ele existe fora do endereço.
AnamnesisLink_model.prototype.create = async function (trainerId, studentId) {
  const col = await this.collection();

  // O anterior morre aqui. Pedir um link novo tem de invalidar o antigo, senão
  // "gerar outro" não protege de nada.
  await col.deleteMany({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + DIAS_DE_VALIDADE);

  await col.insertOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    token,
    expiresAt,
    createdAt: new Date(),
    // Quando a pessoa respondeu. Fica no link, e não só na anamnese, porque é o
    // que a tela do profissional mostra: "respondido em 12/08".
    submittedAt: null,
  });

  return { token, expiresAt };
};

// O link ativo daquela pessoa — com o token, que é o que a tela mostra no QR e
// no botão de copiar.
AnamnesisLink_model.prototype.doStudent = async function (trainerId, studentId) {
  const col = await this.collection();
  const doc = await col.findOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
  });

  // Vencido é o mesmo que não existir. O TTL do Mongo varre "em algum momento" —
  // até um minuto de atraso é normal —, e a tela não pode oferecer um link morto.
  if (!doc) return null;
  return doc.expiresAt instanceof Date && doc.expiresAt <= new Date() ? null : doc;
};

// Quem está do outro lado do endereço. Devolve `null` para token inválido E para
// token vencido: de fora, as duas coisas são a mesma, e distinguir só ajudaria
// quem está chutando tokens.
AnamnesisLink_model.prototype.byToken = async function (token) {
  if (!token || String(token).length < 32) return null;

  const col = await this.collection();
  const doc = await col.findOne({ token: String(token) });
  if (!doc) return null;
  if (doc.expiresAt instanceof Date && doc.expiresAt <= new Date()) return null;

  return doc;
};

// Marca que a pessoa respondeu. Não apaga o link: ela pode ter esquecido de
// contar o remédio novo e voltar em dez minutos para corrigir — e um link que
// morre na primeira resposta transformaria isso em "pede outro para ele".
AnamnesisLink_model.prototype.markSubmitted = async function (id) {
  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { submittedAt: new Date() } });
};

AnamnesisLink_model.prototype.deleteAllOfStudent = async function (studentId) {
  const col = await this.collection();
  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount;
};

module.exports = AnamnesisLink_model;
