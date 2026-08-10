const { ObjectId } = require("mongodb");

// The `workout_presets` collection — the professional's own "auto preencher"
// options for a new workout.
//
// Each preset belongs to ONE professional. They are shortcuts for whoever
// wrote them, not a shared catalog: a personal trainer's "Hipertrofia 4
// semanas" means nothing on a nutritionist's screen.
//
// The stored fields are exactly the ones a preset can fill. Dates are NOT
// among them: a period only makes sense per workout, and a preset carrying
// "01/08 a 30/09" would be wrong the day after it was created. The teacher is
// left out too — that already defaults to whoever is signed in.
function WorkoutPreset_model(app) {
  this.app = app;
}

WorkoutPreset_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("workout_presets");
};

function clean(obj) {
  return {
    name: String(obj.name || "").trim(),
    goal: String(obj.goal || "").trim(),
    tip: String(obj.tip || "").trim(),
    calories: obj.calories !== undefined && obj.calories !== "" ? Number(obj.calories) : null,
    totalSessions:
      obj.totalSessions !== undefined && obj.totalSessions !== ""
        ? Number(obj.totalSessions)
        : null,
  };
}

WorkoutPreset_model.prototype.list = async function (professionalId) {
  const col = await this.collection();
  return await col
    .find({ professional: new ObjectId(professionalId) })
    .sort({ name: 1 })
    .toArray();
};

WorkoutPreset_model.prototype.data = async function (professionalId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({
    _id: new ObjectId(id),
    professional: new ObjectId(professionalId),
  });

  return doc || undefined;
};

WorkoutPreset_model.prototype.insert = async function (professionalId, obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    professional: new ObjectId(professionalId),
    ...clean(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

WorkoutPreset_model.prototype.update = async function (professionalId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  // The owner is part of the QUERY, never of the update: that is what stops
  // one professional from editing another's preset by guessing an id.
  const r = await col.updateOne(
    { _id: new ObjectId(id), professional: new ObjectId(professionalId) },
    { $set: { ...clean(obj), updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

WorkoutPreset_model.prototype.delete = async function (professionalId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({
    _id: new ObjectId(id),
    professional: new ObjectId(professionalId),
  });

  return r.deletedCount > 0;
};

module.exports = WorkoutPreset_model;
