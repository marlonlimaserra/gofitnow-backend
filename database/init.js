// Prepares the database from scratch: creates the collections (users,
// user_tokens, workouts, workout_sessions, exercises), the indexes and — if
// you pass the arguments — the first user, who is born trainer + admin (the
// one who opens the Clients menu).
//
//   npm run db:init
//   npm run db:init -- "Marlon" "marlon@sprinthub.com" "mypassword"
//
// Safe to re-run: collections and indexes are idempotent, and an existing user
// is just reported, never duplicated.
require("dotenv").config();

const defaultModules = require("../defaultModules.js");
const appModels = require("../appModels.js");
const ensureSchema = require("./schema.js");

// Same wiring as app.js, minus Express — the models expect an object holding
// mongodb plus the default modules.
const app = {};
app.mongodb = require("../config/mongodb.js");
for (const k in defaultModules) app[k] = defaultModules[k];
app.api = {};
for (const k in appModels) app.api[k] = new appModels[k](app);

(async () => {
  try {
    await app.mongodb.connectToServer();
    await ensureSchema(app);

    const [name, email, password] = process.argv.slice(2);

    if (name && email && password) {
      const exists = await app.api.user.dataByEmail(email);

      if (exists) {
        console.log("[init] user already exists: " + email);
      } else {
        const id = await app.api.user.insertTrainer({ name, email, password, admin: true });
        console.log("[init] admin created: " + email + " (" + id + ")");
      }
    } else {
      console.log("[init] no user given — only the schema was prepared.");
      console.log('[init] to create the admin: npm run db:init -- "Name" "email@domain.com" "password"');
    }

    await app.mongodb.close();
    process.exit(0);
  } catch (error) {
    console.error("[init] failed:", error.message);
    process.exit(1);
  }
})();
