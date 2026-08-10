const { ObjectId } = require("mongodb");

// Coleção `user_tokens` — sessões de qualquer usuário (trainer ou student).
// Cada login gera um token novo; o logout apaga só o token daquela sessão
// (não derruba os outros dispositivos). O índice TTL em `expiresAt` (ver
// database/schema.js) limpa os expirados.
function Auth_model(app) {
  this.app = app;
}

const DIAS_VALIDADE = 30;

Auth_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("user_tokens");
};

Auth_model.prototype.registerToken = async function (userId) {
  const col = await this.collection();
  const token = this.app.uuidv4();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + DIAS_VALIDADE);

  await col.insertOne({
    token: token,
    user: new ObjectId(userId),
    createdAt: new Date(),
    expiresAt: expiresAt,
  });

  return token;
};

Auth_model.prototype.verificar = async function (token) {
  if (!token) return false;
  const col = await this.collection();
  const doc = await col.findOne({ token: String(token) });
  if (!doc) return false;

  // O TTL do Mongo roda a cada ~60s, então um token recém-expirado ainda pode
  // estar na coleção. Checa a data na mão pra não aceitar sessão vencida.
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return false;

  return doc;
};

Auth_model.prototype.deleteToken = async function (token) {
  const col = await this.collection();
  await col.deleteOne({ token: String(token) });
};

Auth_model.prototype.deleteAllTokensByUser = async function (userId) {
  const col = await this.collection();
  await col.deleteMany({ user: new ObjectId(userId) });
};

module.exports = Auth_model;
