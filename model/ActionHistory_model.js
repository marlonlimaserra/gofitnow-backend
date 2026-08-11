const { ObjectId } = require("mongodb");
const clientIp = require("../lib/clientIp.js");

// The `user_action_history` collection — who did what, when, from where.
//
// Same call shape as sprinthub-backend so the two read alike:
//
//   app.insertUserActionHistory(req, user, "create_person", {
//     local: { target_type: "people", target_id: id + "" },
//     extra: { name: body.name },
//   });
//
// Three rules this file exists to enforce:
//
// 1. It NEVER throws. A failed log must not turn a successful request into an
//    error the user sees — the action already happened.
// 2. It never stores a password, a hash or a salt. Those are stripped from
//    every payload, however deep, because a diff of a user edit would
//    otherwise carry the hash straight into a collection built for reading.
// 3. It is fire-and-forget at the call site. Awaiting it would put a second
//    database round trip on the critical path of every write.
function ActionHistory_model(app) {
  this.app = app;
}

// Never let these reach the log, at any depth.
const SECRET_KEYS = ["password", "newPassword", "currentPassword", "salt", "token", "tokenHash"];

ActionHistory_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("user_action_history");
};

function scrub(value, depth) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Date || value instanceof ObjectId) return value;
  if (typeof value !== "object") return value;

  const out = {};
  for (const key of Object.keys(value)) {
    if (SECRET_KEYS.includes(key)) {
      // Kept as a marker instead of dropped: "the password changed" is exactly
      // the kind of thing an audit trail should show.
      out[key] = "[oculto]";
      continue;
    }
    out[key] = scrub(value[key], depth + 1);
  }
  return out;
}

// Which fields changed between two versions of the same document. Only the
// changed ones are stored — a full before/after would double the collection
// for no gain.
ActionHistory_model.prototype.diff = function (before, after, ignoreKeys) {
  const ignore = new Set(["_id", "updatedAt", "createdAt", "salt", "password", ...(ignoreKeys || [])]);
  const changes = {};

  if (!before || !after) return changes;

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (ignore.has(key)) continue;

    const from = before[key];
    const to = after[key];

    // JSON comparison covers dates, ObjectIds and nested objects in one go;
    // these documents are small, so the cost does not matter.
    if (JSON.stringify(from) === JSON.stringify(to)) continue;

    changes[key] = { from: scrub(from, 0), to: scrub(to, 0) };
  }

  return changes;
};


// The one entry point. `data` accepts the sprinthub shape:
//
//   category   a bucket for filtering ("people", "auth", "admin"…)
//   local      { target_type, target_id } — what the action was performed ON
//   extra      anything else worth reading later
//   diff       the changed fields, usually built with .diff() above
ActionHistory_model.prototype.record = async function (req, user, action, data) {
  try {
    const payload = data && typeof data === "object" ? data : {};
    const local = payload.local || {};

    const doc = {
      action: String(action),
      category: payload.category || null,

      // Denormalised on purpose: a log is read far more often than written,
      // and the name has to survive the account being deleted.
      user: user && user._id ? new ObjectId(user._id) : null,
      userName: user ? user.name || null : null,
      userEmail: user ? user.email || null : null,

      target: {
        type: local.target_type || null,
        id: local.target_id != null ? String(local.target_id) : null,
      },

      details: scrub(payload.extra || {}, 0),
      diff: payload.diff && Object.keys(payload.diff).length ? scrub(payload.diff, 0) : null,

      ip: clientIp(req),
      userAgent: req && req.headers ? req.headers["user-agent"] || null : null,
      method: req ? req.method || null : null,
      url: req ? req.originalUrl || req.url || null : null,

      createdAt: new Date(),
    };

    const col = await this.collection();
    await col.insertOne(doc);

    return { success: true };
  } catch (error) {
    // Logging is never worth breaking a request over.
    console.error("[action-history] falhou ao registrar '" + action + "':", error.message);
    return { success: false };
  }
};

// "2026-08-10" → local midnight, or 23:59:59.999 of that day. Anything that
// already carries a time (an ISO timestamp) is used as it is.
function dayBoundary(value, edge) {
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());

  if (!plain) return new Date(value);

  const [year, month, day] = String(value).trim().split("-").map(Number);

  return edge === "end"
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

// Reading the trail. Filters are all optional and combine.
ActionHistory_model.prototype.list = async function (filter) {
  const col = await this.collection();
  const query = {};

  if (filter && filter.user && ObjectId.isValid(filter.user)) query.user = new ObjectId(filter.user);
  if (filter && filter.action) query.action = String(filter.action);
  if (filter && filter.category) query.category = String(filter.category);
  if (filter && filter.targetId) query["target.id"] = String(filter.targetId);
  if (filter && filter.targetType) query["target.type"] = String(filter.targetType);

  if (filter && (filter.from || filter.to)) {
    query.createdAt = {};

    // The screen sends plain dates (YYYY-MM-DD). Read as LOCAL midnight, not
    // UTC — in Brazil `new Date("2026-08-10")` is 21:00 of the 9th, which
    // silently shifts a whole day of results.
    if (filter.from) query.createdAt.$gte = dayBoundary(filter.from, "start");
    // The end date is INCLUSIVE: asking for "up to the 10th" and getting
    // nothing from the 10th because it means 00:00 is a bug from the user's
    // point of view, however defensible in date arithmetic.
    if (filter.to) query.createdAt.$lte = dayBoundary(filter.to, "end");
  }

  if (filter && filter.search) {
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { userName: { $regex: term, $options: "i" } },
      { userEmail: { $regex: term, $options: "i" } },
      { action: { $regex: term, $options: "i" } },
    ];
  }

  // Hard cap: this collection only grows, and a screen asking for everything
  // would page the whole history into memory. The ceiling is generous enough
  // for an export of a filtered range, which is the only legitimate reason to
  // ask for thousands of rows at once.
  const limit = Math.min(Number(filter && filter.limit) || 100, 5000);
  const skip = Number(filter && filter.skip) || 0;

  const [rows, total] = await Promise.all([
    col.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments(query),
  ]);

  return { rows, total, limit, skip };
};

// The values that actually occur in the collection, for the filter dropdowns.
// A distinct() over an indexed field is cheap and beats offering every action
// the catalog knows about when most of them never happened here.
ActionHistory_model.prototype.filterValues = async function () {
  const col = await this.collection();

  const [usedActions, usedCategories, usedTargetTypes, people] = await Promise.all([
    col.distinct("action"),
    col.distinct("category"),
    col.distinct("target.type"),
    // Who appears in the log — including accounts already deleted, which is
    // precisely when an audit trail earns its keep.
    col
      .aggregate([
        { $match: { user: { $ne: null } } },
        { $group: { _id: "$user", name: { $last: "$userName" }, email: { $last: "$userEmail" } } },
        { $sort: { name: 1 } },
        { $limit: 500 },
      ])
      .toArray(),
  ]);

  return {
    usedActions: usedActions.filter(Boolean).sort(),
    usedCategories: usedCategories.filter(Boolean).sort(),
    usedTargetTypes: usedTargetTypes.filter(Boolean).sort(),
    users: people.map((p) => ({ _id: p._id, name: p.name, email: p.email })),
  };
};

module.exports = ActionHistory_model;
