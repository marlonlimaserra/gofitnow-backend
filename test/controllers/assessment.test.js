const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const AssessmentController = require("../../controllers/Assessment.js");

const TRAINER = { _id: "t1", name: "Marlon", type: "trainer" };
// O cadastro dela tem peso e altura — é o que a coleta nova aproveita. A altura
// vem em CENTÍMETROS, como o formulário da pessoa a guarda.
const PESSOA = {
  _id: "p1",
  name: "Ana",
  sex: "female",
  birthDate: "1990-05-10",
  weight: 62,
  height: 165,
};

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
function monta({ existente, rascunhoEmAberto, pessoa = PESSOA } = {}) {
  const chamadas = { insert: [], update: [], delete: [], fotosApagadas: [] };
  const permissao = permiteTudo(TRAINER);

  let guardado = existente;

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      user: {
        async dataStudent() {
          return pessoa;
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

// ── A TELA "AVALIAÇÕES" ─────────────────────────────────────────────────────
//
// As últimas coletas de todas as pessoas. O que estes testes seguram é o que a
// tela não sabe fazer sozinha: o nome (e a idade e o sexo) de quem foi medido —
// fora da ficha, "82,4 kg" não identifica ninguém — e o rascunho ficando de fora.
function montaLista({ paginado } = {}) {
  const pedidos = [];

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidos.push(permissao);
          return { _id: "t1" };
        },
      },
    },
    api: {
      assessment: {
        async pageAll(trainerId, filtros) {
          pedidos.push(filtros);
          return paginado || { rows: [], total: 0 };
        },
      },
      tenant: {
        async assessmentPhotoSides() {
          return [{ key: "front", label: "" }];
        },
      },
    },
  });

  AssessmentController(app);
  return { app, pedidos };
}

test("a lista de todas as coletas exige a permissão de VER avaliação", async () => {
  const { app, pedidos } = montaLista();
  const r = await call(app, "get", "/assessments");

  assert.equal(r.status, 200);
  assert.equal(pedidos[0], "assessments.view");
});

test("os filtros da tela chegam inteiros ao model", async () => {
  const { app, pedidos } = montaLista();
  await call(app, "get", "/assessments", {
    query: {
      search: "bruna",
      personId: "p1",
      sort: "weight",
      dir: "asc",
      page: "3",
      limit: "20",
      // A LENTE DA UNIDADE entrou em 22/09/2026, junto com treinos e planos.
      unit: "u9",
    },
  });

  assert.deepEqual(pedidos[1], {
    search: "bruna",
    studentId: "p1",
    unit: "u9",
    // `units` é a CERCA (26/09/2026): a lista de unidades que esta pessoa
    // alcança, quando ela é restrita. Nula aqui porque o usuário do teste
    // alcança todas — e porque ele ESCOLHEU uma, que é a lente.
    units: null,
    sort: "weight",
    dir: "asc",
    page: "3",
    limit: "20",
  });
});

test("sem lente e sem cerca, o model não filtra por unidade nenhuma", async () => {
  // O model só filtra com um id VÁLIDO (`ObjectId.isValid`) ou com uma cerca
  // com itens, então `""` e `null` atravessam sem efeito. O caso existe para
  // que trocar isso por um valor que o Mongo compararia exija uma decisão.
  const { app, pedidos } = montaLista();
  await call(app, "get", "/assessments");

  assert.equal(pedidos[1].unit, "");
  assert.equal(pedidos[1].units, null);
});

test("a resposta leva os ângulos configurados junto — a coluna de fotos precisa deles", async () => {
  const { app } = montaLista({
    paginado: { rows: [{ _id: "a1", student: { _id: "p1", name: "Bruna" } }], total: 1 },
  });

  const r = await call(app, "get", "/assessments");

  assert.equal(r.body.total, 1);
  assert.equal(r.body.rows[0].student.name, "Bruna");
  assert.deepEqual(r.body.photoSides, [{ key: "front", label: "" }]);
});

// ── PESO E ALTURA JÁ VÊM PREENCHIDOS ────────────────────────────────────────
//
// São os dois únicos campos da coleta que já existem em outro lugar do sistema.
// Digitá-los de novo em toda avaliação é trabalho que o produto tinha como
// poupar — e foi o que o Marlon pediu.
test("a coleta nova nasce com o peso e a altura do cadastro", async () => {
  const { app, chamadas } = monta();
  await call(app, "post", "/people/p1/assessments", { body: {} });

  assert.equal(chamadas.insert[0].weight, 62);
  // Em centímetros, como estão no cadastro: quem converte para metros é o
  // `alturaEmMetros` do model, que já aceita as duas grafias.
  assert.equal(chamadas.insert[0].height, 165);
});

test("o número do DIA vence o do cadastro", async () => {
  // Quem manda peso na criação (uma integração, o app) está dizendo o número
  // daquele dia — e é ele que vale.
  const { app, chamadas } = monta();
  await call(app, "post", "/people/p1/assessments", { body: { weight: 60.4 } });

  assert.equal(chamadas.insert[0].weight, 60.4);
  assert.equal(chamadas.insert[0].height, 165);
});

