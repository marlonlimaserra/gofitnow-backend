const { ObjectId } = require("mongodb");
const crypto = require("crypto");

// The `password_resets` collection — one-shot tokens for the "forgot my
// password" flow.
//
// Only the token's HASH is stored. A leak of this collection must not let
// anyone reset an account, and the raw token exists solely inside the e-mail.
// Same reasoning as never storing a plain password.
//
// The TTL index on `expiresAt` (see database/schema.js) sweeps old rows.
function PasswordReset_model(app) {
  this.app = app;
}

const VALIDITY_MINUTES = 30;

PasswordReset_model.prototype.validityMinutes = VALIDITY_MINUTES;

PasswordReset_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("password_resets");
};

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Creates a token for the user and returns the RAW value, which only ever
// travels inside the e-mail.
PasswordReset_model.prototype.create = async function (userId) {
  const col = await this.collection();

  // Any earlier request for this user stops working: asking for a new link
  // should invalidate the previous one.
  await col.deleteMany({ user: new ObjectId(userId) });

  const token = crypto.randomBytes(32).toString("hex");

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + VALIDITY_MINUTES);

  await col.insertOne({
    user: new ObjectId(userId),
    tokenHash: hashToken(token),
    expiresAt: expiresAt,
    usedAt: null,
    createdAt: new Date(),
  });

  return token;
};

// Returns the row when the token is valid, undefined otherwise.
PasswordReset_model.prototype.verify = async function (token) {
  if (!token) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ tokenHash: hashToken(token) });
  if (!doc) return undefined;
  if (doc.usedAt) return undefined;

  // Mongo's TTL sweep runs about once a minute, so a just-expired token may
  // still be here. Check the date by hand.
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return undefined;

  return doc;
};

PasswordReset_model.prototype.consume = async function (id) {
  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { usedAt: new Date() } });
};

module.exports = PasswordReset_model;
