const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Assessment_model = require("../../model/Assessment_model.js");

// O CUSTO — e a segurança — da lista geral de avaliações.
//
// A tela mostra vinte linhas e recebe vinte: o corte é do banco. Estes testes
// não medem tempo, medem a ORDEM DOS ESTÁGIOS, que é a razão do tempo — juntar a
// pessoa antes do `$limit` faria a junção rodar sobre todas as coletas da conta
// para jogar vinte fora. É o erro que a lista de treinos já pagou, e é o tipo de
// coisa que não quebra teste nenhum: só aparece quando a conta cresce.
//
// E um deles não é sobre custo: o `$lookup` sem sub-pipeline traz o documento
// INTEIRO da pessoa, senha e salt inclusive. O `$project` que descarta isso é a
// única coisa entre o hash e a tela.
function fakeModel({ docs = [], total = 0, pessoas = [] } = {}) {
  const pipelines = [];
  const consultas = [];

  const model = new Assessment_model({
    api: {
      user: {
        async collection() {
          return {
            find(consulta, opcoes) {
              consultas.push({ consulta, opcoes });
              return { async toArray() { return pessoas; } };
            },
          };
        },
      },
    },
  });

  model.collection = async () => ({
    async countDocuments(consulta) {
      consultas.push({ count: consulta });
      return total;
    },
    aggregate(pipeline) {
      pipelines.push(pipeline);
      return { async toArray() { return docs; } };
    },
  });

  return { model, pipelines, consultas };
}

const TRAINER = new ObjectId();

const nomes = (estagios) => estagios.map((e) => Object.keys(e)[0]);

function antesDoCorte(pipeline) {
  const corte = nomes(pipeline).indexOf("$limit");
  assert.notEqual(corte, -1, "sem $limit não há página");
  return pipeline.slice(0, corte);
}

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
  // E uma só: subir a junção não pode significar juntar duas vezes.
  assert.equal(nomes(pipelines[0]).filter((n) => n === "$lookup").length, 1);
});

test("o documento da pessoa é DESCARTADO antes de sair", async () => {
  // Sem este `pessoa: 0`, o hash da senha de cada pessoa viaja para a tela.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, {});

  const projecao = pipelines[0].find((e) => e.$project);
  assert.equal(projecao.$project.pessoa, 0);
});

test("rascunho não entra, e a coleta é sempre do profissional que perguntou", async () => {
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, {});

  const match = pipelines[0][0].$match;
  assert.equal(String(match.trainer), String(TRAINER));
  assert.deepEqual(match.draft, { $ne: true });
});

test("a ordem padrão é da coleta mais nova para a mais antiga", async () => {
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, {});

  const sort = pipelines[0].find((e) => e.$sort).$sort;
  assert.equal(sort.date, -1);
});

test("coluna que o banco não conhece não vira ordenação — cai na data", async () => {
  // `bodyFat` é o caso real: o percentual depende do protocolo, da idade e do
  // sexo, e essas fórmulas moram no front. Aceitar o nome aqui ordenaria por um
  // campo inexistente, que é o mesmo que não ordenar — só que calado.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { sort: "bodyFat", dir: "asc" });

  const sort = pipelines[0].find((e) => e.$sort).$sort;
  assert.equal(sort.date, 1);
});

test("linha sem o campo vai para o FIM, ordenando para qualquer lado", async () => {
  // Uma coleta sem peso encabeçando "menor peso" seria a tela dizendo que
  // ninguém pesa menos do que quem não foi pesado.
  for (const dir of ["asc", "desc"]) {
    const { model, pipelines } = fakeModel();
    await model.pageAll(TRAINER, { sort: "weight", dir });

    const sort = pipelines[0].find((e) => e.$sort).$sort;
    assert.equal(Object.keys(sort)[0], "__vazio");
    assert.equal(sort.__vazio, 1);
  }
});

test("o IMC é peso sobre altura ao quadrado, com a altura em METROS", async () => {
  // A altura da coleta é gravada em metros. Este teste nasceu errado — pedia um
  // `/100` incondicional, que é o que o código fazia —, e o erro só não apareceu
  // na tela porque dividir toda altura pela mesma constante não muda a ORDEM.
  // Mudaria no dia em que uma conta tivesse documento das duas gerações.
  const { model, pipelines } = fakeModel();
  await model.pageAll(TRAINER, { sort: "bmi" });

  const calculado = pipelines[0].find((e) => e.$addFields && e.$addFields.imc);
  const formula = JSON.stringify(calculado.$addFields.imc);

  // O quadrado da altura, e não a altura dividida por cem elevada ao quadrado.
  assert.ok(formula.includes("$multiply"));
  assert.ok(formula.includes('"$$altura","$$altura"') || formula.includes('"$$altura", "$$altura"'));

  // O /100 sobrevive só como TOLERÂNCIA a documento antigo, atrás de um `> 3`.
  assert.ok(formula.includes('"$gt":["$height",3]') || formula.includes('"$gt": ["$height", 3]'));

  // Sem peso ou sem altura, `null` — e não um zero que se ordena como magreza.
  assert.ok(formula.includes("null"));
});

