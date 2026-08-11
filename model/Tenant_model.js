const { ObjectId } = require("mongodb");

const theme = require("../lib/theme.js");
const domainLib = require("../lib/domain.js");

// A collection `tenants` — o domínio e a aparência de cada profissional.
//
// Um profissional, um domínio. O documento é achado por DUAS chaves diferentes:
// pelo dono (a tela de Aparência) e pelo subdomínio (a tela de login, que ainda
// não sabe quem é ninguém). As duas têm índice.
function Tenant_model(app) {
  this.app = app;
}

Tenant_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("tenants");
};

Tenant_model.prototype.dataByUser = async function (userId) {
  if (!ObjectId.isValid(userId)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ user: new ObjectId(userId) })) || undefined;
};

Tenant_model.prototype.dataBySubdomain = async function (subdomain) {
  const nome = domainLib.normalize(subdomain);
  if (!nome) return undefined;
  const col = await this.collection();
  return (await col.findOne({ subdomain: nome })) || undefined;
};

// Livre = nome válido, não reservado e ainda não tomado por outra conta.
Tenant_model.prototype.isFree = async function (subdomain, exceptUserId) {
  if (!domainLib.isAvailableName(subdomain)) return false;

  const dono = await this.dataBySubdomain(subdomain);
  if (!dono) return true;
  return exceptUserId ? String(dono.user) === String(exceptUserId) : false;
};

// Reserva o nome ANTES de falar com a Cloudflare.
//
// A ordem importa: o índice único no banco é o que impede duas contas pedindo o
// mesmo nome ao mesmo tempo. Checar antes e criar depois perderia a corrida —
// os dois passariam na checagem.
Tenant_model.prototype.claim = async function (userId, subdomain) {
  const nome = domainLib.normalize(subdomain);
  if (!nome || !domainLib.isAvailableName(nome)) return { ok: false, erro: "invalid" };

  const col = await this.collection();
  const agora = new Date();

  try {
    await col.updateOne(
      { user: new ObjectId(userId) },
      {
        $set: { subdomain: nome, status: "pending", updatedAt: agora },
        $setOnInsert: { user: new ObjectId(userId), theme: theme.defaults(), createdAt: agora },
      },
      { upsert: true }
    );
  } catch (error) {
    // 11000 = índice único: o nome é de outra conta.
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  return { ok: true, subdomain: nome, host: domainLib.hostOf(nome) };
};

Tenant_model.prototype.setStatus = async function (userId, status, erro) {
  const col = await this.collection();
  await col.updateOne(
    { user: new ObjectId(userId) },
    { $set: { status, lastError: erro || null, updatedAt: new Date() } }
  );
};

Tenant_model.prototype.saveTheme = async function (userId, entrada) {
  const col = await this.collection();
  const limpo = theme.sanitize(entrada);

  await col.updateOne(
    { user: new ObjectId(userId) },
    {
      $set: { theme: limpo, updatedAt: new Date() },
      $setOnInsert: { user: new ObjectId(userId), status: "none", createdAt: new Date() },
    },
    { upsert: true }
  );

  return limpo;
};

// O que a tela de login recebe, sem sessão nenhuma.
//
// Só aparência: nada de dono, e-mail ou id. Um endereço público não pode
// entregar de quem ele é.
Tenant_model.prototype.publicTheme = function (doc) {
  const t = theme.sanitize(doc?.theme);
  return { theme: t, scale: theme.scale(t.brand) };
};

module.exports = Tenant_model;
