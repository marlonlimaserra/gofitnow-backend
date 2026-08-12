const instanceContext = require("../lib/instance.js");

// A collection `instances`, no banco do PAINEL (`gofitnow_center`) — o registro
// dos clientes.
//
// É a única coisa que sabe que existe mais de um cliente. Cada documento é uma
// instância: o nome (que vira o nome do banco), o e-mail de quem a tem, e os
// endereços por onde ela é aberta.
//
// Daqui ela é só LIDA. Quem escreve e indexa é o painel do center; este backend
// a consulta para descobrir de quem é um host antes de existir sessão.
//
// Os ENDEREÇOS moram aqui, e não no `tenants` de dentro da instância, por uma
// razão de ordem: a tela de login é resolvida por host ANTES de existir sessão,
// então nesse instante ainda não se sabe qual banco abrir. Só um registro
// central pode responder "de quem é este endereço". E é aqui que o índice único
// de host faz sentido: dois clientes não podem disputar o mesmo endereço, e um
// índice dentro de cada banco não veria o outro.
function Center_model(app) {
  this.app = app;
}

Center_model.prototype.collection = async function () {
  // centralDb, não connectToServer: esta collection é do compartilhado, não de
  // uma instância.
  const db = await this.app.mongodb.centralDb();
  return db.collection("instances");
};

Center_model.prototype.byInstance = async function (instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return undefined;
  const col = await this.collection();
  return (await col.findOne({ instance: nome })) || undefined;
};

Center_model.prototype.byEmail = async function (email) {
  const limpo = String(email || "").trim().toLowerCase();
  if (!limpo) return undefined;
  const col = await this.collection();
  return (await col.findOne({ email: limpo })) || undefined;
};

// De quem é este endereço. É o que a tela de login pergunta antes de qualquer
// sessão.
Center_model.prototype.byHost = async function (host) {
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!limpo) return undefined;
  const col = await this.collection();
  return (await col.findOne({ hosts: limpo })) || undefined;
};

Center_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}, { projection: { instance: 1, email: 1, name: 1, active: 1, hosts: 1 } })
    .sort({ instance: 1 })
    .toArray();
};

// Cria a instância se ela não existe, e não mexe se existe.
//
// Idempotente de propósito: roda no boot, e um segundo boot não pode
// sobrescrever o e-mail nem os endereços de quem já está lá.
Center_model.prototype.ensure = async function ({ instance, email, name }) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return { ok: false, erro: "invalid_instance" };

  const col = await this.collection();
  const agora = new Date();

  try {
    await col.updateOne(
      { instance: nome },
      {
        $setOnInsert: {
          instance: nome,
          email: String(email || "").trim().toLowerCase(),
          name: name || nome,
          hosts: [],
          active: true,
          createdAt: agora,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    // 11000 = índice único: o e-mail já é de outra instância.
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  return { ok: true, instance: nome };
};

// Registra um endereço numa instância. Falha quando o endereço já é de outra —
// é o índice único que decide, não uma checagem antes.
Center_model.prototype.addHost = async function (instance, host) {
  const nome = instanceContext.normalize(instance);
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!nome || !limpo) return { ok: false, erro: "invalid" };

  const col = await this.collection();
  try {
    const r = await col.updateOne(
      { instance: nome },
      { $addToSet: { hosts: limpo }, $set: { updatedAt: new Date() } }
    );
    if (r.matchedCount === 0) return { ok: false, erro: "no_instance" };
  } catch (error) {
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  return { ok: true, host: limpo };
};

Center_model.prototype.removeHost = async function (instance, host) {
  const nome = instanceContext.normalize(instance);
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!nome || !limpo) return false;

  const col = await this.collection();
  const r = await col.updateOne({ instance: nome }, { $pull: { hosts: limpo } });
  return r.modifiedCount > 0;
};

module.exports = Center_model;
