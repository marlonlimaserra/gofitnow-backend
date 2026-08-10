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

  // Listing a trainer's students, and the admin listing trainers.
  await db
    .collection("users")
    .createIndex({ type: 1, trainer: 1, createdAt: -1 }, { name: "by_type_trainer" });
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

  console.log("[schema] collections and indexes ready");
};

module.exports.COLLECTIONS = COLLECTIONS;
