const { ObjectId } = require("mongodb");

// The `users` collection — every person in the system.
//
//   type: "trainer"  → creates and sees their own students
//   type: "student"  → has `trainer` pointing to the owner; only sees themself
//
// `admin` is a flag SEPARATE from type: it marks whoever administers the
// platform (registering trainers). An admin is usually also a trainer, so both
// live on the same document instead of becoming a third type.
//
// Profile fields (weight, height, goal…) only make sense on a student, but
// they sit on the same document — a separate collection would not pay off.
//
// `password`/`salt` stay null while a student has no access yet: the trainer
// can register the profile before granting a login.
function User_model(app) {
  this.app = app;
}

const TYPES = ["trainer", "student"];

User_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("users");
};

// SHA-512 with a per-user salt. The salt is drawn at signup and stored next to
// the document — without it, two identical passwords would hash the same.
User_model.prototype.generateSalt = function () {
  return this.app.crypto.randomBytes(16).toString("hex");
};

User_model.prototype.hashPassword = function (password, salt) {
  return this.app.crypto
    .createHash("sha512")
    .update(salt + ":" + password)
    .digest("base64");
};

// Never let password/salt leave the backend. `hasAccess` tells the screen what
// it needs to know (whether the student can log in) without exposing the hash.
User_model.prototype.filter = function (doc) {
  if (!doc) return doc;
  const { password, salt, ...rest } = doc;
  rest.hasAccess = !!password;
  return rest;
};

// An empty e-mail is stored as an ABSENT field, not as "". The unique index is
// partial (only where `email` exists), so two students without an e-mail can
// coexist, while two with "" would collide.
function normalizeEmail(email) {
  const v = String(email == null ? "" : email)
    .trim()
    .toLowerCase();
  return v === "" ? null : v;
}

User_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

User_model.prototype.dataByEmail = async function (email) {
  const e = normalizeEmail(email);
  if (!e) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ email: e });
  return doc || undefined;
};

// ── Trainers (the "clients" from the admin's point of view) ──────────────

User_model.prototype.insertTrainer = async function (obj) {
  const col = await this.collection();
  const salt = this.generateSalt();

  const r = await col.insertOne({
    name: String(obj.name).trim(),
    email: normalizeEmail(obj.email),
    password: this.hashPassword(obj.password, salt),
    salt: salt,
    type: "trainer",
    // `admin` never comes from self-signup: only an admin grants admin.
    admin: obj.admin === true,
    phone: obj.phone ? String(obj.phone).trim() : "",
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// Lists trainers — the admin view. Brings each one's student count along,
// which is what the screen shows.
User_model.prototype.listTrainers = async function (filter) {
  const col = await this.collection();

  const query = { type: "trainer" };

  if (filter && filter.search) {
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
    ];
  }

  if (filter && filter.active !== undefined && filter.active !== "") {
    query.active = Number(filter.active) ? 1 : 0;
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  // A single aggregation for every trainer, instead of one countDocuments per
  // row — that would be N queries for a list of N.
  const counts = await col
    .aggregate([{ $match: { type: "student" } }, { $group: { _id: "$trainer", total: { $sum: 1 } } }])
    .toArray();

  const byTrainer = new Map(counts.map((c) => [String(c._id), c.total]));

  return docs.map((d) => ({
    ...this.filter(d),
    totalStudents: byTrainer.get(String(d._id)) || 0,
  }));
};

User_model.prototype.dataTrainer = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id), type: "trainer" });
  return doc || undefined;
};

User_model.prototype.updateTrainer = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();
  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;
  if (obj.admin !== undefined) set.admin = obj.admin === true || obj.admin === 1;

  if (obj.email !== undefined) {
    const e = normalizeEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.password) {
    set.salt = this.generateSalt();
    set.password = this.hashPassword(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  const r = await col.updateOne({ _id: new ObjectId(id), type: "trainer" }, update);
  return r.matchedCount > 0;
};

User_model.prototype.deleteTrainer = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), type: "trainer" });
  return r.deletedCount > 0;
};

User_model.prototype.countStudentsOfTrainer = async function (trainerId) {
  const col = await this.collection();
  return await col.countDocuments({ type: "student", trainer: new ObjectId(trainerId) });
};

// How many ACTIVE admins exist. Used to stop the last admin from demoting or
// deleting themself and leaving nobody able to open the Clients menu.
User_model.prototype.countAdmins = async function () {
  const col = await this.collection();
  return await col.countDocuments({ admin: true, active: 1 });
};

// ── Students (always scoped to a trainer) ────────────────────────────────

