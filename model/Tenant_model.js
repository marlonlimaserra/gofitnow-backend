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

Tenant_model.prototype.dataByCustomDomain = async function (host) {
  const nome = domainLib.normalizeDomain(host);
  if (!nome) return undefined;
  const col = await this.collection();
  return (await col.findOne({ customDomain: nome })) || undefined;
};

// O caminho que a tela de login usa: um host, dois jeitos de ser de alguém.
//
// O subdomínio vem primeiro porque é o mais barato de descartar — `subdomainOf`
// já devolve null para tudo que não é nosso, sem ir ao banco.
Tenant_model.prototype.dataByHost = async function (host) {
  const sub = domainLib.subdomainOf(host);
  if (sub) return this.dataBySubdomain(sub);
  return this.dataByCustomDomain(host);
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

// ── Domínio próprio ─────────────────────────────────────────────────────────
//
// Campo separado do subdomínio, com status separado. Não é capricho: os dois
// endereços podem existir ao mesmo tempo e falham por motivos diferentes — o
// subdomínio espera credencial nossa, o domínio próprio espera o DNS DELE.

Tenant_model.prototype.isDomainFree = async function (host, exceptUserId) {
  if (!domainLib.isUsableDomain(host)) return false;

  const dono = await this.dataByCustomDomain(host);
  if (!dono) return true;
  return exceptUserId ? String(dono.user) === String(exceptUserId) : false;
};

// Mesma ordem do subdomínio: grava primeiro, fala com a Cloudflare depois. O
// índice único é quem decide a corrida entre duas contas pedindo o mesmo host.
Tenant_model.prototype.claimCustomDomain = async function (userId, host) {
  const nome = domainLib.normalizeDomain(host);
  if (!nome || !domainLib.isUsableDomain(nome)) return { ok: false, erro: "invalid" };

  const col = await this.collection();
  const agora = new Date();

  try {
    await col.updateOne(
      { user: new ObjectId(userId) },
      {
        $set: { customDomain: nome, customStatus: "pending", customError: null, updatedAt: agora },
        $setOnInsert: { user: new ObjectId(userId), theme: theme.defaults(), createdAt: agora },
      },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  return { ok: true, customDomain: nome };
};

Tenant_model.prototype.setCustomStatus = async function (userId, status, erro) {
  const col = await this.collection();
  await col.updateOne(
    { user: new ObjectId(userId) },
    { $set: { customStatus: status, customError: erro || null, updatedAt: new Date() } }
  );
};

// Sai o campo inteiro, não vira string vazia: o índice único é parcial por
// `$type: "string"`, e um "" guardado seria um valor que duas contas disputariam.
Tenant_model.prototype.removeCustomDomain = async function (userId) {
  const col = await this.collection();
  await col.updateOne(
    { user: new ObjectId(userId) },
    { $unset: { customDomain: "", customStatus: "", customError: "" }, $set: { updatedAt: new Date() } }
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
