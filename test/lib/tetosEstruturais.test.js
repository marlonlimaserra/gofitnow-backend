const test = require("node:test");
const assert = require("node:assert/strict");

const tetos = require("../../lib/tetosEstruturais.js");
const limiteDoPlano = require("../../lib/limiteDoPlano.js");
const photoSides = require("../../lib/assessmentPhotoSides.js");

// QUANTOS CABEM DENTRO DE UM, e quem segura isso.
//
// "Vai que alguém resolve colocar 9999 alimentos via API numa refeição para
// derrubar o sistema."
//
// O que estes testes protegem é a coisa que a leitura do código NÃO mostra: que
// existem DUAS camadas com trabalhos diferentes, e que a de baixo continua de pé
// quando a de cima não responde. Um refactor que unificasse as duas — "isto está
// duplicado" — desfaria a proteção inteira e passaria em todo outro teste.

function monta(limites) {
  return { api: { center: { async limitsFor() { return limites; } } } };
}

// O `res` mínimo que `barrouQuantidade` usa, e que registra o que foi respondido.
function resposta() {
  const r = { codigo: null, corpo: null };
  r.status = (n) => {
    r.codigo = n;
    return r;
  };
  r.send = (c) => {
    r.corpo = c;
    return r;
  };
  return r;
}

const req = (limites) => ({
  instance: "marlon",
  // O `t` de teste devolve a chave e os valores, que é o suficiente para provar
  // QUAL frase foi escolhida e com que número.
  t: (chave, vars) => `${chave}:${vars ? JSON.stringify(vars) : ""}`,
  _limites: limites,
});

test("o padrão vale quando o plano não diz nada", () => {
  assert.equal(tetos.doPlano({}, "foodsPerMeal"), 30);
  assert.equal(tetos.doPlano({ foodsPerMeal: null }, "foodsPerMeal"), 30);
  assert.equal(tetos.doPlano({ foodsPerMeal: undefined }, "foodsPerMeal"), 30);
});

// ── ESTE É O TESTE QUE DÁ SENTIDO AO ARQUIVO INTEIRO ────────────────────────
//
// `lib/limiteDoPlano.js` falha ABERTO: central caída, `limitsFor` devolve `{}` e
// todo limite comercial deixa de existir. Se o teto anti-abuso morasse só lá, o
// ataque passaria justamente com o painel fora do ar.
test("central fora do ar NÃO libera o teto — vale o padrão, nunca ilimitado", () => {
  for (const caido of [{}, null, undefined]) {
    assert.equal(tetos.doPlano(caido, "foodsPerMeal"), 30);
    assert.equal(tetos.doPlano(caido, "exercisesPerWorkout"), 50);
    assert.equal(tetos.doPlano(caido, "setsPerExercise"), 20);
    assert.equal(tetos.doPlano(caido, "photoSides"), 12);
  }
});

test("o plano APERTA, e não afrouxa", () => {
  // Abaixo do máximo, o plano manda.
  assert.equal(tetos.doPlano({ foodsPerMeal: 10 }, "foodsPerMeal"), 10);

  // Acima, é cortado. Um 9.999 digitado por engano no painel não abre porta.
  assert.equal(tetos.doPlano({ foodsPerMeal: 9999 }, "foodsPerMeal"), 100);
  assert.equal(tetos.doPlano({ setsPerExercise: 9999 }, "setsPerExercise"), 50);
});

test("valor sem sentido no plano cai no padrão, e não em zero", () => {
  // Zero, negativo e texto. O pior caso de cair no padrão é um cliente usar mais
  // do que comprou; o de cair em zero é uma conta que não grava dieta nenhuma.
  for (const ruim of [0, -5, 1.5, "trinta", true, {}]) {
    assert.equal(tetos.doPlano({ foodsPerMeal: ruim }, "foodsPerMeal"), 30, String(ruim));
  }
});

test("os padrões cabem no maior uso REAL de produção, com folga", () => {
  // Medido em 04/09/2026: 5 alimentos na maior refeição, 4 refeições na maior
  // dieta, 7 exercícios no maior treino, 4 séries no exercício mais carregado.
  // Um teto abaixo do uso real é um cliente quebrado no dia do deploy.
  const REAL = { foodsPerMeal: 5, mealsPerDiet: 4, exercisesPerWorkout: 7, setsPerExercise: 4 };

  for (const [chave, usado] of Object.entries(REAL)) {
    assert.ok(
      tetos.padraoDe(chave) >= usado * 3,
      `${chave}: padrão ${tetos.padraoDe(chave)} é pouco para uso real de ${usado}`
    );
  }
});

test("o máximo nunca é menor que o padrão", () => {
  // Seria um padrão inalcançável: quem não configurar nada já estaria acima do
  // absoluto, e `cortar` desfaria o que `doPlano` acabou de permitir.
  for (const chave of Object.keys(tetos.TETOS)) {
    assert.ok(tetos.absoluto(chave) >= tetos.padraoDe(chave), chave);
  }
});