test("cadastro sem os números não inventa campo nenhum", async () => {
  const { app, chamadas } = monta({ pessoa: { _id: "p1", name: "Ana" } });
  await call(app, "post", "/people/p1/assessments", { body: {} });

  assert.ok(!("weight" in chamadas.insert[0]));
  assert.ok(!("height" in chamadas.insert[0]));
});

test("rascunho em aberto continua sendo o mesmo — o preenchimento não o reescreve", async () => {
  // O rascunho já tem o peso que alguém digitou nele. Passar por cima com o do
  // cadastro seria apagar uma medida de verdade com um número velho.
  const { app, chamadas } = monta({ rascunhoEmAberto: { _id: "a9", weight: 58, draft: true } });
  const r = await call(app, "post", "/people/p1/assessments", { body: {} });

  assert.equal(r.body._id, "a9");
  assert.equal(r.body.weight, 58);
  assert.deepEqual(chamadas.insert, []);
});

// ── A TELA DE UMA COLETA ────────────────────────────────────────────────────
//
// Clicar num cartão da lista levava à aba da pessoa, que mostra TODAS as
// coletas. O pedido foi uma tela só daquela — e ela precisa de três coisas em
// volta do documento, nenhuma delas enfeite.
function montaUma({ coleta, pessoa, anterior, serie = [], lados = [{ key: "front", label: "" }] } = {}) {
  const pedidos = [];

  const app = fakeApp({
    helpers: { ReqProtected: { async can() { return TRAINER; } } },
    api: {
      assessment: {
        async data() {
          return coleta;
        },
        async previousOf(trainerId, studentId, quando, exceto) {
          pedidos.push({ trainerId, studentId, quando, exceto });
          return anterior;
        },
        // A linha do tempo da pessoa, para os gráficos de evolução.
        async seriesOf(trainerId, studentId) {
          pedidos.push({ serie: { trainerId, studentId } });
          return serie;
        },
      },
      user: {
        async dataStudent() {
          return pessoa;
        },
      },
      tenant: {
        async assessmentPhotoSides() {
          return lados;
        },
      },
    },
  });

  AssessmentController(app);
  return { app, pedidos };
}

const UMA = { _id: "a1", student: "p1", date: "2026-08-26", weight: 78, draft: false };

test("a coleta vem com a pessoa, a anterior e os ângulos", async () => {
  const { app } = montaUma({
    coleta: UMA,
    pessoa: { _id: "p1", name: "Bruna", sex: "female", birthDate: "1990-01-02", avatarAt: null },
    anterior: { _id: "a0", weight: 80.4, date: "2026-03-15" },
  });

  const r = await call(app, "get", "/assessments/a1");

  assert.equal(r.status, 200);
  assert.equal(r.body.assessment._id, "a1");
  // Sexo e nascimento porque quem calcula gordura e IMC é a TELA.
  assert.equal(r.body.person.sex, "female");
  assert.equal(r.body.person.birthDate, "1990-01-02");
  // A anterior, porque "78 kg" sozinho não diz nada.
  assert.equal(r.body.previous.weight, 80.4);
  assert.deepEqual(r.body.photoSides, [{ key: "front", label: "" }]);
});

test("a anterior é procurada excluindo a própria coleta", async () => {
  // Sem o `exceto`, a própria coleta seria "a anterior" dela mesma — a variação
  // sairia sempre zero, o que é pior que não mostrar variação.
  const { app, pedidos } = montaUma({ coleta: UMA, pessoa: { _id: "p1", name: "Bruna" } });

  await call(app, "get", "/assessments/a1");

  assert.equal(pedidos[0].exceto, "a1");
  assert.equal(pedidos[0].studentId, "p1");
  assert.equal(pedidos[0].quando, "2026-08-26");
});

test("primeira coleta da pessoa não inventa anterior", async () => {
  const { app } = montaUma({ coleta: UMA, pessoa: { _id: "p1", name: "Bruna" }, anterior: undefined });

  const r = await call(app, "get", "/assessments/a1");
  assert.equal(r.body.previous, null);
});

test("pessoa que não é mais acompanhada não derruba a tela", async () => {
  // O vínculo pode ter sido removido depois da coleta. A avaliação continua
  // sendo do profissional (o `data` filtra por ele), então a tela abre — só sem
  // o nome. Devolver 404 aqui esconderia dado que é dele.
  const { app } = montaUma({ coleta: UMA, pessoa: undefined });

  const r = await call(app, "get", "/assessments/a1");

  assert.equal(r.status, 200);
  assert.equal(r.body.person, null);
});

test("coleta que não existe é 404", async () => {
  const { app } = montaUma({ coleta: undefined });
  const r = await call(app, "get", "/assessments/a1");
  assert.equal(r.status, 404);
});

test("a série da pessoa vai junto — o gráfico precisa da linha, não de duas pontas", async () => {
  const { app, pedidos } = montaUma({
    coleta: UMA,
    pessoa: { _id: "p1", name: "Bruna" },
    serie: [
      { _id: "a0", date: "2026-03-15", weight: 80.4 },
      { _id: "a1", date: "2026-08-26", weight: 78 },
    ],
  });

  const r = await call(app, "get", "/assessments/a1");

  assert.equal(r.body.series.length, 2);
  // Pedida para a MESMA pessoa da coleta, e não para quem perguntou.
  assert.ok(pedidos.some((p) => p.serie?.studentId === "p1"));
});
