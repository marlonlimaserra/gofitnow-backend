// Prepara o banco do zero: cria as coleções (users, user_tokens), os índices
// e — se você passar os argumentos — já cadastra o primeiro usuário, que nasce
// como trainer + admin (é quem vai abrir o menu Clientes).
//
//   npm run db:init
//   npm run db:init -- "Marlon" "marlon@sprinthub.com" "minhasenha"
//
// Rodar de novo é seguro: as coleções/índices são idempotentes e um usuário já
// existente é apenas reportado, não duplicado.
require("dotenv").config();

const defaultModules = require("../defaultModules.js");
const appModels = require("../appModels.js");
const ensureSchema = require("./schema.js");

// Mesmo wiring do app.js, só sem o Express — os models esperam receber um
// objeto com mongodb + módulos padrão.
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
      const existe = await app.api.user.dataByEmail(email);

      if (existe) {
        console.log("[init] usuário já existe: " + email);
      } else {
        const id = await app.api.user.insertTrainer({ name, email, password, admin: true });
        console.log("[init] admin cadastrado: " + email + " (" + id + ")");
      }
    } else {
      console.log("[init] nenhum usuário informado — só o schema foi preparado.");
      console.log('[init] pra já cadastrar o admin: npm run db:init -- "Nome" "email@dominio.com" "senha"');
    }

    await app.mongodb.close();
    process.exit(0);
  } catch (error) {
    console.error("[init] falhou:", error.message);
    process.exit(1);
  }
})();
