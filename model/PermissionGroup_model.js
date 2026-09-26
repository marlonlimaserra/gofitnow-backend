const { ObjectId } = require("mongodb");
const permissions = require("../lib/permissions.js");

// GRUPOS DE PERMISSÃO — a collection `permission_groups`.
//
// *"crie em Configuração, embaixo de Permissão, um chamado Grupo de permissão;
// aí nesse grupo posso pôr permissões igual faço no usuário, aí posso pôr
// usuários nesse grupo, aí as permissões se somam"* (26/09/2026).
//
// ── O QUE ELE É, E POR QUE NÃO É UM SEGUNDO TIPO DE USUÁRIO ──────────────
//
// O TIPO (`roles`) responde "o que esta pessoa é": recepcionista, professor,
// dono. É um só por pessoa, e por isso ele tende a inchar — basta alguém
// precisar de uma exceção ("esta recepcionista também fecha o caixa") para
// nascer um "Recepcionista 2" quase igual ao primeiro. Daí a três meses são
// seis tipos e ninguém sabe qual difere em quê.
//
// O GRUPO responde "de que mais esta pessoa participa": Caixa, Marketing,
// Plantão do sábado. São VÁRIOS por pessoa, e o que ele dá SOMA ao tipo. A
// exceção passa a ser uma linha a mais numa lista, em vez de uma cópia de um
// tipo inteiro.
//
// ── A SOMA É SÓ UNIÃO, e nunca subtração ─────────────────────────────────
//
// Grupo só ACRESCENTA. Não existe "grupo que tira permissão", e isso é
// deliberado: com soma e subtração juntas, responder "por que fulano não
// consegue abrir o financeiro?" exigiria simular a ordem em que as regras se
// aplicam. Com união pura, a resposta é sempre a mesma pergunta — quem dá? — e
// ela se responde olhando o tipo e os grupos dele.
//
// Quem resolve a soma é `User_model.withRole`, num lugar só, porque é de lá que
// sai o `permissions` que TODA rota lê.
function PermissionGroup_model(app) {
  this.app = app;
}

PermissionGroup_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("permission_groups");
};

PermissionGroup_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}).sort({ name: 1 }).toArray();
};

PermissionGroup_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(String(id || ""))) return null;
  const col = await this.collection();
  return col.findOne({ _id: new ObjectId(String(id)) });
};

PermissionGroup_model.prototype.dataByName = async function (name) {
  const col = await this.collection();
  // Sem diferenciar maiúscula: "Caixa" e "caixa" seriam dois grupos que
  // ninguém distingue na tela.
  return col.findOne({ name: new RegExp("^" + escapar(String(name || "").trim()) + "$", "i") });
};

PermissionGroup_model.prototype.insert = async function (obj) {
  const col = await this.collection();
  const agora = new Date();

  const r = await col.insertOne({
    name: String(obj.name || "").trim(),
    description: String(obj.description || "").trim(),
    // `sanitize` é o mesmo do tipo de usuário: chave que não existe no catálogo
    // não entra. Um grupo com `financeiro.ver` (que não existe) não concederia
    // nada e apareceria na contagem, o que é pior que recusar.
    permissions: permissions.sanitize(obj.permissions),

    // ── AS CONTAS DE FORA ────────────────────────────────────────────────
    //
    // *"amanhã vamos integrar contas de Instagram, Facebook e números de
    // WhatsApp; então no grupo de permissão vamos poder adicionar essas
    // coisas"* (26/09/2026).
    //
    // O campo nasce hoje, VAZIO, e a integração chega amanhã. É de propósito:
    // assim o trabalho de amanhã é ligar o catálogo, e não migrar documento —
    // acrescentar um array a uma collection que já tem grupos salvos é o tipo
    // de mudança que se faz sem pensar e depois aparece como `undefined.map`
    // na tela de alguém.
    //
    // São IDS de contas conectadas, não credenciais. Token de Instagram e
    // número de WhatsApp verificado moram na integração, com o resto do que é
    // segredo; aqui fica só "este grupo alcança aquela conta".
    accounts: contasLimpas(obj.accounts),

    createdAt: agora,
    updatedAt: agora,
  });

  return r.insertedId;
};

PermissionGroup_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(String(id || ""))) return { ok: false };

  const col = await this.collection();
  const set = { updatedAt: new Date() };

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.description !== undefined) set.description = String(obj.description).trim();
  if (obj.permissions !== undefined) set.permissions = permissions.sanitize(obj.permissions);
  if (obj.accounts !== undefined) set.accounts = contasLimpas(obj.accounts);

  await col.updateOne({ _id: new ObjectId(String(id)) }, { $set: set });
  return { ok: true };
};

