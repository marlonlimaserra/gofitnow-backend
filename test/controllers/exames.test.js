const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const ExamController = require("../../controllers/Exam.js");
const Exam_model = require("../../model/Exam_model.js");
const { catalogoPara } = require("../../lib/examMarkers.js");

// Os EXAMES de uma pessoa.
//
// O que vale o arquivo não é o CRUD — é o que faz a aba ser uma ferramenta de
// acompanhamento e não um bloco de notas:
//
//   • a FAIXA é gravada no lançamento e o "fora da faixa" é calculado na
//     LEITURA. Gravar o veredito congelaria um julgamento que depende de uma
//     faixa editável; recalcular sempre é uma conta de uma linha.
//   • a faixa do CATÁLOGO resolve pelo SEXO da pessoa: testosterona de homem e
//     de mulher não dividem nem a ordem de grandeza.
//   • exame sem data ou sem marcador não existe: a data é a coluna da tabela de
//     evolução, e um exame vazio seria uma coluna órfã.
const PESSOA = "64b2c0f7e1a2b3c4d5e6f701";
const PROF = "64b2c0f7e1a2b3c4d5e6f7a8";

function monta({ permissao = "exams.manage", sex = "male" } = {}) {
  const feito = { inseridos: [], atualizados: [], apagados: [] };

  const app = fakeApp({
    api: {
      user: {
        async dataStudent() {
          // `sex` é o campo real da ficha — o dublê usa o mesmo nome de
          // propósito: foi um `student.gender` fantasma que fez toda mulher
          // receber a faixa masculina.
          return { _id: PESSOA, name: "Marlon", sex };
        },
      },
      exam: {
        campos: Exam_model.prototype.campos,
        async list() {
          return [{ _id: "1", collectedAt: "2026-08-01", markers: [] }];
        },
        async insert(_t, _s, obj) {
          feito.inseridos.push(obj);
          return "novo-id";
        },
        async update(_t, id, obj) {
          feito.atualizados.push({ id, obj });
          return id !== "fantasma";
        },
        async delete(_t, id) {
          feito.apagados.push(id);
          return true;
        },
        async data(_t, id) {
          return id === "fantasma"
            ? undefined
            : { _id: id, collectedAt: "2026-08-01", markers: [{ key: "tsh", value: 2 }] };
        },
      },
      actionHistory: { diff: () => ({}) },
    },
    helpers: {
      ReqProtected: {
        async can(req, res, pedida) {
          if (pedida !== permissao && permissao !== "todas") {
            res.status(403).send({ msg: "sem permissão" });
            return false;
          }
          return { _id: PROF, name: "Bruna" };
        },
      },
    },
  });

  ExamController(app);
  return { app, feito };
}

test("a lista vem com o catálogo resolvido pelo sexo DESTA pessoa", async () => {
  const { app } = monta({ permissao: "todas", sex: "female" });

  const r = await call(app, "get", `/people/${PESSOA}/exams`, { params: { personId: PESSOA } });

  assert.equal(r.status, 200);
  const hormonal = r.body.catalog.find((g) => g.key === "hormonal");
  const testo = hormonal.markers.find((m) => m.key === "testosteroneTotal");
  // A faixa feminina (15–70), não a masculina (300–1000). Errar isto marcaria
  // TODA mulher da conta como "baixa" — o pior falso alarme possível.
  assert.equal(testo.low, 15);
  assert.equal(testo.high, 70);
});

test("ver e LANÇAR são permissões diferentes", async () => {
  const { app, feito } = monta({ permissao: "exams.view" });

  const lista = await call(app, "get", `/people/${PESSOA}/exams`, { params: { personId: PESSOA } });
  assert.equal(lista.status, 200);

  const cria = await call(app, "post", `/people/${PESSOA}/exams`, {
    params: { personId: PESSOA },
    body: { collectedAt: "2026-08-21", markers: [{ key: "tsh", value: "2,1" }] },
  });
  assert.equal(cria.status, 403);
  assert.equal(feito.inseridos.length, 0);
});

