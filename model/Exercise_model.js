const { ObjectId } = require("mongodb");

// Catálogo de exercícios do trainer. Cada trainer monta o seu — não há
// biblioteca de terceiros.
//
//   { trainer, name, nameSort, muscleGroup, videoUrl, thumbUrl, defaultTip }
//
// `muscleGroup` é texto livre ("Peito", "Costas", "Alongamento"…): o filtro da
// tela lista os valores distintos que o próprio trainer cadastrou, então a
// taxonomia nasce do uso em vez de vir engessada.
function Exercise_model(app) {
  this.app = app;
}

// Chave de ordenação e busca: sem espaços nas pontas, minúscula e sem acento.
// O sort binário do Mongo jogaria tudo que começa com maiúscula pra frente, e
// a busca por "gluteo" não acharia "glúteo".
function normalizar(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

Exercise_model.prototype.col = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("exercises");
};

// Grupos musculares em uso, pro dropdown de filtro.
Exercise_model.prototype.groups = async function (trainerId) {
  const col = await this.col();

  const docs = await col
    .aggregate([
      { $match: { trainer: new ObjectId(trainerId), muscleGroup: { $nin: [null, ""] } } },
      { $group: { _id: "$muscleGroup", total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return docs.map((d) => ({ name: d._id, total: d.total }));
};

Exercise_model.prototype.list = async function (trainerId, filtro = {}) {
  const col = await this.col();

  const query = { trainer: new ObjectId(trainerId) };

  if (filtro.busca) {
    // Escapa o termo — sem isso um "(" digitado pelo usuário derruba o regex.
    const termo = normalizar(filtro.busca).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.nameSort = { $regex: termo };
  }

  if (filtro.muscleGroup) query.muscleGroup = String(filtro.muscleGroup);

  const page = Math.max(1, Number(filtro.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(filtro.limit) || 20));

  const total = await col.countDocuments(query);
  const rows = await col
    .find(query)
    .sort({ nameSort: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return { rows, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
};

Exercise_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.col();
  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc || undefined;
};

// Miniatura a partir da URL do vídeo, quando dá pra derivar. YouTube e Vimeo
// cobrem a maioria dos casos; fora isso fica sem imagem.
function thumbnailDoVideo(videoUrl) {
  if (!videoUrl) return null;
  const yt = String(videoUrl).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/
  );
  if (yt) return `https://img.youtube.com/vi/${yt[1]}/mqdefault.jpg`;
  return null;
}

Exercise_model.prototype.insert = async function (trainerId, obj) {
  const col = await this.col();

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
    name: String(obj.name).trim(),
    nameSort: normalizar(obj.name),
    muscleGroup: obj.muscleGroup ? String(obj.muscleGroup).trim() : "",
    videoUrl: obj.videoUrl ? String(obj.videoUrl).trim() : "",
    thumbUrl: thumbnailDoVideo(obj.videoUrl),
    defaultTip: obj.defaultTip ? String(obj.defaultTip).trim() : "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Exercise_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.col();

  const set = { updatedAt: new Date() };
  if (obj.name !== undefined) {
    set.name = String(obj.name).trim();
    set.nameSort = normalizar(obj.name);
  }
  if (obj.muscleGroup !== undefined) set.muscleGroup = String(obj.muscleGroup).trim();
  if (obj.defaultTip !== undefined) set.defaultTip = String(obj.defaultTip).trim();
  if (obj.videoUrl !== undefined) {
    set.videoUrl = String(obj.videoUrl).trim();
    set.thumbUrl = thumbnailDoVideo(obj.videoUrl);
  }

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: set }
  );
  return r.matchedCount > 0;
};

Exercise_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.col();
  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

module.exports = Exercise_model;