// Apagar um grupo TIRA ele de quem estava nele, na mesma operação.
//
// Sem isto, os usuários ficariam apontando para um id que não existe mais. Não
// concederia nada — a soma ignora grupo que não carrega —, mas a tela de
// usuário mostraria um grupo fantasma e ninguém saberia de onde veio.
PermissionGroup_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(String(id || ""))) return { ok: false };

  const col = await this.collection();
  const db = await this.app.mongodb.connectToServer();
  const alvo = new ObjectId(String(id));

  await db.collection("users").updateMany({ groups: alvo }, { $pull: { groups: alvo } });
  await col.deleteOne({ _id: alvo });

  return { ok: true };
};

// A UNIÃO das permissões de uma lista de grupos.
//
// Uma consulta só, por mais grupos que a pessoa tenha: é isto que roda em toda
// requisição autenticada, e N idas ao banco por usuário seria um custo fixo em
// tudo.
PermissionGroup_model.prototype.permissoesDe = async function (ids) {
  const validos = (Array.isArray(ids) ? ids : [])
    .filter((id) => ObjectId.isValid(String(id || "")))
    .map((id) => new ObjectId(String(id)));

  if (!validos.length) return [];

  const col = await this.collection();
  const docs = await col.find({ _id: { $in: validos } }).project({ permissions: 1 }).toArray();

  const tudo = new Set();
  for (const doc of docs) for (const p of doc.permissions || []) tudo.add(p);

  // Passa pelo catálogo na saída também: um grupo salvo antes de uma permissão
  // ser aposentada não pode continuar concedendo a chave morta.
  return permissions.sanitize([...tudo]);
};

// Quem está em cada grupo. Em uma consulta, para a lista não fazer N idas.
PermissionGroup_model.prototype.contagemDeUsuarios = async function () {
  const db = await this.app.mongodb.connectToServer();
  const linhas = await db
    .collection("users")
    .aggregate([
      { $match: { groups: { $type: "array", $ne: [] } } },
      { $unwind: "$groups" },
      { $group: { _id: "$groups", quantos: { $sum: 1 } } },
    ])
    .toArray();

  const mapa = {};
  for (const l of linhas) mapa[String(l._id)] = l.quantos;
  return mapa;
};

PermissionGroup_model.prototype.usuariosDe = async function (id) {
  if (!ObjectId.isValid(String(id || ""))) return [];

  const db = await this.app.mongodb.connectToServer();
  return db
    .collection("users")
    .find({ groups: new ObjectId(String(id)) })
    .project({ _id: 1 })
    .toArray();
};

// QUEM ESTÁ NO GRUPO, definido de uma vez.
//
// Recebe a lista inteira e acerta os dois lados: entra quem chegou, sai quem
// não está mais. Um `add`/`remove` por pessoa deixaria a tela ter de calcular a
// diferença — e duas telas abertas ao mesmo tempo produziriam resultados
// diferentes conforme a ordem dos cliques.
PermissionGroup_model.prototype.definirUsuarios = async function (id, userIds) {
  if (!ObjectId.isValid(String(id || ""))) return { ok: false };

  const db = await this.app.mongodb.connectToServer();
  const grupo = new ObjectId(String(id));

  const querem = (Array.isArray(userIds) ? userIds : [])
    .filter((u) => ObjectId.isValid(String(u || "")))
    .map((u) => new ObjectId(String(u)));

  await db
    .collection("users")
    .updateMany({ _id: { $in: querem } }, { $addToSet: { groups: grupo } });

  await db
    .collection("users")
    .updateMany({ groups: grupo, _id: { $nin: querem } }, { $pull: { groups: grupo } });

  return { ok: true, quantos: querem.length };
};

// Só texto, sem repetição e sem vazio. Sem um formato fechado ainda: quem vai
// dizer como uma conta se identifica é a integração de amanhã, e inventar o
// formato antes dela seria decidir no escuro — e depois migrar.
function contasLimpas(lista) {
  if (!Array.isArray(lista)) return [];

  const limpas = lista
    .map((c) => String(c == null ? "" : c).trim())
    .filter(Boolean);

  return [...new Set(limpas)];
}

function escapar(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = PermissionGroup_model;
