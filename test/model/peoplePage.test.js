const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const User_model = require("../../model/User_model.js");
const Link_model = require("../../model/Link_model.js");
const instanceContext = require("../../lib/instance.js");

// O CUSTO da lista de pessoas — o mesmo caso da lista de treinos.
//
// A junção com o vínculo é a parte cara: um `$expr` correlacionado por pessoa,
// que o Mongo não resolve por índice. Medido em produção com 215 pessoas: 32ms
// rodando antes do corte, 5ms rodando depois — porque aí são quinze junções em
// vez de 215.
//
// O que este teste protege não é o tempo, é a ORDEM DOS ESTÁGIOS, que é a razão
// do tempo. Um estágio caro voltar para antes do corte não quebra nada e só
// aparece quando a lista cresce.
//
// ── POR QUE AGORA RODA DENTRO DE UM CONTEXTO ──────────────────────────────
//
// Desde o banco único, a sub-pipeline do `$lookup` escreve o cliente à mão — é o
// único lugar do sistema que faz isso, porque `lib/escopo.js` não alcança dentro
// de um `$lookup`. Então o modelo passou a exigir contexto de instância aqui,
// como todo o resto já exigia em produção: nenhuma rota fechada roda fora de um.
//
// `chamar()` embrulha as chamadas em vez de cada teste lembrar do `run`.
// Toda chamada ao modelo passa por aqui: em produção o middleware já
// estabeleceu o cliente antes de qualquer handler.
function chamar(fn) {
  return instanceContext.run("marlon", fn);
}

function fakeModel({ pessoas = 3 } = {}) {
  const pipelines = [];
  const pedidos = [];
  const ids = Array.from({ length: pessoas }, () => new ObjectId());

  const model = new User_model({
    api: {
      link: {
        async personIdsOf(trainerId, filtros) {
          pedidos.push(filtros);
          return ids;
        },
      },
    },
  });

  model.collection = async () => ({
    aggregate(pipeline, opcoes) {
      pipelines.push({ pipeline, opcoes });
      return {
        async toArray() {
          return [{ rows: [], total: [{ n: pessoas }] }];
        },
      };
    },
  });

  return { model, pipelines, pedidos, ids };
}

const TRAINER = new ObjectId();

function dasLinhas(pipeline) {
  return pipeline.find((e) => e.$facet).$facet.rows;
}

function antesDoCorte(pipeline) {
  const linhas = dasLinhas(pipeline);
  const corte = linhas.findIndex((e) => e.$limit !== undefined);
  assert.notEqual(corte, -1, "sem $limit não há página");
  return [...pipeline.filter((e) => !e.$facet), ...linhas.slice(0, corte)];
}

const texto = (estagios) => JSON.stringify(estagios);

test("a junção com o vínculo acontece depois do corte", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { page: 1, limit: 15 }));

  assert.ok(!texto(antesDoCorte(pipelines[0].pipeline)).includes("$lookup"));
  assert.ok(texto(dasLinhas(pipelines[0].pipeline)).includes("$lookup"), "mas ela acontece");
});

test("filtrar por ativo acontece no VÍNCULO, não no pipeline", async () => {
  // O status mora no vínculo, e a lista de vínculos já é carregada para saber
  // quem é da lista do profissional. Filtrar ali sai de graça; filtrar no
  // pipeline obrigaria a juntar o vínculo das 215 pessoas antes de escolher
  // quinze — os 30ms que este caminho existe para não pagar.
  const { model, pipelines, pedidos } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { active: "0" }));

  assert.deepEqual(pedidos[0], { active: "0" });
  assert.ok(!texto(antesDoCorte(pipelines[0].pipeline)).includes("$lookup"));
  assert.ok(!texto(pipelines[0].pipeline).includes('"active":0'), "o pipeline nem filtra");
});

test("sem filtro de status, o vínculo é pedido sem filtro", async () => {
  const { model, pedidos } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, {}));

  assert.deepEqual(pedidos[0], { active: undefined });
});

test("ordenar por ativo também sobe a junção", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { sort: "status", dir: "asc" }));

  assert.ok(texto(antesDoCorte(pipelines[0].pipeline)).includes("$lookup"));
  assert.equal(JSON.stringify(pipelines[0].pipeline).split("$lookup").length - 1, 1, "uma vez só");
});

