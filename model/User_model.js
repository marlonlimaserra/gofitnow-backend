const { ObjectId } = require("mongodb");
const permissionCatalog = require("../lib/permissions.js");

// The `users` collection — every person in the system.
//
//   type: "trainer"  → a professional: follows people and manages their plans
//   type: "student"  → a person being followed
//
// A person is NOT owned by one professional. Who follows whom lives in
// `professional_links` (see Link_model), so the same person can be followed by
// an endocrinologist, a nutritionist and a personal trainer at once, each
// seeing the same record. `createdBy` only says who first registered the
// profile — it grants nothing on its own.
//
// `role` points at a document in `roles` and is what decides everything the
// user may DO. Several users share a role, and a role can be created on the
// Tipos de usuário screen — that is what makes a second admin-equivalent type
// possible without touching code.
//
// `admin: true` is the one exception: a MASTER SWITCH that grants every
// permission that exists, re-evaluated on each request. A permission shipped
// next month is already granted, so an owner can never be locked out of a
// screen they have not heard of yet. No role can express that — a role stores
// a fixed list, and a list written today cannot contain tomorrow's keys.
//
// Profile fields (weight, height, goal…) only make sense on a person being
// followed, but they sit on the same document — a separate collection would
// not pay off.
//
// `password`/`salt` stay null while a person has no access yet: a professional
// can register the profile before there is a login.
function User_model(app) {
  this.app = app;
}

const TYPES = ["trainer", "student"];

// Sexo biologico, que e o que entra em IMC e gasto calorico. Vazio significa
// nao informado — e como ficam as fichas cadastradas antes deste campo existir.
const SEXES = ["female", "male"];

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
// it needs to know (whether the person can log in) without exposing the hash.
User_model.prototype.filter = function (doc) {
  if (!doc) return doc;
  const { password, salt, ...rest } = doc;
  rest.hasAccess = !!password;
  return rest;
};

// The same document plus the role it points at, resolved into a name and a
// flat list of permission keys. This is what the frontend needs to decide
// which menus exist, and what every route guard reads.
User_model.prototype.withRole = async function (doc) {
  if (!doc) return doc;

  const user = this.filter(doc);
  const role = doc.role ? await this.app.api.role.data(doc.role) : undefined;

  user.roleName = role ? role.name : "";
  user.admin = doc.admin === true;

  // The master switch is read from the catalog, not from a stored list, so it
  // covers permissions that did not exist when the account was created.
  // Without it, no role means NO permissions — never "everything": a user
  // whose role was deleted must lose access, not inherit it.
  user.permissions = user.admin ? [...permissionCatalog.ALL] : role ? role.permissions || [] : [];

  return user;
};

// What a user may do, master switch included. Used by the guards that need to
// know whether somebody holds a permission WITHOUT loading a full session.
User_model.prototype.hasPermission = async function (doc, permission) {
  if (!doc) return false;
  if (doc.admin === true) return true;
  return await this.app.api.role.grants(doc.role, permission);
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
    // Neither the role nor the master switch comes from self-signup: the
    // controller resolves them, so a crafted request cannot ask to be created
    // as an administrator.
    role: obj.role ? new ObjectId(obj.role) : null,
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

  // One aggregation over the links for the whole platform, instead of one
  // count per row — that would be N queries for a list of N.
  const byProfessional = await this.app.api.link.countsByProfessional();
  const roleNames = await this.roleNameMap();

  return docs.map((d) => ({
    ...this.filter(d),
    roleName: roleNames.get(String(d.role)) || "",
    totalStudents: byProfessional.get(String(d._id)) || 0,
  }));
};

// id → name for every role, in one read. Lists show the type on each row and
// looking it up per row would be a query per line.
User_model.prototype.roleNameMap = async function () {
  const col = await (await this.app.mongodb.connectToServer()).collection("roles");
  const docs = await col.find({}).project({ name: 1 }).toArray();
  return new Map(docs.map((d) => [String(d._id), d.name]));
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
  if (obj.role !== undefined && ObjectId.isValid(obj.role)) set.role = new ObjectId(obj.role);
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
  return await this.app.api.link.countPeopleOf(trainerId);
};