test("a busca por nome vira lista de ids ANTES, e não uma junção antes do corte", async () => {
  const p1 = new ObjectId();
  const { model, pipelines, consultas } = fakeModel({ pessoas: [{ _id: p1 }] });
  await model.pageAll(TRAINER, { search: "bru" });

  // O regex foi para `users`, não para o pipeline das coletas.
  const busca = consultas.find((c) => c.consulta?.name);
  assert.ok(busca.consulta.name.$regex);
  assert.equal(busca.opcoes.limit, 500);

  assert.deepEqual(pipelines[0][0].$match.student, { $in: [p1] });
  assert.ok(!JSON.stringify(antesDoCorte(pipelines[0])).includes("$lookup"));
});

test("busca sem ninguém não vira consulta nenhuma às coletas", async () => {
  const { model, pipelines } = fakeModel({ pessoas: [] });
  const r = await model.pageAll(TRAINER, { search: "zzz" });

  assert.deepEqual(r, { rows: [], total: 0 });
  assert.equal(pipelines.length, 0);
});

test("a pessoa sai montada na linha, com o que a tela precisa para calcular", async () => {
  const p1 = new ObjectId();
  const { model } = fakeModel({
    total: 1,
    docs: [
      {
        _id: "a1",
        student: p1,
        weight: 80,
        personName: "Bruna",
        personSex: "female",
        personBirthDate: "1990-03-01",
        personAvatarAt: null,
      },
    ],
  });

  const r = await model.pageAll(TRAINER, {});

  // Sexo e nascimento vão junto porque quem calcula gordura e IMC é a TELA.
  assert.deepEqual(r.rows[0].student, {
    _id: p1,
    name: "Bruna",
    sex: "female",
    birthDate: "1990-03-01",
    avatarAt: null,
  });
  // Os campos crus da junção não sobram na linha.
  assert.equal(r.rows[0].personName, undefined);
});

// ── EDITAR NÃO INVENTA A DATA ───────────────────────────────────────────────
//
// `limpar` é a lista fechada de campos, e o padrão dela ("sem data é hoje") está
// certo para o INSERT. No update era armadilha: um PUT sem `date` reescrevia a
// data da coleta para agora.
//
// O app de bolso faz exatamente isso — cria o rascunho e grava peso e medidas sem
// repetir a data. Hoje sai de graça porque o rascunho nasceu no mesmo instante; no
// dia em que ele ganhar um "editar", corrigir uma vírgula numa coleta de março a
// mudaria para hoje, e o gráfico de evolução mentiria.
test("PUT sem data NÃO mexe na data da coleta", async () => {
  const sets = [];
  const model = new Assessment_model({});
  model.collection = async () => ({
    async updateOne(filtro, update) {
      sets.push(update.$set);
      return { matchedCount: 1 };
    },
  });

  await model.update(TRAINER, new ObjectId(), { weight: 78, note: "ok" });

  assert.ok(!("date" in sets[0]), "a data não pode entrar no $set");
  assert.equal(sets[0].weight, 78);
});

test("PUT COM data grava a data que veio", async () => {
  const sets = [];
  const model = new Assessment_model({});
  model.collection = async () => ({
    async updateOne(filtro, update) {
      sets.push(update.$set);
      return { matchedCount: 1 };
    },
  });

  await model.update(TRAINER, new ObjectId(), { date: "2026-03-15", weight: 78 });

  assert.equal(sets[0].date.toISOString().slice(0, 10), "2026-03-15");
});

test("criar SEM data continua sendo hoje — o padrão do insert não mudou", async () => {
  const docs = [];
  const model = new Assessment_model({});
  model.collection = async () => ({
    async insertOne(doc) {
      docs.push(doc);
      return { insertedId: "a1" };
    },
  });

  await model.insert(TRAINER, new ObjectId(), { weight: 78 });

  assert.ok(docs[0].date instanceof Date);
});
