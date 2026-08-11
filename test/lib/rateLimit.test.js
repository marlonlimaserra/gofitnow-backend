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
