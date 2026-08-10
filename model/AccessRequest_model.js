const { ObjectId } = require("mongodb");
const crypto = require("crypto");

// The `access_requests` collection — a professional asking a person who
// already has an account for permission to follow them.
//
// Nobody gains access by being asked. The link is only created when the person
// clicks the link in their own inbox, which is what makes the consent real
// rather than assumed.
//
// Only the token's HASH is stored, same reasoning as PasswordReset_model: a
// leak of this collection must not let anyone approve access on someone
// else's behalf.
//
// `expiresAt` is REMOVED once the request is answered — the TTL index in
// database/schema.js only sweeps documents that still carry the field, so the
// history of what was approved or denied survives.
function AccessRequest_model(app) {
  this.app = app;
}

const VALIDITY_DAYS = 7;

AccessRequest_model.prototype.validityDays = VALIDITY_DAYS;

AccessRequest_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("access_requests");
};

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Creates a request and returns the RAW token, which only ever travels inside
// the e-mail.
AccessRequest_model.prototype.create = async function (professionalId, personId) {
  const col = await this.collection();

  // Asking again replaces the previous pending request, so the person never
  // has two live links for the same professional.
  await col.deleteMany({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
    status: "pending",
  });

  const token = crypto.randomBytes(32).toString("hex");

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + VALIDITY_DAYS);

  await col.insertOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
    tokenHash: hashToken(token),
    status: "pending",
    expiresAt: expiresAt,
    createdAt: new Date(),
    respondedAt: null,
  });

  return token;
};

// Returns the row when the token is still answerable, undefined otherwise.
AccessRequest_model.prototype.verify = async function (token) {
  if (!token) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ tokenHash: hashToken(token) });
  if (!doc) return undefined;
  if (doc.status !== "pending") return undefined;

  // Mongo's TTL sweep runs about once a minute, so a just-expired request may
  // still be here. Check the date by hand.
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return undefined;

  return doc;
};

// Answering drops `expiresAt` so the TTL stops looking at this document.
AccessRequest_model.prototype.respond = async function (id, status) {
  const col = await this.collection();

  await col.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: { status: status, respondedAt: new Date() },
      $unset: { expiresAt: "" },
    }
  );
};

AccessRequest_model.prototype.pendingBetween = async function (professionalId, personId) {
  const col = await this.collection();

  const doc = await col.findOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
    status: "pending",
  });

  if (!doc) return undefined;
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return undefined;

  return doc;
};

// Everything this professional is still waiting on, newest first. The people
// list shows these so a request does not vanish after it is sent.
AccessRequest_model.prototype.listPendingOf = async function (professionalId) {
  const col = await this.collection();

  const docs = await col
    .find({ professional: new ObjectId(professionalId), status: "pending" })
    .sort({ createdAt: -1 })
    .toArray();

  return docs.filter((d) => !d.expiresAt || d.expiresAt.getTime() >= Date.now());
};

AccessRequest_model.prototype.cancel = async function (professionalId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({
    _id: new ObjectId(id),
    professional: new ObjectId(professionalId),
    status: "pending",
  });

  return r.deletedCount > 0;
};

module.exports = AccessRequest_model;
