const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const controlador = require("../../controllers/WebhookMeta.js");

// O WEBHOOK DA META.
//
// *"ué, por que não podemos fazer agora?"* (26/09/2026). Podíamos: a ordem é
// escrever o endereço, subir, e só então configurar no console — porque a Meta
// confere o endereço NA HORA de salvar, mandando um desafio.
//
// ── O QUE ESTES CASOS SEGURAM ────────────────────────────────────────────
//
// Os três jeitos de este endpoint falhar em silêncio:
//
//   1. Responder o desafio para quem não sabe o token. Aí qualquer um aponta o
//      próprio webhook para cá e recebe os eventos de todo mundo.
//   2. Responder o desafio EMBRULHADO (em JSON, com aspas). A Meta recusa, e a
//      mensagem dela não diz o porquê — só "não foi possível validar".
//   3. Demorar para responder o evento. Ela desiste em cinco segundos e reenvia
//      — e o repetido chega idêntico, sem nada dizendo que é o mesmo.
const TOKEN = "um-token-de-teste-com-tamanho";

function monta({ token = TOKEN, segredo = "", guardar = [] } = {}) {
  const rotas = {};
  const app = {
    get: (caminho, fn) => (rotas["GET " + caminho] = fn),
    post: (caminho, fn) => (rotas["POST " + caminho] = fn),
    api: {
      center: {
        async tokenDoWebhookDaMeta() {
          return token;
        },
        async segredoDoAppDaMeta() {
          return segredo;
        },
        async guardarEventoDaMeta(e) {
          guardar.push(e);
        },
      },
    },
  };

  controlador(app);
  return { rotas, guardar };
}

function resposta() {
  const r = {
    codigo: 200,
    corpo: undefined,
    tipo: undefined,
    status(c) {
      r.codigo = c;
      return r;
    },
    type(t) {
      r.tipo = t;
      return r;
    },
    send(c) {
      r.corpo = c;
      return r;
    },
    sendStatus(c) {
      r.codigo = c;
      r.corpo = "";
      return r;
    },
  };
  return r;
}

test("o desafio volta em TEXTO PURO para quem sabe o token", async () => {
  // Embrulhado em JSON, a Meta recusa — e a mensagem dela não diz o porquê.
  const { rotas } = monta();
  const r = resposta();

  await rotas["GET /public/webhook/meta"](
    { query: { "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1234567" } },
    r
  );

  assert.equal(r.corpo, "1234567");
  assert.equal(r.tipo, "text/plain");
  assert.equal(r.codigo, 200);
});

test("token errado é 403 — e não o desafio", async () => {
  // O erro que abriria a porta: responder o desafio sem conferir. Aí qualquer
  // um aponta o próprio webhook para cá e passa a receber os eventos.
  const { rotas } = monta();
  const r = resposta();

  await rotas["GET /public/webhook/meta"](
    { query: { "hub.mode": "subscribe", "hub.verify_token": "chute", "hub.challenge": "1234567" } },
    r
  );

  assert.equal(r.codigo, 403);
  assert.notEqual(r.corpo, "1234567");
});

test("sem token configurado, NINGUÉM passa", async () => {
  // O estado de antes de configurar. Token vazio comparado com token vazio
  // daria "igual" numa comparação ingênua — e abriria a porta justamente
  // enquanto ela ainda não tem tranca.
  const { rotas } = monta({ token: "" });
  const r = resposta();

  await rotas["GET /public/webhook/meta"](
    { query: { "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "x" } },
    r
  );

  assert.equal(r.codigo, 403);
});

test("modo diferente de `subscribe` não vale, mesmo com o token certo", async () => {
  const { rotas } = monta();
  const r = resposta();

  await rotas["GET /public/webhook/meta"](
    { query: { "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "x" } },
    r
  );

  assert.equal(r.codigo, 403);
});

test("o evento é respondido ANTES de ser guardado", async () => {
  // A Meta desiste em cinco segundos e reenvia o que demorou. Guardar antes de
  // responder transformaria um soluço do Mongo numa enxurrada de repetidos.
  const ordem = [];
  const guardar = [];
  const { rotas } = monta({ guardar });

  const r = resposta();
  r.sendStatus = (c) => {
    ordem.push("respondeu");
    r.codigo = c;
    return r;
  };

  const antes = guardar.push.bind(guardar);
  guardar.push = (...args) => {
    ordem.push("guardou");
    return antes(...args);
  };

  await rotas["POST /public/webhook/meta"](
    { headers: {}, body: { object: "instagram", entry: [{ id: "17841400000" }] } },
    r
  );

  assert.deepEqual(ordem, ["respondeu", "guardou"]);
  assert.equal(r.codigo, 200);
});

test("o evento guardado leva o objeto e as entradas — é por elas que se acha o dono", async () => {
  const guardar = [];
  const { rotas } = monta({ guardar });

  await rotas["POST /public/webhook/meta"](
    { headers: {}, body: { object: "instagram", entry: [{ id: "17841400000", messaging: [] }] } },
    resposta()
  );

  assert.equal(guardar[0].corpo.object, "instagram");
  assert.equal(guardar[0].corpo.entry[0].id, "17841400000");
});

test("com segredo, a assinatura é CONFERIDA — e a errada é guardada como errada", async () => {
  // Jogar fora o que não confere apagaria justamente o sinal de que alguém
  // está tentando.
  const guardar = [];
  const corpo = { object: "instagram", entry: [] };
  const cru = Buffer.from(JSON.stringify(corpo));
  const segredo = "segredo-do-app";

  const certa = "sha256=" + crypto.createHmac("sha256", segredo).update(cru).digest("hex");

  const { rotas } = monta({ segredo, guardar });

  await rotas["POST /public/webhook/meta"](
    { headers: { "x-hub-signature-256": certa }, body: corpo, rawBody: cru },
    resposta()
  );
  assert.equal(guardar[0].confere, true);

  const errada = "sha256=" + "0".repeat(64);
  await rotas["POST /public/webhook/meta"](
    { headers: { "x-hub-signature-256": errada }, body: corpo, rawBody: cru },
    resposta()
  );
  assert.equal(guardar[1].confere, false);
});

test("sem segredo configurado, a conferência é NULA — e não `true`", async () => {
  // Nulo diz "não dava para conferir"; `true` diria "confere", que é mentira e
  // a mentira ficaria guardada no banco.
  //
  // O nome do campo muda de lado: o controlador entrega `confere`, e é o modelo
  // que o grava como `assinaturaConfere`. Este caso olha o contrato ENTRE os
  // dois, que é onde um rename silencioso quebraria tudo sem nenhum erro.
  const guardar = [];
  const { rotas } = monta({ guardar });

  await rotas["POST /public/webhook/meta"](
    { headers: { "x-hub-signature-256": "sha256=abc" }, body: {}, rawBody: Buffer.from("{}") },
    resposta()
  );

  assert.equal(guardar[0].confere, null);
});

test("um erro ao guardar NÃO derruba a resposta — ela já foi dada", async () => {
  const rotas = {};
  const app = {
    get: (c, fn) => (rotas["GET " + c] = fn),
    post: (c, fn) => (rotas["POST " + c] = fn),
    api: {
      center: {
        async tokenDoWebhookDaMeta() {
          return TOKEN;
        },
        async segredoDoAppDaMeta() {
          return "";
        },
        async guardarEventoDaMeta() {
          throw new Error("mongo fora");
        },
      },
    },
  };
  controlador(app);

  const r = resposta();
  await rotas["POST /public/webhook/meta"]({ headers: {}, body: {} }, r);

  assert.equal(r.codigo, 200);
});
