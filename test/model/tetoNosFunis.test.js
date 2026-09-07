const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const Workout_model = require("../../model/Workout_model.js");
const Diet_model = require("../../model/Diet_model.js");
const { limparRefeicao } = require("../../model/Diet_model.js");
const tetos = require("../../lib/tetosEstruturais.js");

// A REDE EMBAIXO: o corte no funil que grava, sem plano e sem rede.
//
// A rota recusa com 409 antes de chegar aqui — é ela que dá a resposta e abre a
// vitrine de planos. Este arquivo protege o que sobra quando a rota não é o
// caminho: uma rota nova amanhã, uma importação, um script de migração, ou
// `saveMeals` chamado de dentro de "aplicar modelo de dieta", que não passa pela
// checagem de plano nenhuma.
//
// É o que impede "9999 alimentos via API" de virar um documento que toda leitura
// daquele plano vai percorrer, para sempre.

function colecaoFalsa(doc) {
  return {
    gravado: null,
    async updateOne(query, update) {
      this.gravado = update.$set;
      return { matchedCount: doc ? 1 : 0 };
    },
    async findOne() {
      return doc;
    },
  };
}

const TRAINER = new ObjectId();
const ID = new ObjectId();

test("alimentos por refeição são cortados no absoluto, em qualquer caminho", () => {
  // `limparRefeicao` é o funil ÚNICO das dietas E dos modelos de dieta — o
  // DietTemplate_model importa esta mesma função.
  const r = limparRefeicao(
    { name: "Ataque", foods: Array.from({ length: 9999 }, (_, i) => ({ name: "x" + i })) },
    0
  );

  assert.equal(r.foods.length, tetos.absoluto("foodsPerMeal"));
  assert.equal(r.foods.length, 100);
  // Corta o EXCEDENTE, e mantém os primeiros: o que a pessoa montou primeiro é
  // o que ela vê no topo da tela.
  assert.equal(r.foods[0].name, "x0");
});

test("refeições por dieta são cortadas — a outra ponta do mesmo ataque", async () => {
  const col = colecaoFalsa({ _id: ID });
  const model = new Diet_model({ crypto });
  model.collection = async () => col;

  const muitas = Array.from({ length: 500 }, (_, i) => ({ name: "R" + i, foods: [] }));
  await model.saveMeals(TRAINER, ID, muitas);

  // Sem este corte, 9.999 refeições de um alimento cada dariam o mesmo
  // documento gigante que 9.999 alimentos numa refeição.
  assert.equal(col.gravado.meals.length, tetos.absoluto("mealsPerDiet"));
  assert.equal(col.gravado.meals.length, 100);
});

test("exercícios e séries são cortados no mesmo save", async () => {
  const col = colecaoFalsa({ _id: ID, trainer: TRAINER });
  const model = new Workout_model({ crypto });
  model.workoutsCollection = async () => col;

  // 300 × 100 e não 9.999 × 9.999: o segundo é cem MILHÕES de objetos, e a
  // primeira versão deste teste matou o node por falta de memória — o teste
  // virou o próprio ataque que ele descreve. O que se prova é o corte, e para
  // isso basta passar do teto (200 e 50).
  const exercicios = Array.from({ length: 300 }, (_, i) => ({
    name: "E" + i,
    sets: Array.from({ length: 100 }, () => ({ unit: "reps", quantity: "10" })),
  }));

  await model.saveExercises(TRAINER, ID, exercicios);

  assert.equal(col.gravado.exercises.length, tetos.absoluto("exercisesPerWorkout"));
  assert.equal(col.gravado.exercises.length, 200);
  // As séries de CADA exercício, e não só do primeiro: o corte está dentro do
  // `map`, e um corte só na lista de fora deixaria 200 exercícios de 9.999
  // séries — pior que o que se queria evitar.
  for (const e of col.gravado.exercises) {
    assert.equal(e.sets.length, tetos.absoluto("setsPerExercise"));
  }
});

test("o que cabe passa intacto — o teto não mexe no uso normal", async () => {
  const col = colecaoFalsa({ _id: ID, trainer: TRAINER });
  const model = new Workout_model({ crypto });
  model.workoutsCollection = async () => col;

  // O maior treino real de produção: 7 exercícios, 4 séries.
  const reais = Array.from({ length: 7 }, (_, i) => ({
    name: "E" + i,
    sets: Array.from({ length: 4 }, () => ({ unit: "reps", quantity: "10" })),
  }));

  await model.saveExercises(TRAINER, ID, reais);

  assert.equal(col.gravado.exercises.length, 7);
  assert.equal(col.gravado.exercises[0].sets.length, 4);
});
