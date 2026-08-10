// Creates the GoFitNow collections and indexes. Runs at boot (app.js) and also
// standalone via `npm run db:init`. Idempotent: running it again duplicates
// nothing.
const COLLECTIONS = [
  "users",
  "user_tokens",
  "workouts",
  "workout_sessions",
  "exercises",
  "password_resets",
  "professional_links",
  "access_requests",
  "roles",
  "user_action_history",
  "workout_presets",
];

module.exports = async function ensureSchema(app) {
  const db = await app.mongodb.connectToServer();

  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  for (const name of COLLECTIONS) {
    if (!existing.includes(name)) {
      await db.createCollection(name);
      console.log("[schema] collection created: " + name);
    }
  }

  // users — the e-mail is the login key, so the unique index in the database
  // is what really prevents two identical signups (the controller check alone
  // loses a race between two simultaneous requests).
  //
  // The index is PARTIAL because a student without access may have no e-mail
  // at all: without the filter, the second one would collide with the first.
  await db.collection("users").createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_unique" }
  );

  // Who follows whom moved to `professional_links`, so the old index on
  // (type, trainer) has nothing left to serve.
  await dropIndexIfPresent(db, "users", "by_type_trainer");

  // The admin list and the Users screen: everything of one type, newest first.
  await db.collection("users").createIndex({ type: 1, createdAt: -1 }, { name: "by_type_created" });
  await db.collection("users").createIndex({ type: 1, name: 1 }, { name: "by_type_name" });
  await db.collection("users").createIndex({ admin: 1 }, { name: "by_admin" });

  // user_tokens — looked up by token on every request; the TTL sweeps expired
  // ones.
  await db.collection("user_tokens").createIndex({ token: 1 }, { unique: true, name: "token_unique" });
  await db
    .collection("user_tokens")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "token_ttl" });
  await db.collection("user_tokens").createIndex({ user: 1 }, { name: "by_user" });

  // workouts — always listed by (trainer, student), ordered by period.
  await db
    .collection("workouts")
    .createIndex({ trainer: 1, student: 1, startDate: -1 }, { name: "by_trainer_student" });

  // workout_sessions — read per workout, in the order the trainer defined.
  await db.collection("workout_sessions").createIndex({ workout: 1, order: 1 }, { name: "by_workout" });
  await db.collection("workout_sessions").createIndex({ trainer: 1 }, { name: "by_trainer" });

  // exercises — per-trainer catalog. Sorting and search use `nameSort` (name
  // trimmed, lowercased and unaccented) — see Exercise_model.
  await db.collection("exercises").createIndex({ trainer: 1, nameSort: 1 }, { name: "by_trainer_name" });
  await db
    .collection("exercises")
    .createIndex({ trainer: 1, muscleGroup: 1, nameSort: 1 }, { name: "by_trainer_group" });

  // password_resets — looked up by token hash; the TTL sweeps expired ones.
  await db
    .collection("password_resets")
    .createIndex({ tokenHash: 1 }, { unique: true, name: "token_hash_unique" });
  await db
    .collection("password_resets")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "reset_ttl" });
  await db.collection("password_resets").createIndex({ user: 1 }, { name: "by_user" });

  // professional_links — read constantly (every people list starts here) and
  // in both directions. The unique pair is what makes linking idempotent.
  await db
    .collection("professional_links")
    .createIndex({ professional: 1, person: 1 }, { unique: true, name: "link_unique" });
  await db.collection("professional_links").createIndex({ person: 1 }, { name: "by_person" });

  // access_requests — looked up by token hash. The TTL only reaches documents
  // that still have `expiresAt`, and answering a request removes the field, so
  // approvals and refusals are kept while abandoned requests are swept.
  await db
    .collection("access_requests")
    .createIndex({ tokenHash: 1 }, { unique: true, name: "request_token_unique" });
  await db
    .collection("access_requests")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "request_ttl" });
  await db
    .collection("access_requests")
    .createIndex({ professional: 1, person: 1, status: 1 }, { name: "by_pair_status" });

  // roles — the user types. Few rows, read on every authenticated request, so
  // the name is unique to keep two "Administrador" from ever coexisting.
  await db.collection("roles").createIndex({ name: 1 }, { unique: true, name: "role_name_unique" });
  await db.collection("roles").createIndex({ permissions: 1 }, { name: "by_permission" });

  // users — the role is read on every request that checks a permission.
  await db.collection("users").createIndex({ role: 1 }, { name: "by_role" });

  // user_action_history — write-heavy, read by "who did this" and "what
  // happened to this record". No TTL: an audit trail that deletes itself is
  // not one. If it ever needs pruning that is a deliberate decision, not a
  // background sweep nobody remembers configuring.
  await db
    .collection("user_action_history")
    .createIndex({ createdAt: -1 }, { name: "by_date" });
  await db
    .collection("user_action_history")
    .createIndex({ user: 1, createdAt: -1 }, { name: "by_user_date" });
  await db
    .collection("user_action_history")
    .createIndex({ "target.type": 1, "target.id": 1, createdAt: -1 }, { name: "by_target" });
  await db
    .collection("user_action_history")
    .createIndex({ action: 1, createdAt: -1 }, { name: "by_action" });

  // workout_presets — sempre lidos por profissional, em ordem alfabetica.
  await db
    .collection("workout_presets")
    .createIndex({ professional: 1, name: 1 }, { name: "by_professional_name" });

  await backfillLinks(db);

  await app.api.role.ensureSystemRoles();
  await backfillRoles(db, app);
  await dropRetiredPermissions(db);
  await moveNotesToLinks(db);

  console.log("[schema] collections and indexes ready");
};

