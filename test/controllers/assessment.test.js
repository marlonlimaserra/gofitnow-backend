const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const AssessmentController = require("../../controllers/Assessment.js");

const TRAINER = { _id: "t1", name: "Marlon", type: "trainer" };
const PESSOA = { _id: "p1", name: "Ana", sex: "female", birthDate: "1990-05-10" };

// A avaliação física nasce no banco no clique de "Nova medida" e vai sendo
// gravada campo a campo. Isso muda três regras de rota, e são elas que este
// arquivo protege:
//
//   1. criar não exige peso e altura — FECHAR exige;
//   2. gravar rascunho não escreve no histórico de ações;
//   3. havendo rascunho em aberto, criar devolve o mesmo em vez de outro.
//
// Errar qualquer uma passa despercebido na tela: o formulário continua abrindo
// e salvando. O que aparece é um histórico com trinta linhas por avaliação, ou
// uma ficha cheia de coletas vazias.
function monta({ existente, rascunhoEmAberto } = {}) {
  const chamadas = { insert: [], update: [], delete: [], fotosApagadas: [] };
  const permissao = permiteTudo(TRAINER);

  let guardado = existente;

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      user: {
        async dataStudent() {
          return PESSOA;
        },
      },
      assessment: {
        async draftOf() {
          return rascunhoEmAberto;
        },
        async data() {
          return guardado;
        },
        async insert(trainerId, studentId, obj) {
          chamadas.insert.push(obj);
          guardado = { _id: "a1", ...obj };
          return "a1";
        },
        async update(trainerId, id, obj) {
          chamadas.update.push(obj);
          guardado = { ...guardado, ...obj };
          return true;
        },
        async delete(trainerId, id) {
          chamadas.delete.push(id);
          return true;
        },
      },
      assessmentPhoto: {
        isSide: (s) => ["front", "right", "left", "back"].includes(s),
        async deleteAllOfAssessment(id) {
          chamadas.fotosApagadas.push(id);
          return 0;
        },
      },
      actionHistory: { diff: () => ({ weight: [70, 71] }) },
    },
  });

  AssessmentController(app);
  return { app, chamadas };
}

const acoes = (app) => app.registrados.map((r) => r.action);

test("criar uma coleta não exige peso nem altura", async () => {
  // A exigência chegaria antes de o campo existir: no clique de "Nova medida"
  // ninguém pesou ninguém ainda.
  const { app, chamadas } = monta();
  const res = await call(app, "post", "/people/p1/assessments", { body: {} });

  assert.equal(res.status, 201);
  assert.equal(chamadas.insert[0].draft, true);
});

test("abrir uma coleta não entra no histórico de ações", async () => {
  // Quem abriu um formulário ainda não fez nada. Registrar aqui contaria como
  // avaliação toda vez que alguém clicasse por curiosidade.
  const { app } = monta();
  await call(app, "post", "/people/p1/assessments", { body: {} });

  assert.deepEqual(acoes(app), []);
});

test("havendo rascunho em aberto, criar devolve o MESMO", async () => {
  // Sem isto, cada clique abandonado deixaria uma coleta vazia para trás e em
  // um mês a ficha teria mais rascunho que avaliação.
  const emAberto = { _id: "rascunho-1", draft: true };
  const { app, chamadas } = monta({ rascunhoEmAberto: emAberto });

  const res = await call(app, "post", "/people/p1/assessments", { body: {} });

  assert.equal(res.status, 200);
  assert.equal(res.body._id, "rascunho-1");
  assert.equal(chamadas.insert.length, 0);
});

test("gravar rascunho não escreve no histórico — nem a cada campo", async () => {
  // É o ponto do salvamento automático: são dezenas de PUTs por avaliação, e
  // registrar todos afogaria tudo o mais que a conta fez no dia.
  const { app, chamadas } = monta({ existente: { _id: "a1", draft: true, weight: null } });

  for (const peso of ["7", "70", "70.", "70.5"]) {
    const res = await call(app, "put", "/assessments/a1", {
      body: { draft: true, weight: peso },
    });
    assert.equal(res.status, 200);
  }

  assert.equal(chamadas.update.length, 4);
  assert.deepEqual(acoes(app), []);
});

test("rascunho pode ser gravado sem peso e sem altura", async () => {
  const { app } = monta({ existente: { _id: "a1", draft: true } });

  const res = await call(app, "put", "/assessments/a1", {
    body: { draft: true, circumferences: { waist: 70 } },
  });

  assert.equal(res.status, 200);
});

test("FECHAR a coleta exige peso e altura", async () => {
  // Sem os dois não há IMC, e sem IMC a avaliação não diz nada que a pessoa já
  // não soubesse.
  const { app } = monta({ existente: { _id: "a1", draft: true } });

  const res = await call(app, "put", "/assessments/a1", {
    body: { draft: false, weight: 71 },
  });

  assert.equal(res.status, 400);
});

test("fechar um rascunho é o que conta como CRIAR no histórico", async () => {
  const { app } = monta({ existente: { _id: "a1", draft: true, student: "p1" } });

  await call(app, "put", "/assessments/a1", {
    body: { draft: false, weight: 71, height: 1.7 },
  });

  assert.deepEqual(acoes(app), ["create_assessment"]);
});

test("editar uma coleta já fechada conta como atualizar, com diff", async () => {
  const { app } = monta({ existente: { _id: "a1", draft: false, weight: 70 } });

  await call(app, "put", "/assessments/a1", {
    body: { draft: false, weight: 71, height: 1.7 },
  });

  assert.deepEqual(acoes(app), ["update_assessment"]);
  assert.deepEqual(app.registrados[0].data.diff, { weight: [70, 71] });
});

test("descartar rascunho não é apagar avaliação", async () => {
  // Nada foi entregue a ninguém. Registrar seria contar como exclusão o fechar
  // de um formulário.
  const { app, chamadas } = monta({ existente: { _id: "a1", draft: true } });

  const res = await call(app, "delete", "/assessments/a1");

  assert.equal(res.status, 200);
  assert.deepEqual(chamadas.delete, ["a1"]);
  assert.deepEqual(acoes(app), []);
});

test("apagar uma avaliação fechada continua no histórico", async () => {
  const { app } = monta({ existente: { _id: "a1", draft: false, weight: 71 } });

  await call(app, "delete", "/assessments/a1");

  assert.deepEqual(acoes(app), ["delete_assessment"]);
});

test("apagar a coleta leva as fotos junto", async () => {
  // Elas são referenciadas pela avaliação. Deixá-las seria guardar megabytes
  // que nenhuma tela alcança e ninguém sabe que existem.
  const { app, chamadas } = monta({ existente: { _id: "a1", draft: false } });

  await call(app, "delete", "/assessments/a1");

  assert.deepEqual(chamadas.fotosApagadas, ["a1"]);
});

test("só existem quatro lados — qualquer outro é 404", async () => {
  // O teto de fotos por avaliação não é uma contagem que alguém checa: é o
  // formato da rota. Um lado inventado não cria vaga nova.
  const { app } = monta({ existente: { _id: "a1", draft: false } });

  const res = await call(app, "put", "/assessments/a1/photos/frente", {
    body: { image: "data:image/jpeg;base64,AAAA" },
  });

  assert.equal(res.status, 404);
});
