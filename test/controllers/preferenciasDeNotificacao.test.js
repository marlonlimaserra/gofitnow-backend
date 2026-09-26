const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const UserController = require("../../controllers/User.js");
const { CHAVES } = require("../../lib/notificacoes.js");

// AS NOTIFICAÇÕES QUE A PESSOA QUER RECEBER.
//
// *"nas preferências do usuário ele pode [escolher] quais notificações ele quer
// ou não receber; por padrão vem tudo ativado. Aí vários e-mails que vamos
// enviar vai verificar essas notificações"*.
//
// Rota própria, e não mais um saco no `/me/preferences`: aquilo é gosto de tela
// e grava o que mandarem. Isto decide se um e-mail sai.
function monta({ notify = undefined } = {}) {
  const gravados = [];
  let atual = notify;

  const app = fakeApp({
    api: {
      user: {
        data: async () => ({ _id: "u1", preferences: atual ? { notify: atual } : {} }),
        savePreferences: async (_id, prefs) => {
          gravados.push(prefs);
          atual = prefs.notify;
          return true;
        },
      },
    },
    helpers: {
      ReqProtected: {
        verify: async () => ({ _id: "u1", preferences: atual ? { notify: atual } : {} }),
        has: () => true,
      },
    },
  });

  UserController(app);
  return { app, gravados };
}

test("por padrão vem tudo ativado", async () => {
  // É o estado de todo mundo que já existe hoje. Se o padrão fosse o contrário,
  // subir isto seria emudecer o sistema inteiro de uma vez.
  const { app } = monta();

  const r = await call(app, "get", "/me/notifications");

  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.rows.map((l) => l.chave),
    CHAVES
  );
  assert.ok(r.body.rows.every((l) => l.ligada === true));
});

test("o que foi desligado volta desligado", async () => {
  const { app } = monta({ notify: { workout: false } });

  const r = await call(app, "get", "/me/notifications");

  assert.equal(r.body.rows.find((l) => l.chave === "workout").ligada, false);
  assert.equal(r.body.rows.find((l) => l.chave === "diet").ligada, true);
});

test("mexer num interruptor não apaga a escolha dos outros", async () => {
  // `savePreferences` grava `preferences.notify` INTEIRO. Sem a mistura no
  // controller, ligar "treino" derrubaria tudo o que a pessoa já tinha
  // desligado — e ela só descobriria pelos e-mails voltando.
  const { app, gravados } = monta({ notify: { workout: false, diet: false } });

  const r = await call(app, "put", "/me/notifications", { body: { workout: true } });

  assert.equal(r.status, 200);
  assert.deepEqual(gravados[0].notify, { workout: true, diet: false });
  assert.equal(r.body.rows.find((l) => l.chave === "diet").ligada, false);
});

test("chave inventada não entra no documento do usuário", async () => {
  // `preferences` é campo livre e o corpo vem do navegador: sem a peneira,
  // qualquer coisa entraria no usuário por esta porta.
  const { app, gravados } = monta();

  const r = await call(app, "put", "/me/notifications", {
    body: { workout: false, isAdmin: true },
  });

  assert.equal(r.status, 200);
  assert.deepEqual(gravados[0].notify, { workout: false });
});

test("corpo sem nenhuma chave conhecida é 400 — e não grava nada", async () => {
  const { app, gravados } = monta();

  const r = await call(app, "put", "/me/notifications", { body: { isAdmin: true } });

  assert.equal(r.status, 400);
  assert.deepEqual(gravados, []);
});

test("o que não é booleano vira booleano", async () => {
  const { app, gravados } = monta();

  await call(app, "put", "/me/notifications", { body: { ticket: "não", message: 0 } });

  assert.deepEqual(gravados[0].notify, { ticket: true, message: true });
});