test("sem data de coleta não há exame — ela é a coluna da tabela", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/exams`, {
    params: { personId: PESSOA },
    body: { markers: [{ key: "tsh", value: 2 }] },
  });

  assert.equal(r.status, 400);
  assert.equal(feito.inseridos.length, 0);
});

test("sem nenhum marcador válido também não — seria uma coluna vazia", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/exams`, {
    params: { personId: PESSOA },
    // Um marcador sem valor e um sem identidade: os dois caem na limpeza.
    body: { collectedAt: "2026-08-21", markers: [{ key: "tsh" }, { name: "", value: 3 }] },
  });

  assert.equal(r.status, 400);
  assert.equal(feito.inseridos.length, 0);
});

test("lançar grava e conta a ação com a data e o tamanho do laudo", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/exams`, {
    params: { personId: PESSOA },
    body: { collectedAt: "2026-08-21", lab: "Sabin", markers: [{ key: "tsh", value: "2,1" }] },
  });

  assert.equal(r.status, 201);
  assert.equal(feito.inseridos.length, 1);
  const registro = app.registrados.find((a) => a.action === "create_exam");
  assert.ok(registro);
  assert.equal(registro.data.extra.person, "Marlon");
});

test("apagar um exame que não existe é 404, não sucesso silencioso", async () => {
  const { app, feito } = monta();

  const r = await call(app, "delete", "/exams/fantasma", { params: { id: "fantasma" } });

  assert.equal(r.status, 404);
  assert.equal(feito.apagados.length, 0);
});

// ── O MODELO: a limpeza e o veredito ────────────────────────────────────────

function modeloSeco() {
  // O modelo sem banco: `campos` e o flag são funções puras sobre o documento.
  return Exam_model.prototype;
}

test("o valor aceita vírgula — é como o laudo brasileiro escreve", () => {
  const limpo = modeloSeco().campos({
    collectedAt: "2026-08-21",
    markers: [{ key: "tsh", value: "2,4" }],
  });

  assert.equal(limpo.markers[0].value, 2.4);
});

test("marcador do catálogo NÃO carrega nome; marcador livre não carrega chave", () => {
  const limpo = modeloSeco().campos({
    collectedAt: "2026-08-21",
    markers: [
      // Chave conhecida com nome digitado: o nome sai — duas identidades para a
      // mesma linha quebrariam a costura da série.
      { key: "tsh", name: "TSH do lab", value: 2 },
      // Chave desconhecida vira marcador livre, costurado pelo nome.
      { key: "naoExiste", name: "Homocisteína", value: 9 },
    ],
  });

  assert.equal(limpo.markers[0].key, "tsh");
  assert.equal(limpo.markers[0].name, "");
  assert.equal(limpo.markers[1].key, "");
  assert.equal(limpo.markers[1].name, "Homocisteína");
});

test("o flag sai na leitura: baixo, alto, e faixa ABERTA numa ponta", async () => {
  // Um modelo com coleção falsa para exercitar o `list` de verdade.
  const docs = [{
    trainer: PROF, student: PESSOA, collectedAt: "2026-08-01",
    markers: [
      { key: "testosteroneTotal", name: "", value: 250, unit: "ng/dL", low: 300, high: 1000 },
      { key: "estradiol", name: "", value: 55, unit: "pg/mL", low: 10, high: 40 },
      { key: "tsh", name: "", value: 2.1, unit: "µUI/mL", low: 0.4, high: 4.5 },
      // HDL só tem piso: acima de qualquer número é saúde, não alerta.
      { key: "hdl", name: "", value: 90, unit: "mg/dL", low: 40, high: null },
    ],
  }];

  const modelo = new Exam_model({
    mongodb: { connectToServer: async () => ({
      collection: () => ({ find: () => ({ sort: () => ({ toArray: async () => docs }) }) }),
    }) },
  });

  const [exame] = await modelo.list(PROF, PESSOA);
  const flags = Object.fromEntries(exame.markers.map((m) => [m.key, m.flag]));

  assert.equal(flags.testosteroneTotal, "low");
  assert.equal(flags.estradiol, "high");
  assert.equal(flags.tsh, null);
  assert.equal(flags.hdl, null);
});
