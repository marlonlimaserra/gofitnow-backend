const { ObjectId } = require("mongodb");

// OS BENEFÍCIOS DE UM PLANO — as linhas da tabela de comparação.
//
//   { name, description, order, active }
//
// Pedido do Marlon em 17/09/2026, com a tabela "Compare os benefícios de cada
// plano" da Smart Fit ao lado: *"dentro de planos crie uma aba categoria de
// plano, pode colar essas coisas ai de sim ou nao"* — e, logo depois, *"troque
// o nome categorias para beneficios"*.
//
// A segunda palavra é a certa, e é a que a própria tabela usa. A troca foi até o
// fim (collection, campo, rota) e não só no rótulo: nome na tela diferente do
// nome no código é o que diverge na primeira mudança seguinte.
//
// "Check-in ilimitado na unidade", "Acesso a aulas coletivas", "Uso das cadeiras
// de massagem" — cada uma é uma LINHA, e cada plano responde sim ou não.
//
// ── POR QUE UM CATÁLOGO, e não texto livre em cada plano ─────────────────
//
// A primeira versão do plano tinha `beneficios: ["texto", "texto"]`, digitados
// um a um. Funciona para desenhar o cartão e não desenha a TABELA: para
// comparar, os três planos precisam falar da MESMA linha — e "Acesso a aulas
// coletivas" num, "Aulas coletivas" no outro viram duas linhas que ninguém
// consegue alinhar.
//
// Com o catálogo, o cartão mostra o que o plano tem e a tabela mostra todos
// contra todos, das mesmas linhas. Uma fonte, duas telas.
//
// ── E "NÃO" É AUSÊNCIA ───────────────────────────────────────────────────
//
// O plano guarda a lista do que TEM. O que não está lá sai com o "×" cinza.
// Guardar os dois — uma lista de sim e outra de não — criaria o terceiro estado
// que ninguém pediu: a categoria que o plano não respondeu, que a tabela não
// saberia desenhar.
function MembershipBenefit_model(app) {
  this.app = app;
}

MembershipBenefit_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("membership_benefits");
};

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 120),
  // A explicação que vai no "?" ao lado da linha, quando a linha não se explica
  // sozinha. Opcional de propósito: a maioria delas se explica.
  description: (v) => String(v || "").trim().slice(0, 300),
  active: (v) => v !== false,
};

MembershipBenefit_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}).sort({ order: 1, createdAt: 1 }).toArray();
};

MembershipBenefit_model.prototype.listActive = async function () {
  const col = await this.collection();
  return col.find({ active: true }).sort({ order: 1, createdAt: 1 }).toArray();
};

MembershipBenefit_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

MembershipBenefit_model.prototype.insert = async function (obj) {
  const col = await this.collection();

  const doc = {
    // No fim da lista: a ORDEM é a das linhas da tabela, e quem cadastra uma
    // linha nova não a quer no meio das que já estavam ali.
    order: await col.countDocuments({}),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  for (const [campo, limpar] of Object.entries(CAMPOS)) doc[campo] = limpar(obj[campo]);
  if (!doc.name) return null;

  const r = await col.insertOne(doc);
  return r.insertedId;
};

MembershipBenefit_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  return r.matchedCount > 0;
};

// ── APAGAR UMA LINHA QUE ALGUM PLANO MARCOU É RECUSADO ───────────────────
//
// Apagar mudaria calado o que três planos oferecem, e quem apagou não veria
// nenhum deles. O erro diz QUANTOS planos a marcaram — é o número que faz a
// pessoa entender o que ia acontecer.
//
// Quem quer tirar a linha da tabela sem mexer em plano nenhum DESATIVA: ela some
// da comparação e do cartão, e volta inteira se for religada.
MembershipBenefit_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return { erro: "notFound" };

  const col = await this.collection();
  const alvo = await col.findOne({ _id: new ObjectId(id) });
  if (!alvo) return { erro: "notFound" };

  const planos = await (await this.app.api.membership.collection()).countDocuments({
    beneficios: new ObjectId(id),
  });
  if (planos > 0) return { erro: "inUse", quantos: planos };

  await col.deleteOne({ _id: new ObjectId(id) });
  return { ok: true };
};

// A ordem das LINHAS da tabela. Escolhida, e não alfabética: "Check-in
// ilimitado" vem antes de "Cadeira de massagem" porque é o que mais importa, e
// não porque começa com C.
MembershipBenefit_model.prototype.reorder = async function (ids) {
  if (!Array.isArray(ids)) return false;
  const col = await this.collection();

  const validos = ids.filter((id) => ObjectId.isValid(id));
  if (!validos.length) return false;

  await Promise.all(
    validos.map((id, i) =>
      col.updateOne({ _id: new ObjectId(id) }, { $set: { order: i, updatedAt: new Date() } })
    )
  );

  return true;
};

module.exports = MembershipBenefit_model;
