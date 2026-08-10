const { ObjectId } = require("mongodb");
const permissions = require("../lib/permissions.js");

// The `roles` collection — the user TYPES and what each one may do.
//
// A user points at exactly one role, and the role carries the list of
// permission keys. That is the whole authorization model: routes ask for a
// key, never for "is this an admin".
//
// Three roles are seeded and marked `system: true`:
//
//   Administrador  every permission, kept in sync as new ones ship
//   Profissional   the people/workouts/exercises side
//   Pessoa         nothing — someone being followed only ever reads /me
//
// System roles cannot be deleted. Administrador additionally cannot be edited:
// it is the way back in, and letting it lose `roles.manage` would lock the
// platform out of its own permission screen with no way to fix it.
function Role_model(app) {
  this.app = app;
}

const ADMIN_NAME = "Administrador";

Role_model.prototype.adminName = ADMIN_NAME;

Role_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("roles");
};

Role_model.prototype.list = async function () {
  const col = await this.collection();
  const docs = await col.find({}).sort({ system: -1, name: 1 }).toArray();

  // How many accounts use each type — the screen shows it, and it is what
  // stops a type from being deleted while somebody still depends on it.
  const users = await (await this.app.api.user.collection())
    .aggregate([{ $group: { _id: "$role", total: { $sum: 1 } } }])
    .toArray();

  const byRole = new Map(users.map((u) => [String(u._id), u.total]));

  return docs.map((d) => ({ ...d, totalUsers: byRole.get(String(d._id)) || 0 }));
};

Role_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

Role_model.prototype.dataByName = async function (name) {
  const col = await this.collection();
  const doc = await col.findOne({ name: String(name).trim() });
  return doc || undefined;
};

Role_model.prototype.insert = async function (obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    name: String(obj.name).trim(),
    description: obj.description ? String(obj.description).trim() : "",
    permissions: permissions.sanitize(obj.permissions),
    system: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Role_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.description !== undefined) set.description = String(obj.description).trim();
  if (obj.permissions !== undefined) set.permissions = permissions.sanitize(obj.permissions);

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
  return r.matchedCount > 0;
};

Role_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), system: { $ne: true } });
  return r.deletedCount > 0;
};

// Does this role carry that permission? Used by the guards that need to know
// what a user WILL be able to do after a change, not just what they can now.
Role_model.prototype.grants = async function (roleId, permission) {
  if (!roleId) return false;
  const role = await this.data(roleId);
  return !!role && (role.permissions || []).includes(permission);
};

Role_model.prototype.countUsers = async function (id) {
  const col = await this.app.api.user.collection();
  return await col.countDocuments({ role: new ObjectId(id) });
};

// How many ACTIVE accounts still hold a given permission. This replaces the
// old "count the admins" check: what must never reach zero is not a flag, it
// is somebody able to hand permissions back out.
Role_model.prototype.countActiveUsersWith = async function (permission, ignoreUserId) {
  const roles = await this.collection();
  const withIt = await roles.find({ permissions: permission }).project({ _id: 1 }).toArray();

  // A master-switch account holds every permission, so it counts here even
  // when its role carries none. Leaving it out would let the platform delete
  // its last real owner while thinking somebody else was still covered.
  const query = {
    active: 1,
    $or: [{ admin: true }, { role: { $in: withIt.map((r) => r._id) } }],
  };

  // Used when the caller is about to change this very user and wants to know
  // whether anybody ELSE would be left.
  if (ignoreUserId) query._id = { $ne: new ObjectId(ignoreUserId) };

  const users = await this.app.api.user.collection();
  return await users.countDocuments(query);
};

// Creates the system roles when they are missing, and keeps Administrador
// holding every permission — including ones added in a later release, which
// would otherwise leave the platform with a menu nobody can open.
Role_model.prototype.ensureSystemRoles = async function () {
  const col = await this.collection();

  const defaults = [
    {
      name: ADMIN_NAME,
      description: "Acesso total à plataforma.",
      permissions: permissions.ALL,
    },
    {
      name: "Profissional",
      description: "Acompanha pessoas, monta treinos e mantém o próprio catálogo.",
      permissions: [
        "people.view",
        "people.create",
        "people.edit",
        "people.delete",
        "people.access",
        "workouts.view",
        "workouts.manage",
        "exercises.view",
        "exercises.manage",
      ],
    },
    {
      name: "Pessoa",
      description: "Acompanhada por profissionais. Vê apenas os próprios dados.",
      permissions: [],
    },
  ];

  for (const role of defaults) {
    const existing = await col.findOne({ name: role.name });

    if (!existing) {
      await col.insertOne({
        ...role,
        system: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log("[schema] role created: " + role.name);
      continue;
    }

    // Only Administrador is force-synced. The other two are starting points
    // the admin is free to reshape.
    if (role.name === ADMIN_NAME) {
      const missing = permissions.ALL.filter((p) => !(existing.permissions || []).includes(p));
      if (missing.length > 0) {
        await col.updateOne(
          { _id: existing._id },
          { $set: { permissions: permissions.ALL, system: true, updatedAt: new Date() } }
        );
        console.log("[schema] " + ADMIN_NAME + " got " + missing.length + " new permission(s)");
      }
    }
  }
};

module.exports = Role_model;
