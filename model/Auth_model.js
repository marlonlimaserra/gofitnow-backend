const sessaoGuardada = require("../lib/sessaoGuardada.js");
const { ObjectId } = require("mongodb");

// The `user_tokens` collection — sessions for any user (trainer or student).
// Each login mints a new token; logout deletes only that session's token, so
// other devices stay signed in. The TTL index on `expiresAt` (see
// database/schema.js) sweeps expired ones.
function Auth_model(app) {
  this.app = app;
}

const VALIDITY_DAYS = 30;

Auth_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("user_tokens");
};

Auth_model.prototype.registerToken = async function (userId) {
  const col = await this.collection();
  const token = this.app.uuidv4();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + VALIDITY_DAYS);

  await col.insertOne({
    token: token,
    user: new ObjectId(userId),
    createdAt: new Date(),
    expiresAt: expiresAt,
  });

  return token;
};

Auth_model.prototype.verify = async function (token) {
  if (!token) return false;
  const col = await this.collection();
  const doc = await col.findOne({ token: String(token) });
  if (!doc) return false;

  // Mongo's TTL sweep runs about once a minute, so a just-expired token may
  // still be in the collection. Check the date by hand to never accept it.
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return false;

  return doc;
};

// ── APAGAR O TOKEN APAGA O CACHE JUNTO ───────────────────────────────────
//
// A sessão guardada (`lib/sessaoGuardada.js`) vale um minuto. Sem esta linha, um
// token deslogado continuaria autenticando por até sessenta segundos — e é
// justamente para o logout ser IMEDIATO que a chave do cache carrega o token.
//
// Mora aqui, no modelo, e não nos controladores: são seis lugares que derrubam
// token, e um esquecido é uma sessão revogada que continua valendo, em silêncio.
Auth_model.prototype.deleteToken = async function (token) {
  const col = await this.collection();
  await col.deleteOne({ token: String(token) });
  await sessaoGuardada.esquecerToken(String(token));
};

Auth_model.prototype.deleteAllTokensByUser = async function (userId) {
  const col = await this.collection();
  await col.deleteMany({ user: new ObjectId(userId) });
  await sessaoGuardada.esquecerUsuario(userId);
};

module.exports = Auth_model;