test("cortar respeita o ABSOLUTO, e não o padrão nem o plano", () => {
  // `cortar` não recebe plano nenhum de propósito: é chamado de dentro de função
  // pura, sem I/O. Ele é a rede embaixo, e a rede é o número absoluto.
  const cem = Array.from({ length: 150 }, (_, i) => i);
  assert.equal(tetos.cortar(cem, "foodsPerMeal").length, 100);
  assert.equal(tetos.cortar(cem, "setsPerExercise").length, 50);

  // Lista que cabe volta intacta, e é a MESMA lista — sem cópia à toa em todo
  // save do sistema.
  const dez = [1, 2, 3];
  assert.equal(tetos.cortar(dez, "foodsPerMeal"), dez);

  // O que não é lista vira lista vazia, e não estoura.
  assert.deepEqual(tetos.cortar(null, "foodsPerMeal"), []);
  assert.deepEqual(tetos.cortar("9999", "foodsPerMeal"), []);
});

test("chave desconhecida estoura, e isso é o certo", () => {
  // Um typo (`foodPerMeal`) que caísse em "sem limite" seria uma proteção que
  // não protege e não avisa. Estourar aparece no primeiro teste que rodar.
  assert.throws(() => tetos.absoluto("foodPerMeal"), /desconhecido/);
  assert.throws(() => tetos.cortar([1], "naoExiste"), /desconhecido/);
});

test("mealsPerDiet é teto duro, e NÃO é chave de plano", () => {
  // Ele entra junto porque 9.999 refeições de um alimento dão o mesmo documento
  // gigante que 9.999 alimentos numa refeição. Mas ninguém vende "até 40
  // refeições por dia", e um campo que não se vende envelhece sem ninguém notar.
  assert.ok(tetos.TETOS.mealsPerDiet, "o teto existe");
  assert.ok(!tetos.DO_PLANO.includes("mealsPerDiet"), "e não está no painel");
});

// ── O PORTÃO DA ROTA ───────────────────────────────────────────────────────

test("no teto exatamente, PASSA", async () => {
  // `>` e não `>=`, ao contrário dos outros limites. Os outros são checados antes
  // de criar mais um ("já tem 50, não pode a 51ª"); aqui o pedido chega inteiro,
  // e trinta com teto trinta é exatamente o que foi anunciado.
  const res = resposta();
  const barrou = await limiteDoPlano.barrouQuantidade(
    monta({ foodsPerMeal: 30 }),
    req(),
    res,
    "foodsPerMeal",
    30
  );

  assert.equal(barrou, false);
  assert.equal(res.codigo, null, "não deve responder nada quando passa");
});

test("um acima do teto responde 409 com o código que abre a vitrine", async () => {
  const res = resposta();
  const barrou = await limiteDoPlano.barrouQuantidade(
    monta({ foodsPerMeal: 30 }),
    req(),
    res,
    "foodsPerMeal",
    31
  );

  assert.equal(barrou, true);
  assert.equal(res.codigo, 409);
  // O MESMO `plan_limit` dos outros limites: é por ele que o dialog de planos
  // acende no frontend (lib/limiteDoPlano.jsx). Um código novo daria um erro
  // sem saída, que foi exatamente o que aquele dialog veio consertar.
  assert.equal(res.corpo.code, "plan_limit");
  assert.equal(res.corpo.limit, "foodsPerMeal");
  assert.equal(res.corpo.max, 30);
});

test("a frase leva o TETO QUE VALE, e não o que o plano digitou", async () => {
  // Plano com 9.999 é apertado para 100. Dizer "seu plano permite até 9999"
  // enquanto se recusa 150 seria uma mensagem que contradiz a própria recusa.
  const res = resposta();
  await limiteDoPlano.barrouQuantidade(
    monta({ foodsPerMeal: 9999 }),
    req(),
    res,
    "foodsPerMeal",
    150
  );

  assert.equal(res.corpo.max, 100);
  assert.match(res.corpo.msg, /"max":100/);
  assert.match(res.corpo.msg, /planLimitReached/);
});

test("com a central caída a rota ainda barra, pelo padrão", async () => {
  const res = resposta();
  const barrou = await limiteDoPlano.barrouQuantidade(monta({}), req(), res, "foodsPerMeal", 9999);

  assert.equal(barrou, true);
  assert.equal(res.corpo.max, 30);
});

test("tetoDoPlano responde o número, sem mexer no res", async () => {
  const app = monta({ photoSides: 4 });
  assert.equal(await limiteDoPlano.tetoDoPlano(app, "marlon", "photoSides"), 4);
  assert.equal(await limiteDoPlano.tetoDoPlano(monta({}), "marlon", "photoSides"), 12);
});

// ── O NÚMERO DAS CATEGORIAS DE FOTO MORA NUM LUGAR SÓ ──────────────────────

test("o MAXIMO dos ângulos vem do teto absoluto, e continua sendo 12", () => {
  // Ele era um `12` escrito à mão neste arquivo. Dois números iguais em dois
  // arquivos é um número que um dia diverge — e aqui a divergência seria a rota
  // recusando o que a normalização aceita, ou o contrário.
  assert.equal(photoSides.MAXIMO, tetos.absoluto("photoSides"));
  assert.equal(photoSides.MAXIMO, 12);
});

test("normalizar continua cortando no absoluto", () => {
  const muitos = Array.from({ length: 40 }, (_, i) => ({ label: "Angulo " + i }));
  assert.equal(photoSides.normalizar(muitos).length, 12);
});
