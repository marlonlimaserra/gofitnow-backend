const { ObjectId } = require("mongodb");

// O catálogo de exercícios — ÚNICO, no banco central, igual para todo mundo.
//
//   { name, nameSort, muscleGroup, videoUrl, thumbUrl, defaultTip }
//
// Era por profissional (campo `trainer`), e deixou de ser: um agachamento é o
// mesmo agachamento em qualquer instância, e manter mil e quatrocentos
// exercícios copiados por cliente era guardar a mesma informação N vezes para
// depois ter de corrigir N vezes.
//
// CONSEQUÊNCIA que precisa ficar dita: quem edita ou apaga mexe no catálogo de
// TODOS. A permissão `exercises.manage` continua sendo o portão, mas ela agora
// concede muito mais do que concedia — vale revisar quem a tem.
//
// `muscleGroup` é texto livre ("Peito", "Costas", "Alongamento"…): o filtro da
// tela lista os valores realmente em uso, então a taxonomia cresce do uso em vez
// de ser fixada de antemão.
function Exercise_model(app) {
  this.app = app;
}

// Sort and search key: trimmed, lowercased and unaccented. Mongo's binary sort
// would push every capitalized name to the front, and a search for "gluteo"
// would not find "glúteo".
function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

Exercise_model.prototype.collection = async function () {
  // centralDb, e não connectToServer: este catálogo é de fora das instâncias.
  const db = await this.app.mongodb.centralDb();
  return db.collection("exercises");
};

// Muscle groups in use, for the filter dropdown.
Exercise_model.prototype.groups = async function () {
  const col = await this.collection();

  const docs = await col
    .aggregate([
      { $match: { muscleGroup: { $nin: [null, ""] } } },
      { $group: { _id: "$muscleGroup", total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return docs.map((d) => ({ name: d._id, total: d.total }));
};

Exercise_model.prototype.list = async function (filter = {}) {
  const col = await this.collection();

  const query = {};

  if (filter.search) {
    // Search the normalized field: "gluteo" finds "glúteo". The term is escaped
    // — without it a "(" typed by the user breaks the regex.
    const term = normalize(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.nameSort = { $regex: term };
  }

  if (filter.muscleGroup) query.muscleGroup = String(filter.muscleGroup);

  const page = Math.max(1, Number(filter.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(filter.limit) || 20));

  const total = await col.countDocuments(query);
  const rows = await col
    .find(query)
    .sort({ nameSort: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return { rows, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
};

Exercise_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

// Thumbnail derived from the video URL when possible. YouTube covers most
// cases; anything else stays without an image.
function thumbnailFromVideo(videoUrl) {
  if (!videoUrl) return null;
  const yt = String(videoUrl).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/
  );
  return yt ? `https://img.youtube.com/vi/${yt[1]}/mqdefault.jpg` : null;
}

Exercise_model.prototype.insert = async function (obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    name: String(obj.name).trim(),
    nameSort: normalize(obj.name),
    muscleGroup: obj.muscleGroup ? String(obj.muscleGroup).trim() : "",
    videoUrl: obj.videoUrl ? String(obj.videoUrl).trim() : "",
    thumbUrl: thumbnailFromVideo(obj.videoUrl),
    defaultTip: obj.defaultTip ? String(obj.defaultTip).trim() : "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Exercise_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  if (obj.name !== undefined) {
    set.name = String(obj.name).trim();
    set.nameSort = normalize(obj.name);
  }
  if (obj.muscleGroup !== undefined) set.muscleGroup = String(obj.muscleGroup).trim();
  if (obj.defaultTip !== undefined) set.defaultTip = String(obj.defaultTip).trim();
  if (obj.videoUrl !== undefined) {
    set.videoUrl = String(obj.videoUrl).trim();
    set.thumbUrl = thumbnailFromVideo(obj.videoUrl);
  }

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
  return r.matchedCount > 0;
};

Exercise_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

module.exports = Exercise_model;
