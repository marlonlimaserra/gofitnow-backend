const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const clusterLib = require("../../lib/cluster.js");

// Quantos processos sobem.
//
// O que se guarda aqui é a decisão, não o fork: forkar de dentro do teste subiria
// processos de verdade ouvindo porta de verdade, e o que interessa é que o número
// saia certo — inclusive na máquina de UM núcleo, onde forkar quatro deixaria
// tudo mais lento.
test.describe("quantos workers", () => {
  const original = process.env.WORKERS;
  test.afterEach(() => {
    if (original === undefined) delete process.env.WORKERS;
    else process.env.WORKERS = original;
  });

  test("WORKERS manda quando existe", () => {
    process.env.WORKERS = "3";
    assert.equal(clusterLib.quantos(), 3);
  });

  test("WORKERS=1 é respeitado — é como se desliga o fork", () => {
    process.env.WORKERS = "1";
    assert.equal(clusterLib.quantos(), 1);
  });

  test("sem WORKERS, é um por núcleo", () => {
    delete process.env.WORKERS;
    const nucleos =
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length || 1;

    assert.equal(clusterLib.quantos(), nucleos);
  });

  test("valor sem sentido cai no número de núcleos, não em zero", () => {
    // Zero workers seria uma API que sobe e não atende ninguém. "abc", "0" e
    // "-2" têm de cair no padrão, não virar o padrão.
    const nucleos =
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length || 1;

    for (const lixo of ["abc", "0", "-2", ""]) {
      process.env.WORKERS = lixo;
      assert.equal(clusterLib.quantos(), nucleos, `WORKERS=${JSON.stringify(lixo)}`);
    }
  });

  test("quebrado vira inteiro para baixo", () => {
    process.env.WORKERS = "2.9";
    assert.equal(clusterLib.quantos(), 2);
  });
});

test("o prazo de parada é menor que o do systemd", () => {
  // O systemd mata em 90s por padrão. Se o prazo daqui fosse maior, quem mataria
  // seria ele e a parada graciosa nunca aconteceria.
  assert.ok(clusterLib.PRAZO_MS < 90_000, `prazo alto demais: ${clusterLib.PRAZO_MS}`);
  assert.ok(clusterLib.PRAZO_MS >= 1000, "prazo curto demais para uma requisição terminar");
});
