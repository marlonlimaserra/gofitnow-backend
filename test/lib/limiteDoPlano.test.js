const test = require("node:test");
const assert = require("node:assert/strict");

const limiteDoPlano = require("../../lib/limiteDoPlano.js");

// O teto do plano era decorativo: seis limites guardados, nenhum consultado. O
// plano `basico` dizia "1 treino, 0 profissionais" e a instância `marlon` tinha
// 628 treinos e 218 usuários. Isto é o que passou a barrar.
function monta(limites, quantos = 0) {
  const app = { api: { center: { async limitsFor() { return limites; } } } };
  return { app, contar: async () => quantos };
}

test("VAZIO é ilimitado, e nem conta", async () => {
  let contou = false;
  const { app } = monta({ people: null });

  const r = await limiteDoPlano.checar(app, "marlon", "people", async () => {
    contou = true;
    return 9999;
  });

  assert.equal(r, null);
  // Contar para descobrir que não há limite seria um `countDocuments` em TODO
  // POST do sistema, para nada.
  assert.equal(contou, false, "não deve nem contar quando é ilimitado");
});

test("chave que o plano não conhece passa — plano velho não vira tranca", async () => {
  // Um plano criado antes de `exams` existir não tem a chave. Tratá-lo como
  // zero desligaria exames para quem já pagava por eles.
  const { app, contar } = monta({ people: 10 });
  assert.equal(await limiteDoPlano.checar(app, "marlon", "exams", contar), null);
});

test("ZERO é NÃO INCLUÍDO, e tem código próprio", async () => {
  const { app, contar } = monta({ schedule: 0 });
  const r = await limiteDoPlano.checar(app, "marlon", "schedule", contar);

  // O código separa as duas conversas: "seu plano não inclui agenda" manda
  // falar com quem vende; "você chegou a 50" manda apagar ou subir de plano.
  assert.equal(r.code, "not_in_plan");
});

test("abaixo do teto passa; EM CIMA dele barra", async () => {
  // O que decide é `>=`: com 50 de teto e 50 criados, o próximo é o 51.
  assert.equal(await limiteDoPlano.checar(...comTeto(50, 49)), null);

  const r = await limiteDoPlano.checar(...comTeto(50, 50));
  assert.equal(r.code, "plan_limit");
  assert.equal(r.max, 50);
  assert.equal(r.atual, 50);
});

function comTeto(teto, quantos) {
  const { app, contar } = monta({ people: teto }, quantos);
  return [app, "marlon", "people", contar];
}

test("central fora do ar NÃO barra ninguém", async () => {
  // Falha aberta, e é a mesma decisão que já estava escrita em `limitsFor`: um
  // limite inventado barraria um cliente que pagou. Uma queda do painel não pode
  // virar uma queda do produto.
  const app = { api: { center: { async limitsFor() { return {}; } } } };
  assert.equal(await limiteDoPlano.checar(app, "marlon", "people", async () => 9999), null);
});

test("limite gravado torto é ignorado, e não vira zero", async () => {
  // Um `people: -3` ou `people: "muitos"` no banco não pode desligar o módulo:
  // seria trancar um cliente por causa de um dado ruim nosso.
  for (const torto of [-3, "muitos", 1.5, NaN, true]) {
    const { app, contar } = monta({ people: torto }, 9999);
    assert.equal(
      await limiteDoPlano.checar(app, "marlon", "people", contar),
      null,
      `limite ${String(torto)} deveria passar`
    );
  }
});

test("a resposta de barrado é 409, com o código e o teto", async () => {
  const { app, contar } = monta({ people: 2 }, 2);
  const resposta = { status: 0, corpo: null };
  const res = {
    status(c) { resposta.status = c; return res; },
    send(b) { resposta.corpo = b; },
  };
  // `t` devolve a chave: o que se prova aqui é o formato, não a tradução.
  const req = { instance: "marlon", t: (k) => k };

  const barrou = await limiteDoPlano.barrou(app, req, res, "people", contar);

  assert.equal(barrou, true);
  // 409 e não 403: não é falta de permissão, é o estado do mundo.
  assert.equal(resposta.status, 409);
  assert.equal(resposta.corpo.code, "plan_limit");
  assert.equal(resposta.corpo.limit, "people");
  assert.equal(resposta.corpo.max, 2);
});

test("quando passa, não responde nada — quem chama segue", async () => {
  const { app, contar } = monta({ people: null });
  let respondeu = false;
  const res = { status() { respondeu = true; return res; }, send() { respondeu = true; } };

  const barrou = await limiteDoPlano.barrou(app, { instance: "marlon", t: (k) => k }, res, "people", contar);

  assert.equal(barrou, false);
  assert.equal(respondeu, false);
});