// How many ACTIVE accounts can still hand permissions out. Used to stop the
// last one from demoting or deleting themself and leaving the platform with
// no way back into the permission screens.
User_model.prototype.countAdmins = async function (ignoreUserId) {
  return await this.app.api.role.countActiveUsersWith("roles.manage", ignoreUserId);
};

// ── People a professional follows (always scoped through the links) ──────

// The professional never sees a person they are not linked to, and the id list
// comes from the links — never from the request.
User_model.prototype.listStudents = async function (trainerId, filter) {
  const col = await this.collection();

  const ids = await this.app.api.link.personIdsOf(trainerId);
  if (ids.length === 0) return [];

  const query = { _id: { $in: ids } };

  if (filter && filter.search) {
    // Escape the term — without this a "(" typed by the user breaks the regex.
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
    ];
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  // Observação e status vêm do VÍNCULO: cada profissional vê os seus, nunca os
  // de outro. O `active` do vínculo sobrescreve o da conta de propósito — na
  // lista de quem acompanha, "ativo" quer dizer ativo AQUI.
  const notes = await this.app.api.link.notesMap(trainerId);
  const active = await this.app.api.link.activeMap(trainerId);

  const rows = docs.map((d) => ({
    ...this.filter(d),
    notes: notes.get(String(d._id)) || "",
    active: active.get(String(d._id)) ?? 1,
  }));

  // O filtro é aplicado depois porque o valor está no vínculo, não na consulta
  // que trouxe as pessoas.
  if (filter && filter.active !== undefined && filter.active !== "") {
    const wanted = Number(filter.active) ? 1 : 0;
    return rows.filter((r) => r.active === wanted);
  }

  return rows;
};

User_model.prototype.dataStudent = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;

  // The link IS the permission check: no link, no access, even if the id is
  // real and the caller knows it.
  if (!(await this.app.api.link.exists(trainerId, id))) return undefined;

  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
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
    role: obj.role ? new ObjectId(obj.role) : null,
    // Who first registered the profile. It does NOT grant access — the link
    // does — but it is what lets that professional still manage the login of
    // someone who never signed up on their own.
    createdBy: new ObjectId(trainerId),
    phone: obj.phone ? String(obj.phone).trim() : "",
    birthDate: obj.birthDate ? String(obj.birthDate) : "",
    sex: SEXES.includes(String(obj.sex)) ? String(obj.sex) : "",
    goal: obj.goal ? String(obj.goal).trim() : "",
    weight: obj.weight !== undefined && obj.weight !== "" ? Number(obj.weight) : null,
    height: obj.height !== undefined && obj.height !== "" ? Number(obj.height) : null,
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

  // Registering someone already puts them on your list.
  await this.app.api.link.link(trainerId, r.insertedId, "created");

  return r.insertedId;
};

User_model.prototype.updateStudent = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  if (!(await this.app.api.link.exists(trainerId, id))) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();
  if (obj.birthDate !== undefined) set.birthDate = String(obj.birthDate);
  if (obj.sex !== undefined) set.sex = SEXES.includes(String(obj.sex)) ? String(obj.sex) : "";
  if (obj.goal !== undefined) set.goal = String(obj.goal).trim();
  if (obj.weight !== undefined) set.weight = obj.weight === "" ? null : Number(obj.weight);
  if (obj.height !== undefined) set.height = obj.height === "" ? null : Number(obj.height);
  // `active` NÃO entra aqui: na visão do profissional ele quer dizer "ativo na
  // minha lista" e mora no vínculo. O da conta é do admin, em Usuários.

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

  const r = await col.updateOne({ _id: new ObjectId(id) }, update);

  return r.matchedCount > 0;
};

// Takes the person off this professional's list. The person keeps existing,
// along with every other professional who follows them.
User_model.prototype.unlinkStudent = async function (trainerId, id) {
  return await this.app.api.link.unlink(trainerId, id);
};