// A observação deixou de ser um campo da PESSOA e passou a ser do VÍNCULO: é a
// anotação privada de um profissional sobre alguém. No documento da pessoa ela
// era lida por todos os outros profissionais que a acompanham — e pela própria
// pessoa, na área dela.
//
// A anotação existente vai para o vínculo de quem criou a ficha, que é quem a
// escreveu. Idempotente: o campo é removido da pessoa depois de convertido, e
// numa segunda execução não sobra nada para converter.
async function moveNotesToLinks(db) {
  const users = db.collection("users");
  const pending = await users.find({ notes: { $nin: [null, ""] } }).toArray();

  if (pending.length === 0) {
    await users.updateMany({ notes: { $exists: true } }, { $unset: { notes: "" } });
    return;
  }

  let moved = 0;

  for (const person of pending) {
    // Sem `createdBy` não há a quem atribuir a anotação. Apagá-la em silêncio
    // seria pior do que deixá-la órfã, então ela fica onde está e o log avisa.
    if (!person.createdBy) {
      console.log("[schema] observação de " + person.name + " sem autor conhecido — mantida");
      continue;
    }

    await db.collection("professional_links").updateOne(
      { professional: person.createdBy, person: person._id },
      { $set: { notes: person.notes, notesAt: person.updatedAt || new Date() } }
    );

    await users.updateOne({ _id: person._id }, { $unset: { notes: "" } });
    moved++;
  }

  await users.updateMany({ notes: "" }, { $unset: { notes: "" } });

  console.log("[schema] " + moved + " observação(ões) movida(s) para o vínculo do autor");
}

// Tira dos tipos já salvos as permissões que foram aposentadas. Uma chave
// órfã não concede nada — nenhuma rota pergunta por ela — mas continua sendo
// exibida e contada na tela, o que faz o admin achar que ainda significa algo.
async function dropRetiredPermissions(db) {
  const { RETIRED } = require("../lib/permissions.js");
  if (!RETIRED.length) return;

  const r = await db
    .collection("roles")
    .updateMany(
      { permissions: { $in: RETIRED } },
      { $pull: { permissions: { $in: RETIRED } }, $set: { updatedAt: new Date() } }
    );

  if (r.modifiedCount > 0) {
    console.log("[schema] " + r.modifiedCount + " tipo(s) limpos de permissões aposentadas");
  }
}

// Gives every account a role. Whoever has `admin: true` becomes an
// Administrador, every other professional a Profissional, and everyone being
// followed a Pessoa.
//
// The `admin` flag is KEPT, not converted away: it is the master switch that
// grants whatever permissions exist at the time of the request, which is how
// an owner stays covered when a new permission ships. The role only decides
// what the account can do when that switch is off.
//
// Idempotent: only users WITHOUT a role are touched, so a second run finds
// nothing to do.
async function backfillRoles(db, app) {
  const users = db.collection("users");

  const pending = await users.find({ role: { $in: [null, undefined] } }).toArray();
  if (pending.length === 0) return;

  const roles = db.collection("roles");
  const admin = await roles.findOne({ name: "Administrador" });
  const professional = await roles.findOne({ name: "Profissional" });
  const person = await roles.findOne({ name: "Pessoa" });

  let counts = { admin: 0, professional: 0, person: 0 };

  for (const user of pending) {
    let role = person;
    let bucket = "person";

    if (user.admin === true) {
      role = admin;
      bucket = "admin";
    } else if (user.type === "trainer") {
      role = professional;
      bucket = "professional";
    }

    if (!role) continue;

    await users.updateOne(
      { _id: user._id },
      { $set: { role: role._id, admin: user.admin === true, updatedAt: new Date() } }
    );
    counts[bucket]++;
  }

  console.log(
    "[schema] roles assigned — " +
      counts.admin +
      " Administrador, " +
      counts.professional +
      " Profissional, " +
      counts.person +
      " Pessoa"
  );
}

// Dropping an index that no longer matches how the data is read. Missing is
// the expected case on a fresh database, so it is not an error.
async function dropIndexIfPresent(db, collection, name) {
  try {
    await db.collection(collection).dropIndex(name);
    console.log("[schema] index dropped: " + collection + "." + name);
  } catch (error) {
    if (error.codeName !== "IndexNotFound") throw error;
  }
}

// One-time move from the old model, where a student carried a single `trainer`
// field, to the links collection. Idempotent: the unique index turns a repeat
// run into a no-op, and the `trainer` field is dropped once converted, so
// there is nothing left to convert on the next boot.
async function backfillLinks(db) {
  const users = db.collection("users");

  const legacy = await users.find({ trainer: { $exists: true } }).toArray();
  if (legacy.length === 0) return;

  for (const doc of legacy) {
    if (doc.trainer) {
      await db
        .collection("professional_links")
        .updateOne(
          { professional: doc.trainer, person: doc._id },
          {
            $setOnInsert: {
              professional: doc.trainer,
              person: doc._id,
              source: "created",
              createdAt: doc.createdAt || new Date(),
            },
          },
          { upsert: true }
        );
    }

    await users.updateOne(
      { _id: doc._id },
      { $set: { createdBy: doc.createdBy || doc.trainer || null }, $unset: { trainer: "" } }
    );
  }

  console.log("[schema] " + legacy.length + " link(s) migrated from the old `trainer` field");
}

module.exports.COLLECTIONS = COLLECTIONS;
