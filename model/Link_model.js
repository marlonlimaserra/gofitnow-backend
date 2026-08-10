const { ObjectId } = require("mongodb");

// The `professional_links` collection — who follows whom.
//
// This is the piece that makes a PERSON shared instead of owned. Before it, a
// student had a single `trainer` field, so the same human seen by an
// endocrinologist, a nutritionist and a personal trainer had to exist three
// times, once under each professional. Now the person is one document and each
// professional holds a link to it.
//
// `source` records how the link came to be:
//   "created"   the professional registered this person themselves
//   "request"   the person approved an access request by e-mail
//
// The pair (professional, person) is unique — see database/schema.js — so the
// upsert below can run twice without producing a duplicate.
function Link_model(app) {
  this.app = app;
}

Link_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("professional_links");
};

Link_model.prototype.link = async function (professionalId, personId, source) {
  const col = await this.collection();

  await col.updateOne(
    { professional: new ObjectId(professionalId), person: new ObjectId(personId) },
    {
      $setOnInsert: {
        professional: new ObjectId(professionalId),
        person: new ObjectId(personId),
        source: source || "created",
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  return true;
};

Link_model.prototype.unlink = async function (professionalId, personId) {
  if (!ObjectId.isValid(personId)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
  });

  return r.deletedCount > 0;
};

Link_model.prototype.exists = async function (professionalId, personId) {
  if (!ObjectId.isValid(personId)) return false;
  const col = await this.collection();

  const doc = await col.findOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
  });

  return !!doc;
};

// The ids of everyone this professional follows.
Link_model.prototype.personIdsOf = async function (professionalId) {
  const col = await this.collection();
  const docs = await col.find({ professional: new ObjectId(professionalId) }).toArray();
  return docs.map((d) => d.person);
};

// The other direction: every professional who follows this person. The person
// sees this list to know who is looking at their data.
Link_model.prototype.professionalIdsOf = async function (personId) {
  const col = await this.collection();
  const docs = await col.find({ person: new ObjectId(personId) }).toArray();
  return docs.map((d) => d.professional);
};

Link_model.prototype.countPeopleOf = async function (professionalId) {
  const col = await this.collection();
  return await col.countDocuments({ professional: new ObjectId(professionalId) });
};

Link_model.prototype.countProfessionalsOf = async function (personId) {
  const col = await this.collection();
  return await col.countDocuments({ person: new ObjectId(personId) });
};

// How many people each professional follows, for the whole platform in one
// query — the admin list needs this for every row and one count per row would
// be N queries.
Link_model.prototype.countsByProfessional = async function () {
  const col = await this.collection();

  const rows = await col
    .aggregate([{ $group: { _id: "$professional", total: { $sum: 1 } } }])
    .toArray();

  return new Map(rows.map((r) => [String(r._id), r.total]));
};

// Called when a user is deleted for good: their links would otherwise point at
// an id that no longer exists.
Link_model.prototype.deleteAllOf = async function (userId) {
  const col = await this.collection();
  await col.deleteMany({
    $or: [{ professional: new ObjectId(userId) }, { person: new ObjectId(userId) }],
  });
};

module.exports = Link_model;
