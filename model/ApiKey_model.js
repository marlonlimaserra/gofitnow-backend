const { ObjectId } = require("mongodb");

// A collection `api_keys` — chaves para a pessoa chamar a API fora do app.
//
// O SEGREDO NÃO É GUARDADO. Só o hash dele, do mesmo jeito que uma senha: quem
// puser as mãos no banco não consegue usar as chaves de ninguém. O texto
// completo aparece UMA vez, na criação; depois disso nem o dono recupera — só
// cria outra.
//
// O que fica visível é o `prefix`, a parte da frente da chave. Serve para a
// pessoa reconhecer qual é qual na lista e para o log dizer qual chamou, sem
// nunca mostrar o resto.
function ApiKey_model(app) {
  this.app = app;
}

// gfn_<prefixo>_<segredo>. O rótulo na frente faz um vazamento acidental ser
// reconhecível — um varredor de repositório sabe que "gfn_" é credencial.
//
// Prefixo e segredo são HEX, não base64url. O base64url é mais curto, mas o
// alfabeto dele inclui "_", e aí a própria chave passa a conter o separador:
// quem tentasse separá-la por underscore cortaria o segredo no meio. Com hex o
// formato é sem ambiguidade, e a entropia é a mesma — 32 bytes são 32 bytes.
const PREFIXO = "gfn";
const TAMANHO_PREFIXO = 8;
const TAMANHO_SEGREDO = 32;

// Quantas chaves uma conta pode ter ao mesmo tempo. Existe para um laço com
// defeito não encher a collection.
const MAXIMO_POR_CONTA = 10;

ApiKey_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("api_keys");
};

// SHA-256 sem salt, de propósito, ao contrário da senha.
//
// A busca é POR HASH: a cada requisição a chave recebida é resumida e
// procurada. Com salt por chave seria preciso ler todas e testar uma a uma, o
// que é linear no número de chaves em toda requisição. A troca é segura aqui
// porque o segredo tem 32 bytes aleatórios — não há dicionário nem tabela
// arco-íris que ajude, que é justamente o que o salt protege numa senha humana.
ApiKey_model.prototype.hash = function (key) {
  return this.app.crypto.createHash("sha256").update(String(key)).digest("hex");
};

ApiKey_model.prototype.generate = function () {
  const prefix = this.app.crypto.randomBytes(TAMANHO_PREFIXO).toString("hex").slice(0, TAMANHO_PREFIXO);
  const secret = this.app.crypto.randomBytes(TAMANHO_SEGREDO).toString("hex");
  return { prefix, key: `${PREFIXO}_${prefix}_${secret}` };
};

ApiKey_model.prototype.countActive = async function (userId) {
  const col = await this.collection();
  return col.countDocuments({ user: new ObjectId(userId), revokedAt: null });
};

// Devolve { doc, key } — `key` é o texto completo e é a ÚNICA vez que ele
// existe fora da mão de quem pediu.
ApiKey_model.prototype.create = async function (userId, name) {
  const col = await this.collection();
  const { prefix, key } = this.generate();

  const doc = {
    user: new ObjectId(userId),
    name: String(name || "").trim(),
    prefix,
    hash: this.hash(key),
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };

  const res = await col.insertOne(doc);
  return { doc: { ...doc, _id: res.insertedId }, key };
};

// O que a tela mostra. Nunca o hash: ele não serve para autenticar, mas também
// não tem razão nenhuma para sair daqui.
ApiKey_model.prototype.filter = function (doc) {
  if (!doc) return doc;
  const { hash, ...rest } = doc;
  rest.revoked = !!doc.revokedAt;
  return rest;
};

ApiKey_model.prototype.list = async function (userId) {
  const col = await this.collection();
  const rows = await col
    .find({ user: new ObjectId(userId) })
    .sort({ revokedAt: 1, createdAt: -1 })
    .toArray();
  return rows.map((r) => this.filter(r));
};

ApiKey_model.prototype.data = async function (userId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id), user: new ObjectId(userId) });
  return doc || undefined;
};

// Revogar, não apagar: o histórico de chamadas aponta para a chave, e apagar o
// documento deixaria o log sem dizer quem chamou.
ApiKey_model.prototype.revoke = async function (userId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const res = await col.updateOne(
    { _id: new ObjectId(id), user: new ObjectId(userId), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return res.modifiedCount > 0;
};

// A verificação de cada requisição. Devolve o documento, ou undefined.
ApiKey_model.prototype.verify = async function (key) {
  if (!key || typeof key !== "string") return undefined;
  if (!key.startsWith(PREFIXO + "_")) return undefined;

  const col = await this.collection();
  const doc = await col.findOne({ hash: this.hash(key), revokedAt: null });
  return doc || undefined;
};

// Sem await em quem chama: registrar o uso não pode atrasar a resposta, e
// falhar aqui não invalida a chamada que já foi autenticada.
ApiKey_model.prototype.touch = function (id) {
  this.collection()
    .then((col) => col.updateOne({ _id: new ObjectId(id) }, { $set: { lastUsedAt: new Date() } }))
    .catch(() => {});
};

module.exports = ApiKey_model;
module.exports.MAXIMO_POR_CONTA = MAXIMO_POR_CONTA;
module.exports.PREFIXO = PREFIXO;