// Erases the person for good. Only ever called for a profile nobody else
// follows and that never became a real account — see controllers/Student.js.
User_model.prototype.deleteStudent = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  if (!(await this.app.api.link.exists(trainerId, id))) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });

  await this.app.api.link.deleteAllOf(id);

  return r.deletedCount > 0;
};

// Revokes the person's login without deleting the profile.
//
// Restricted to whoever created the profile: a professional who merely got
// access by request must not be able to lock the person out of an account the
// person owns.
User_model.prototype.revokeStudentAccess = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id), createdBy: new ObjectId(trainerId) },
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

  // What this professional calls the people they follow: aluno, paciente,
  // cliente. Stored lowercase — the screens capitalise where they need to, so
  // "Aluno" typed here does not become "ALunos" in the middle of a sentence.
  if (obj.peopleSingular !== undefined) {
    set.peopleSingular = String(obj.peopleSingular).trim().toLowerCase();
  }
  if (obj.peoplePlural !== undefined) {
    set.peoplePlural = String(obj.peoplePlural).trim().toLowerCase();
  }

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

  const ids = await this.app.api.link.personIdsOf(trainerId);
  if (ids.length === 0) {
    return { total: 0, active: 0, inactive: 0, withAccess: 0, newThisMonth: 0 };
  }

  const base = { _id: { $in: ids } };

  const total = ids.length;
  // Ativo aqui é ativo NA LISTA deste profissional, igual ao que a tela mostra
  // — contar pelo `active` da conta daria um número que não bate com a lista.
  const activeMap = await this.app.api.link.activeMap(trainerId);
  const active = ids.filter((id) => (activeMap.get(String(id)) ?? 1) === 1).length;
  const withAccess = await col.countDocuments({ ...base, password: { $ne: null } });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const newThisMonth = await col.countDocuments({ ...base, createdAt: { $gte: monthStart } });

  return { total, active, inactive: total - active, withAccess, newThisMonth };
};

// ── Every user, no scoping — admin only ──────────────────────────────────

// Powers the Users screen. Unlike listStudents/listTrainers this one is not
// filtered by ownership at all, which is exactly why every route that reaches
// it asks for the users.view permission first.
User_model.prototype.listAll = async function (filter) {
  const col = await this.collection();
  const query = {};

  if (filter && filter.search) {
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
    ];
  }

  if (filter && filter.type) query.type = String(filter.type);
  if (filter && filter.active !== undefined && filter.active !== "") {
    query.active = Number(filter.active) ? 1 : 0;
  }
  if (filter && filter.role && ObjectId.isValid(filter.role)) query.role = new ObjectId(filter.role);

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  const byProfessional = await this.app.api.link.countsByProfessional();
  const roleNames = await this.roleNameMap();

  return docs.map((d) => ({
    ...this.filter(d),
    roleName: roleNames.get(String(d.role)) || "",
    totalStudents: byProfessional.get(String(d._id)) || 0,
  }));
};

// Admin edit of ANY user. Separate from updateTrainer/updateStudent because
// those two pin `type` in the query — here type itself can change.
User_model.prototype.updateAny = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();
  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;
  if (obj.role !== undefined && ObjectId.isValid(obj.role)) set.role = new ObjectId(obj.role);
  if (obj.admin !== undefined) set.admin = obj.admin === true || obj.admin === 1;
  if (obj.type !== undefined && TYPES.includes(String(obj.type))) set.type = String(obj.type);

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

  const r = await col.updateOne({ _id: new ObjectId(id) }, update);
  return r.matchedCount > 0;
};

User_model.prototype.deleteAny = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id) });
  // Links in BOTH directions go with them, otherwise a list would try to load
  // an id that no longer exists.
  await this.app.api.link.deleteAllOf(id);

  return r.deletedCount > 0;
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
    admins: await this.countAdmins(),
    newThisMonth: await col.countDocuments({ createdAt: { $gte: monthStart } }),
  };
};

module.exports = User_model;
module.exports.TYPES = TYPES;