test("ordenar por nome NÃO sobe a junção", async () => {
  // O caso comum, e o que a tela abre: não há razão para juntar o vínculo de
  // duzentas pessoas para mostrar quinze.
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { sort: "name", dir: "asc" }));

  assert.ok(!texto(antesDoCorte(pipelines[0].pipeline)).includes("$lookup"));
});

test("hasAccess fica antes do corte — é ordenação e não custa junção", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { sort: "access" }));

  assert.ok(texto(antesDoCorte(pipelines[0].pipeline)).includes("hasAccess"));
});

test("`access=1` filtra no BANCO, e antes do corte", async () => {
  // Filtrar quem tem login no NAVEGADOR foi o defeito que este filtro conserta:
  // a tela pedia uma página de pessoas e descartava metade dela, o que faz uma
  // página de vinte virar uma lista de três — e a de trás não existir.
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { access: "1" }));

  const antes = antesDoCorte(pipelines[0].pipeline);
  assert.ok(texto(antes).includes('"hasAccess":true'), "o filtro entra antes do $sort");
});

test("sem `access`, ninguém é descartado por não ter login", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, {}));

  assert.ok(!texto(pipelines[0].pipeline).includes('"hasAccess":true'));
});

test("senha e salt nunca saem, ordene por onde ordenar", async () => {
  for (const sort of ["name", "status", "access", "contact"]) {
    const { model, pipelines } = fakeModel();
    await chamar(() => model.pageStudents(TRAINER, { sort }));

    const projecao = dasLinhas(pipelines[0].pipeline).find((e) => e.$project);
    assert.equal(projecao.$project.password, 0, sort);
    assert.equal(projecao.$project.salt, 0, sort);
    assert.equal(projecao.$project.vinculo, 0, sort);
  }
});

test("sem ninguém na lista, nem consulta o banco", async () => {
  const { model, pipelines } = fakeModel({ pessoas: 0 });
  const saida = await chamar(() => model.pageStudents(TRAINER, {}));

  assert.deepEqual(saida, { rows: [], total: 0 });
  assert.equal(pipelines.length, 0);
});

// ── O filtro que mudou de lugar ───────────────────────────────────────────

function fakeLinks(docs) {
  const model = new Link_model({});
  model.collection = async () => ({
    find(query) {
      return {
        async toArray() {
          return docs.filter((d) =>
            Object.entries(query).every(([k, v]) => String(d[k]) === String(v))
          );
        },
      };
    },
  });
  return model;
}

const P1 = new ObjectId();
const P2 = new ObjectId();
const P3 = new ObjectId();

const VINCULOS = [
  { professional: TRAINER, person: P1, active: 1 },
  { professional: TRAINER, person: P2, active: 0 },
  // Vínculo criado antes do campo existir: sem `active` nenhum.
  { professional: TRAINER, person: P3 },
];

test("sem filtro, vêm todos os vínculos", async () => {
  const ids = await fakeLinks(VINCULOS).personIdsOf(TRAINER);
  assert.deepEqual(ids.map(String), [P1, P2, P3].map(String));
});

test("ativo é tudo que não é exatamente 0 — vínculo antigo continua na lista", async () => {
  // A mesma regra do `activeOf`. Tratar campo ausente como inativo faria sumir
  // da lista todo mundo cadastrado antes do status existir.
  const ids = await fakeLinks(VINCULOS).personIdsOf(TRAINER, { active: "1" });
  assert.deepEqual(ids.map(String), [P1, P3].map(String));
});

test("inativo é só quem foi marcado como inativo", async () => {
  const ids = await fakeLinks(VINCULOS).personIdsOf(TRAINER, { active: "0" });
  assert.deepEqual(ids.map(String), [P2].map(String));
});

test("string vazia não é filtro — é o que a tela manda quando o filtro está limpo", async () => {
  const ids = await fakeLinks(VINCULOS).personIdsOf(TRAINER, { active: "" });
  assert.equal(ids.length, 3);
});

test("a ordenação usa a collation do português", async () => {
  // É ela que faz "Ávila" cair perto de "Avila", e não depois de "Zanetti".
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { sort: "name" }));

  assert.equal(pipelines[0].opcoes.collation.locale, "pt");
});

// ── Os filtros do painel (13/09/2026) ─────────────────────────────────────
//
// Três são de campo e um é de relação. O de relação — "treino vencido" — é o
// único que obriga uma junção ANTES do corte, porque ele decide quem entra na
// página. Daí a regra que estes testes protegem: ele só existe quando é pedido.

