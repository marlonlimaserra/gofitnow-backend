const { ObjectId } = require("mongodb");

// The trainer's exercise catalog. Each trainer builds their own — there is no
// third-party library.
//
//   { trainer, name, nameSort, muscleGroup, videoUrl, thumbUrl, defaultTip }
//
// `muscleGroup` is free text ("Chest", "Back", "Stretching"…): the screen's
// filter lists the distinct values the trainer has actually used, so the
// taxonomy grows from usage instead of being fixed up front.
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
  const db = await this.app.mongodb.connectToServer();
  return db.collection("exercises");
};

// Muscle groups in use, for the filter dropdown.
Exercise_model.prototype.groups = async function (trainerId) {
  const col = await this.collection();

  const docs = await col
    .aggregate([
      { $match: { trainer: new ObjectId(trainerId), muscleGroup: { $nin: [null, ""] } } },
      { $group: { _id: "$muscleGroup", total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return docs.map((d) => ({ name: d._id, total: d.total }));
};

Exercise_model.prototype.list = async function (trainerId, filter = {}) {
  const col = await this.collection();

  const query = { trainer: new ObjectId(trainerId) };

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

Exercise_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc || undefined;
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

Exercise_model.prototype.insert = async function (trainerId, obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
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

Exercise_model.prototype.update = async function (trainerId, id, obj) {
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

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: set }
  );
  return r.matchedCount > 0;
};

Exercise_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

module.exports = Exercise_model;
