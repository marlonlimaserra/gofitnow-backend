const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Diet_model = require("../../model/Diet_model.js");

// A LISTA GERAL DE DIETAS — o que ela promete, e o que quebraria calado.
//
// Três coisas são testadas aqui, e nenhuma delas quebra sozinha em produção com
// um erro na tela:
//
//   1. A situação do plano (vigente / futuro / encerrado) sai de comparar TEXTO
//      de data. Plano sem fim guarda string vazia, e "" é menor que qualquer
//      data: sem um teste, todo plano em aberto — o caso mais comum — apareceria
//      como encerrado, e a lista pareceria só estar "meio vazia".
//
//   2. A junção com a pessoa tem de ficar DEPOIS do corte da página, senão ela
//      roda sobre os trezentos planos da conta para jogar duzentos e oitenta e
//      oito fora. É o erro que a lista de treinos já pagou, e ele não aparece
//      enquanto a conta é pequena.
//
//   3. As refeições NÃO saem daqui. Elas entram para virar total e são
//      descartadas. Se um dia alguém tirar o descarte, a resposta engorda em
//      silêncio — a tela continua funcionando, só fica lenta.

function fakeModel({ docs = [], total = 0, pessoas = [] } = {}) {
  const pipelines = [];
  const contagens = [];

  const model = new Diet_model({
    api: {
      user: {
        async collection() {
          return {
            find() {
              return { async toArray() { return pessoas; } };
            },
          };
        },
      },
    },
  });

  model.collection = async () => ({
    async countDocuments(consulta) {
      contagens.push(consulta);
      return total;
    },
    aggregate(pipeline) {
      pipelines.push(pipeline);
      return { async toArray() { return docs; } };
    },
  });

  return { model, pipelines, contagens };
}

const TRAINER = new ObjectId();
const nomes = (estagios) => estagios.map((e) => Object.keys(e)[0]);

function antesDoCorte(pipeline) {
  const corte = nomes(pipeline).indexOf("$limit");
  assert.notEqual(corte, -1, "sem $limit não há página");
  return pipeline.slice(0, corte);
}

// ── 1. A SITUAÇÃO ─────────────────────────────────────────────────────────

test("plano SEM data de fim não é um plano encerrado", async () => {
  // O teste que justifica o `$gt: ""` na consulta. Sem ele, `endDate: ""` casa
  // com `$lt: hoje` e o plano em aberto some da aba "vigentes".
  const { model } = fakeModel();
  const consulta = await model.consultaDe(TRAINER, { status: "past" });

  assert.equal(consulta.endDate.$gt, "", "sem o piso, string vazia conta como data antiga");
  assert.ok(consulta.endDate.$lt, "e ainda precisa comparar com hoje");
});

test("vigente é o que não é nem encerrado nem futuro", async () => {
  const { model } = fakeModel();
  const consulta = await model.consultaDe(TRAINER, { status: "current" });

  assert.equal(consulta.$nor.length, 2);
  // O mesmo piso vale aqui: sem ele, o `$nor` excluiria os planos em aberto.
  assert.equal(consulta.$nor[0].endDate.$gt, "");
  assert.ok(consulta.$nor[1].startDate.$gt);
});

test("sem status pedido, a consulta não filtra por data nenhuma", async () => {
  const { model } = fakeModel();
  const consulta = await model.consultaDe(TRAINER, {});

  assert.deepEqual(Object.keys(consulta), ["trainer"]);
});

test("status inventado não vira filtro secreto", async () => {
  // Uma string qualquer na URL não pode virar uma lista misteriosamente vazia.
  const { model } = fakeModel();
  const consulta = await model.consultaDe(TRAINER, { status: "sei-la" });

  assert.deepEqual(Object.keys(consulta), ["trainer"]);
});

// ── 2. O CUSTO ────────────────────────────────────────────────────────────