User_model.prototype.listStudents = async function (trainerId, filter) {
  const col = await this.collection();

  const query = { type: "student", trainer: new ObjectId(trainerId) };

  if (filter && filter.search) {
    // Escape the term — without this a "(" typed by the user breaks the regex.
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
    ];
  }

  if (filter && filter.active !== undefined && filter.active !== "") {
    query.active = Number(filter.active) ? 1 : 0;
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();
  return docs.map((d) => this.filter(d));
};

User_model.prototype.dataStudent = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({
    _id: new ObjectId(id),
    type: "student",
    trainer: new ObjectId(trainerId),
  });
  return doc || undefined;
};

User_model.prototype.insertStudent = async function (trainerId, obj) {
  const col = await this.collection();

  const doc = {
    name: String(obj.name).trim(),
    email: normalizeEmail(obj.email),
    password: null,
    salt: null,
    type: "student",
    trainer: new ObjectId(trainerId),
    phone: obj.phone ? String(obj.phone).trim() : "",
    birthDate: obj.birthDate ? String(obj.birthDate) : "",
    goal: obj.goal ? String(obj.goal).trim() : "",
    weight: obj.weight !== undefined && obj.weight !== "" ? Number(obj.weight) : null,
    height: obj.height !== undefined && obj.height !== "" ? Number(obj.height) : null,
    notes: obj.notes ? String(obj.notes).trim() : "",
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // The password is optional at signup: without it the student exists as a
  // profile but cannot log in yet.
  if (obj.password) {
    doc.salt = this.generateSalt();
    doc.password = this.hashPassword(obj.password, doc.salt);
  }

  const r = await col.insertOne(doc);
  return r.insertedId;
};

User_model.prototype.updateStudent = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();
  if (obj.birthDate !== undefined) set.birthDate = String(obj.birthDate);
  if (obj.goal !== undefined) set.goal = String(obj.goal).trim();
  if (obj.notes !== undefined) set.notes = String(obj.notes).trim();
  if (obj.weight !== undefined) set.weight = obj.weight === "" ? null : Number(obj.weight);
  if (obj.height !== undefined) set.height = obj.height === "" ? null : Number(obj.height);
  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;

  if (obj.email !== undefined) {
    const e = normalizeEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.password) {
    set.salt = this.generateSalt();
    set.password = this.hashPassword(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  const r = await col.updateOne(
    { _id: new ObjectId(id), type: "student", trainer: new ObjectId(trainerId) },
    update
  );

  return r.matchedCount > 0;
};

User_model.prototype.deleteStudent = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({
    _id: new ObjectId(id),
    type: "student",
    trainer: new ObjectId(trainerId),
  });
  return r.deletedCount > 0;
};

// Revokes the student's login without deleting the profile.
User_model.prototype.revokeStudentAccess = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id), type: "student", trainer: new ObjectId(trainerId) },
    { $set: { password: null, salt: null, updatedAt: new Date() } }
  );
  return r.matchedCount > 0;
};

// ── Common to both types ─────────────────────────────────────────────────

// Updates the user's own account data (name/email) or password.
User_model.prototype.updateSelf = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();

  if (obj.email !== undefined) {
    const e = normalizeEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.password) {
    set.salt = this.generateSalt();
    set.password = this.hashPassword(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  await col.updateOne({ _id: new ObjectId(id) }, update);
  return true;
};

// Checks e-mail + password. Returns the raw document (with the hash) or
// undefined.
User_model.prototype.authenticate = async function (email, password) {
  const user = await this.dataByEmail(email);
  if (!user) return undefined;
  if (user.active === 0) return undefined;

  // Student registered as a profile, with no access granted yet.
  if (!user.password || !user.salt) return undefined;

  if (this.hashPassword(password, user.salt) !== user.password) return undefined;

  return user;
};

// Numbers for the trainer's dashboard.
User_model.prototype.studentsSummary = async function (trainerId) {
  const col = await this.collection();
  const base = { type: "student", trainer: new ObjectId(trainerId) };

  const total = await col.countDocuments(base);
  const active = await col.countDocuments({ ...base, active: 1 });
  const withAccess = await col.countDocuments({ ...base, password: { $ne: null } });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const newThisMonth = await col.countDocuments({ ...base, createdAt: { $gte: monthStart } });

  return { total, active, inactive: total - active, withAccess, newThisMonth };
};

// Platform-wide numbers — admin only.
User_model.prototype.platformSummary = async function () {
  const col = await this.collection();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  return {
    trainers: await col.countDocuments({ type: "trainer" }),
    activeTrainers: await col.countDocuments({ type: "trainer", active: 1 }),
    students: await col.countDocuments({ type: "student" }),
    admins: await col.countDocuments({ admin: true, active: 1 }),
    newThisMonth: await col.countDocuments({ createdAt: { $gte: monthStart } }),
  };
};

module.exports = User_model;
module.exports.TYPES = TYPES;