test("sem filtro de treino, a consulta continua sendo a de antes", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, {}));

  assert.ok(!texto(pipelines[0].pipeline).includes("workouts"), "nenhuma junção com treinos");
});

test("`workout=expired` é quem já teve treino e não tem nenhum vigente", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { workout: "expired" }));

  const antes = antesDoCorte(pipelines[0].pipeline);
  assert.ok(texto(antes).includes('"from":"workouts"'), "a junção sobe: ela escolhe quem entra");
  assert.ok(texto(antes).includes('"treinosEmDia":0'));
  assert.ok(texto(antes).includes('"treinosTotal":{"$gt":0}'), "e exige ter tido algum");
});

test("`workout=none` é quem nunca teve treino", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { workout: "none" }));

  assert.ok(texto(antesDoCorte(pipelines[0].pipeline)).includes('"treinosTotal":0'));
});

test("`workout=current` é quem tem pelo menos um vigente", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { workout: "current" }));

  assert.ok(texto(antesDoCorte(pipelines[0].pipeline)).includes('"treinosEmDia":{"$gt":0}'));
});

test("valor de treino que não existe não filtra nada", async () => {
  // Chega pela URL; qualquer um pode digitar. "invente" não pode virar uma
  // lista vazia sem explicação — nem uma junção paga à toa.
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { workout: "invente" }));

  assert.ok(!texto(pipelines[0].pipeline).includes("workouts"));
});

test("as contagens de treino são andaime: não saem na resposta", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { workout: "expired" }));

  const projecao = dasLinhas(pipelines[0].pipeline).find((e) => e.$project);
  assert.equal(projecao.$project.treinos, 0);
  assert.equal(projecao.$project.treinosTotal, 0);
  assert.equal(projecao.$project.treinosEmDia, 0);
});

test("`access=0` é quem AINDA NÃO tem login", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() => model.pageStudents(TRAINER, { access: "0" }));

  assert.ok(texto(antesDoCorte(pipelines[0].pipeline)).includes('"hasAccess":false'));
});

// ── O período de cadastro, e o fuso ───────────────────────────────────────

test("o dia escolhido é o do RELÓGIO da conta, não o do servidor", async () => {
  // O servidor roda em UTC. Sem passar pelo fuso, quem foi cadastrado às 21h em
  // Brasília fica gravado como 00h do dia seguinte e sumiria de um filtro que
  // termina no dia dele.
  const { model } = fakeModel();
  const faixa = await model.periodoDeCadastro({ createdFrom: "2026-09-01" });

  assert.equal(faixa.$gte.toISOString(), "2026-09-01T03:00:00.000Z");
});

test("o fim do período é a meia-noite do dia SEGUINTE", async () => {
  // `$lte` do próprio dia pararia em 00:00 e deixaria o dia inteiro de fora —
  // "até 13/09" não mostraria ninguém cadastrado no dia 13.
  const { model } = fakeModel();
  const faixa = await model.periodoDeCadastro({ createdTo: "2026-09-13" });

  assert.equal(faixa.$lt.toISOString(), "2026-09-14T03:00:00.000Z");
  assert.equal(faixa.$gte, undefined, "só o fim veio, só o fim entra");
});

test("o último dia do mês vira o primeiro do mês seguinte", async () => {
  const { model } = fakeModel();
  const faixa = await model.periodoDeCadastro({ createdTo: "2026-09-30" });

  assert.equal(faixa.$lt.toISOString(), "2026-10-01T03:00:00.000Z");
});

test("data em branco ou torta não vira filtro", async () => {
  const { model } = fakeModel();

  assert.equal(await model.periodoDeCadastro({}), undefined);
  assert.equal(await model.periodoDeCadastro({ createdFrom: "" }), undefined);
  assert.equal(await model.periodoDeCadastro({ createdFrom: "ontem" }), undefined);
  assert.equal(await model.periodoDeCadastro({ createdTo: "13/09/2026" }), undefined);
});

test("o período entra antes do corte — ele decide quem entra na página", async () => {
  const { model, pipelines } = fakeModel();
  await chamar(() =>
    model.pageStudents(TRAINER, { createdFrom: "2026-09-01", createdTo: "2026-09-13" })
  );

  assert.ok(texto(antesDoCorte(pipelines[0].pipeline)).includes("createdAt"));
  assert.ok(!texto(antesDoCorte(pipelines[0].pipeline)).includes("$lookup"), "e sem junção");
});
