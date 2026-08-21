// Prepara os bancos do zero: o CENTRAL (center + catálogo de exercícios) e o de
// cada instância registrada (contas, treinos, vínculos), com todos os índices.
//
//   npm run db:init
//   npm run db:init -- "Marlon" "marlon@gofitnow.fit" "senha"
//   npm run db:init -- "Marlon" "marlon@gofitnow.fit" "senha" outra-instancia
//
// O usuário é criado DENTRO de uma instância — a semente, ou a que vier no
// quarto argumento. Isso é obrigatório e não tem padrão silencioso: um admin
// criado no banco errado é um admin que não existe para quem vai usar.
//
// Pode rodar de novo: collections e índices são idempotentes, e um usuário que
// já existe é só reportado, nunca duplicado.
require("dotenv").config();

const defaultModules = require("../defaultModules.js");
const appModels = require("../appModels.js");
const ensureSchema = require("./schema.js");
const instanceContext = require("../lib/instance.js");

const SEED_INSTANCE = process.env.SEED_INSTANCE || "marlon";

// Same wiring as app.js, minus Express — the models expect an object holding
// mongodb plus the default modules.
const app = {};
app.mongodb = require("../config/mongodb.js");
for (const k in defaultModules) app[k] = defaultModules[k];
app.api = {};
for (const k in appModels) app.api[k] = new appModels[k](app);

(async () => {
  try {
    await app.mongodb.centralDb();
    await ensureSchema(app);

    const [name, email, password, instanceArg] = process.argv.slice(2);
    const instance = instanceContext.normalize(instanceArg) || SEED_INSTANCE;

    if (name && email && password) {
      // Dentro do contexto da instância: os modelos leem dele para saber qual
      // banco abrir, e fora dele estouram de propósito.
      await instanceContext.run(instance, async () => {
        const exists = await app.api.user.dataByEmail(email);

        if (exists) {
          console.log(`[init] usuário já existe em ${instance}: ${email}`);
        } else {
          const id = await app.api.user.insertTrainer({ name, email, password, admin: true });
          console.log(`[init] admin criado em ${instance}: ${email} (${id})`);
        }
      });
    } else {
      console.log("[init] sem usuário nos argumentos — só o schema foi preparado.");
      console.log('[init] para criar o admin: npm run db:init -- "Nome" "email@dominio.com" "senha" [instancia]');
    }

    await app.mongodb.close();
    process.exit(0);
  } catch (error) {
    console.error("[init] failed:", error.message);
    process.exit(1);
  }
})();
