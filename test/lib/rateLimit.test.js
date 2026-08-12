const test = require("node:test");
const assert = require("node:assert/strict");

const rateLimit = require("../../lib/rateLimit.js");

test.beforeEach(() => rateLimit.reset());

test("deixa passar até o limite e barra a seguinte", () => {
  for (let i = 0; i < 60; i++) {
    assert.equal(rateLimit.check("k1").allowed, true, `chamada ${i + 1} devia passar`);
  }
  assert.equal(rateLimit.check("k1").allowed, false, "a 61ª tinha de ser barrada");
});

test("o restante desce a cada chamada e chega a zero", () => {
  assert.equal(rateLimit.check("k1").remaining, 59);
  assert.equal(rateLimit.check("k1").remaining, 58);

  for (let i = 0; i < 58; i++) rateLimit.check("k1");
  assert.equal(rateLimit.check("k1").remaining, 0);
});

test("o limite é POR CHAVE — uma integração com defeito não derruba as outras", () => {
  for (let i = 0; i < 60; i++) rateLimit.check("k1");

  assert.equal(rateLimit.check("k1").allowed, false);
  assert.equal(rateLimit.check("k2").allowed, true);
});

test("quando barra, diz em quantos segundos abre vaga", () => {
  for (let i = 0; i < 60; i++) rateLimit.check("k1");
  const r = rateLimit.check("k1");

  assert.equal(r.allowed, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60, `retryAfter fora da janela: ${r.retryAfter}`);
});

test("a janela é DESLIZANTE: passado o minuto, as antigas saem da conta", (t) => {
  // Com janela fixa, 60 chamadas no fim de um minuto e 60 no começo do
  // seguinte passariam — 120 em dois segundos.
  t.mock.timers.enable({ apis: ["Date"] });

  for (let i = 0; i < 60; i++) rateLimit.check("k1");
  assert.equal(rateLimit.check("k1").allowed, false);

  // 30s depois ainda está barrado: as 60 continuam dentro da janela.
  t.mock.timers.tick(30_000);
  assert.equal(rateLimit.check("k1").allowed, false);

  // Passado o minuto inteiro, as 60 saíram e tudo libera de novo.
  t.mock.timers.tick(31_000);
  assert.equal(rateLimit.check("k1").allowed, true);
});

test("a vaga abre aos poucos, não de uma vez", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });

  // 30 chamadas, pausa de 40s, mais 30: chega ao limite.
  for (let i = 0; i < 30; i++) rateLimit.check("k1");
  t.mock.timers.tick(40_000);
  for (let i = 0; i < 30; i++) rateLimit.check("k1");
  assert.equal(rateLimit.check("k1").allowed, false);

  // Passados mais 21s, só o PRIMEIRO bloco saiu da janela: abre 30 vagas, não 60.
  t.mock.timers.tick(21_000);
  const r = rateLimit.check("k1");
  assert.equal(r.allowed, true);
  assert.ok(r.remaining < 60 - 1, `abriu vaga demais: restante ${r.remaining}`);
});

test("o limite pode ser passado por chamada", () => {
  assert.equal(rateLimit.check("k1", 2).allowed, true);
  assert.equal(rateLimit.check("k1", 2).allowed, true);
  assert.equal(rateLimit.check("k1", 2).allowed, false);
});

test("o limite padrão é 60 por minuto", () => {
  assert.equal(rateLimit.LIMITE_PADRAO, 60);
  assert.equal(rateLimit.JANELA_MS, 60_000);
  assert.equal(rateLimit.check("k1").limit, 60);
});

// ── Atravessando o cluster ─────────────────────────────────────────────────
//
// Com vários processos, um contador por worker faria o limite de 60 valer 60 × N
// sem ninguém perceber. Quem decide é o primário, e `checkShared` é o caminho por
// onde as rotas passam a pedir.
test("checkShared decide localmente quando não há cluster", async () => {
  rateLimit.reset();

  // Neste processo `cluster.isWorker` é falso: não há primário para perguntar, e
  // o Map daqui é o único que existe. A resposta tem de ser a mesma do check.
  for (let i = 0; i < 60; i++) {
    const r = await rateLimit.checkShared("k-solo");
    assert.equal(r.allowed, true, `chamada ${i + 1} devia passar`);
  }

  const barrada = await rateLimit.checkShared("k-solo");
  assert.equal(barrada.allowed, false, "a 61ª tinha de ser barrada");
  assert.equal(barrada.degraded, undefined, "não houve degradação: ninguém foi consultado");
});

test("checkShared respeita o limite passado por chamada", async () => {
  rateLimit.reset();

  assert.equal((await rateLimit.checkShared("k-lim", 2)).allowed, true);
  assert.equal((await rateLimit.checkShared("k-lim", 2)).allowed, true);
  assert.equal((await rateLimit.checkShared("k-lim", 2)).allowed, false);
});

test("atenderWorker responde ao pedido do worker com a decisão do primário", async () => {
  rateLimit.reset();

  // Um worker de mentira: só o que o primário usa dele é `on("message")` e
  // `send`. Assim dá para exercitar o lado do primário sem forkar processo.
  const enviados = [];
  const fake = {
    ouvintes: [],
    on(evento, fn) {
      if (evento === "message") this.ouvintes.push(fn);
    },
    send(msg) {
      enviados.push(msg);
    },
  };

  rateLimit.atenderWorker(fake);
  const receber = (msg) => fake.ouvintes.forEach((fn) => fn(msg));

  receber({ tipo: "rateLimit:check", id: 1, chave: "k-ipc", limite: 2 });
  receber({ tipo: "rateLimit:check", id: 2, chave: "k-ipc", limite: 2 });
  receber({ tipo: "rateLimit:check", id: 3, chave: "k-ipc", limite: 2 });

  assert.equal(enviados.length, 3, "cada pedido tem de ter uma resposta");
  assert.deepEqual(
    enviados.map((m) => m.id),
    [1, 2, 3],
    "a resposta volta com o id do pedido, senão o worker não sabe de qual foi"
  );
  assert.equal(enviados[0].resultado.allowed, true);
  assert.equal(enviados[1].resultado.allowed, true);
  assert.equal(enviados[2].resultado.allowed, false, "o terceiro pedido estourou o limite de 2");
});

test("mensagem que não é do limitador é ignorada", async () => {
  rateLimit.reset();

  const enviados = [];
  const fake = {
    ouvintes: [],
    on(evento, fn) {
      if (evento === "message") this.ouvintes.push(fn);
    },
    send(msg) {
      enviados.push(msg);
    },
  };

  rateLimit.atenderWorker(fake);
  fake.ouvintes.forEach((fn) => fn({ tipo: "outra:coisa", id: 9 }));
  fake.ouvintes.forEach((fn) => fn(null));

  assert.equal(enviados.length, 0, "o canal do cluster é compartilhado: responder a tudo é ruído");
});
