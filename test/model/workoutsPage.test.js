const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Workout_model = require("../../model/Workout_model.js");

// O CUSTO da lista geral de treinos.
//
// A tela sempre mostrou quinze linhas e sempre recebeu quinze — o corte é do
// banco. O que não era verdade é que o trabalho fosse de quinze: o pipeline
// juntava a pessoa, somava séries e reunia grupos musculares dos 638 treinos
// para jogar 623 fora no estágio seguinte. Medido no servidor de produção com
// 638 treinos: 65ms por requisição, 6ms depois de mover o cálculo para depois
// do $limit — e 22ms no único caso que não dá para mover, a ordenação por nome
// da pessoa.
//
// Isto aqui não mede tempo: mede a ORDEM DOS ESTÁGIOS, que é a razão do tempo.
// Um estágio caro voltar para antes do corte é justamente o tipo de coisa que
// não quebra teste nenhum e só aparece quando a lista cresce.
function fakeModel({ rows = [], counts = [], total = 15 } = {}) {
  const pipelines = [];

  const model = new Workout_model({});
  model.workoutsCollection = async () => ({
    aggregate(pipeline, opcoes) {
      pipelines.push({ pipeline, opcoes });
      return {
        async toArray() {
          return [{ pagina: rows, counts, total: [{ n: total }] }];
        },
      };
    },
  });

  return { model, pipelines };
}

const TRAINER = new ObjectId();

// Os estágios do $facet que montam a página, em ordem.
function daPagina(pipeline) {
  const facet = pipeline.find((e) => e.$facet);
  return facet.$facet.pagina;
}

function nomes(estagios) {
  return estagios.map((e) => Object.keys(e)[0]);
}

// Onde o corte acontece, e o que veio antes dele em TODO o pipeline.
function antesDoCorte(pipeline) {
  const daFacet = daPagina(pipeline);
  const corte = nomes(daFacet).indexOf("$limit");
  assert.notEqual(corte, -1, "sem $limit não há página");
  return [...pipeline.filter((e) => !e.$facet), ...daFacet.slice(0, corte)];
}

const texto = (estagios) => JSON.stringify(estagios);

test("nada que percorra exercício roda antes do corte", async () => {
  // `setCount` soma as séries de cada exercício e `muscleGroups` reúne os grupos
  // — os dois percorrem o array inteiro do treino. Rodar isso em 638 documentos
  // para mostrar quinze é o desperdício que este teste existe para pegar.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { status: "current", page: 1, limit: 15 });

  const antes = texto(antesDoCorte(pipelines[0].pipeline));
  assert.ok(!antes.includes("setCount"), "somar séries tem de ser depois do corte");
  assert.ok(!antes.includes("muscleGroups"), "reunir grupos tem de ser depois do corte");
  assert.ok(!antes.includes("$sortArray"), "ordenar array tem de ser depois do corte");
});

test("na ordenação normal, a junção com a pessoa também fica depois do corte", async () => {
  // O $lookup era 47ms dos 65: uma junção por treino, 638 vezes, para usar
  // quinze nomes.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { status: "current", sort: "createdAt" });

  assert.ok(!texto(antesDoCorte(pipelines[0].pipeline)).includes("$lookup"));
  assert.ok(texto(daPagina(pipelines[0].pipeline)).includes("$lookup"), "mas ela acontece");
});

test("ordenando por pessoa, a junção sobe — não dá para ordenar pelo que não existe", async () => {
  // O único caso que não tem como cortar antes: escolher as quinze primeiras
  // por um campo que só existe depois da junção. Continua valendo mover o resto.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { status: "current", sort: "person", dir: "asc" });

  const antes = texto(antesDoCorte(pipelines[0].pipeline));
  assert.ok(antes.includes("$lookup"), "a junção precisa vir antes");
  assert.ok(antes.includes("personName"));
  assert.ok(!antes.includes("setCount"), "o resto continua depois");

  // E a junção não pode aparecer DUAS vezes: seria juntar tudo e juntar de novo.
  const todos = JSON.stringify(pipelines[0].pipeline);
  assert.equal(todos.split("$lookup").length - 1, 1);
});

test("a junção é a forma indexada — sem sub-pipeline", async () => {
  // `localField/foreignField` com `pipeline` junto desliga a junção indexada do
  // Mongo: 46ms contra 15ms para a mesma junção, medido no 8.0. Quem "arrumar"
  // isso projetando só o nome lá dentro devolve o custo sem que nada quebre.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, {});

  const lookup = JSON.stringify(pipelines[0].pipeline).match(/"\$lookup":\{[^}]*\}/)[0];
  assert.ok(lookup.includes('"localField":"student"'));
  assert.ok(!lookup.includes("pipeline"), lookup);
});

test("o documento da pessoa é DESCARTADO antes de sair", async () => {
  // A junção sem sub-pipeline traz o documento inteiro — senha e salt inclusive.
  // Quem tira é o $project do fim, e tirar aquele `pessoa: 0` vazaria hash de
  // senha para o navegador.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, {});

  const projecao = daPagina(pipelines[0].pipeline).find((e) => e.$project);
  assert.equal(projecao.$project.pessoa, 0);
  assert.equal(projecao.$project.exercises, 0, "os exercícios também não vão na lista");
});

test("as contagens das abas contam TODO mundo, não só a página", async () => {
  // A aba "Passados" precisa saber quantos atuais existem para escrever o número
  // no botão ao lado — por isso o $group fica fora do filtro de aba.
  const { model, pipelines } = fakeModel({
    counts: [
      { _id: "current", n: 206 },
      { _id: "past", n: 234 },
      { _id: "future", n: 198 },
    ],
    total: 206,
  });

  const saida = await model.pageAll(TRAINER, { status: "current" });

  assert.deepEqual(saida.counts, { current: 206, past: 234, future: 198, all: 638 });
  assert.equal(saida.total, 206);
});

test("o corte pede a página certa ao banco", async () => {
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { page: 3, limit: 15 });

  const estagios = daPagina(pipelines[0].pipeline);
  assert.equal(estagios.find((e) => e.$skip !== undefined).$skip, 30);
  assert.equal(estagios.find((e) => e.$limit !== undefined).$limit, 15);
});

test("limite absurdo é contido antes de virar consulta", async () => {
  // Sem teto, `?limit=999999` devolveria a coleção inteira com os exercícios de
  // fora — grande o bastante para derrubar a resposta.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { limit: 999999 });

  assert.equal(daPagina(pipelines[0].pipeline).find((e) => e.$limit !== undefined).$limit, 200);
});