test("a junção com a pessoa fica DEPOIS do corte", async () => {
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, {});

  assert.ok(!JSON.stringify(antesDoCorte(pipelines[0])).includes("$lookup"));
  assert.ok(nomes(pipelines[0]).includes("$lookup"));
});

test("ordenando pela pessoa, a junção sobe — não dá para ordenar pelo que não existe", async () => {
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { sort: "person" });

  assert.ok(JSON.stringify(antesDoCorte(pipelines[0])).includes("$lookup"));
});

test("o hash da senha da pessoa é descartado antes de sair", async () => {
  // O `$lookup` sem sub-pipeline traz o documento INTEIRO da pessoa — senha e
  // salt inclusive. Este `$project` é a única coisa entre o hash e a tela.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, {});

  const project = pipelines[0].find((e) => e.$project);
  assert.equal(project.$project.pessoa, 0);
});

// ── 3. A RESPOSTA ─────────────────────────────────────────────────────────

test("as refeições viram totais e NÃO vão na resposta", async () => {
  const { model } = fakeModel({
    docs: [
      {
        _id: new ObjectId(),
        student: new ObjectId(),
        name: "Low carb",
        startDate: "",
        endDate: "",
        meals: [
          { time: "08:00", name: "Café", foods: [{ name: "Ovo", kcal: 70, protein: 6 }] },
          { time: "12:00", name: "Almoço", foods: [{ name: "Arroz", kcal: 130, protein: 2 }] },
        ],
        personName: "Ana",
      },
    ],
    total: 1,
  });

  const { rows } = await model.pageAll(TRAINER, {});

  assert.equal(rows[0].meals, undefined, "a lista não carrega as refeições");
  assert.equal(rows[0].totals.kcal, 200, "mas carrega o total delas");
  assert.equal(rows[0].totals.protein, 8);
  assert.equal(rows[0].mealCount, 2);
  assert.equal(rows[0].student.name, "Ana");
});

test("substituição conta UMA vez no total da lista", async () => {
  // "Pão OU tapioca" é uma escolha, não duas refeições. A regra mora em
  // `principais()`, e este teste é o que garante que a lista geral passe por ela
  // em vez de somar tudo por conta própria.
  const { model } = fakeModel({
    docs: [
      {
        _id: new ObjectId(),
        student: new ObjectId(),
        meals: [
          {
            time: "08:00",
            foods: [
              { name: "Pão", kcal: 100, group: 1 },
              { name: "Tapioca", kcal: 300, group: 1 },
            ],
          },
        ],
      },
    ],
    total: 1,
  });

  const { rows } = await model.pageAll(TRAINER, {});
  assert.equal(rows[0].totals.kcal, 100);
});

test("a contagem por situação usa os MESMOS filtros da lista, menos o status", async () => {
  // Senão o botão diria "12 vigentes" e a lista filtrada mostraria três — o
  // número passaria a ser de outra pergunta.
  const { model, contagens } = fakeModel();
  await model.contarPorStatus(TRAINER, { status: "past", search: "ana" });

  // Quatro contagens: vigente, encerrado, futuro e o total.
  assert.equal(contagens.length, 4);
  // Nenhuma delas herdou o "past" que veio no pedido...
  const semStatus = contagens[3];
  assert.equal(semStatus.endDate, undefined);
  assert.equal(semStatus.startDate, undefined);
  // ...e todas mantiveram a busca.
  assert.ok(contagens.every((c) => c.$and));
});

test("busca acha pelo nome do PLANO, e não só pelo da pessoa", async () => {
  // "Low carb" é como o profissional chama o que ele montou; procurar por isso e
  // não achar nada seria a busca não servir para o caso mais comum.
  const { model } = fakeModel({ pessoas: [] });
  const consulta = await model.consultaDe(TRAINER, { search: "low carb" });

  const alternativas = consulta.$and[0].$or;
  assert.equal(alternativas.length, 1, "sem pessoa com esse nome, sobra o nome do plano");
  assert.ok(alternativas[0].name.$regex);
});
