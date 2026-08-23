const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const PrescriptionController = require("../../controllers/Prescription.js");
const Prescription_model = require("../../model/Prescription_model.js");

// AS PRESCRIÇÕES: receita, manipulado, exame, encaminhamento, atestado.
//
// O que este arquivo defende é o que diferencia isto de um CRUD qualquer:
//
//   • documento em BRANCO não se emite. Uma folha assinada sem item e sem
//     orientação é papel assinado em branco.
//   • quem imprime precisa de QUEM ASSINA. Uma receita sem o nome e o registro
//     de quem emitiu não vale nada em farmácia nenhuma.
//   • emitir e ver são permissões diferentes: a recepção pode precisar
//     reimprimir; assinar é de quem tem conselho.
const PESSOA = "64b2c0f7e1a2b3c4d5e6f701";
const PROF = "64b2c0f7e1a2b3c4d5e6f7a8";

function monta({ permissao = "prescriptions.manage", doc = null } = {}) {
  const feito = { inseridos: [], atualizados: [], apagados: [] };
  const modelo = new Prescription_model({});

  const app = fakeApp({
    api: {
      user: {
        async dataStudent() {
          return { _id: PESSOA, name: "Marlon Lima" };
        },
        async data() {
          return { _id: PESSOA, name: "Marlon Lima", birthDate: "1996-03-15", document: "123" };
        },
      },
      prescription: {
        TIPOS: ["medication", "exam"],
        // A limpeza de itens é do modelo de verdade: é ela que decide o que
        // conta como item, e o controller confia nela para recusar a folha em
        // branco. Um dublê aqui provaria o dublê.
        limparItens: modelo.limparItens,
        async list() {
          return [
            { _id: "1", type: "medication", date: "2026-08-20", itemCount: 2 },
            { _id: "2", type: "exam", date: "2026-07-01", itemCount: 1 },
          ];
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
          if (id === "fantasma") return undefined;
          return (
            doc || {
              _id: id,
              student: PESSOA,
              type: "medication",
              date: "2026-08-20",
              council: "CRN-1 12345",
              items: [{ name: "Vitamina D3", dose: "1 cápsula" }],
              notes: "",
              itemCount: 1,
            }
          );
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
          return { _id: PROF, name: "Bruna Sampaio" };
        },
      },
    },
  });

  PrescriptionController(app);
  return { app, feito };
}

test("a lista devolve os documentos e os tipos que a tela oferece", async () => {
  const { app } = monta({ permissao: "todas" });

  const r = await call(app, "get", `/people/${PESSOA}/prescriptions`, {
    params: { personId: PESSOA },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.counts.all, 2);
  assert.deepEqual(r.body.types, ["medication", "exam"]);
});

test("documento sem item E sem orientação é recusado", async () => {
  // É o caso da folha assinada em branco. Recusar aqui é melhor que descobrir
  // depois de imprimir.
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/prescriptions`, {
    params: { personId: PESSOA },
    body: { type: "medication", items: [{ name: "" }, {}], notes: "   " },
  });

  assert.equal(r.status, 400);
  assert.deepEqual(feito.inseridos, []);
});

test("só orientação, sem item, é documento válido", async () => {
  // Atestado e encaminhamento são exatamente isso: texto, sem lista de
  // medicamento. Exigir item obrigaria a inventar um.
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/prescriptions`, {
    params: { personId: PESSOA },
    body: { type: "certificate", notes: "Afastar de atividade física por 7 dias." },
  });

  assert.equal(r.status, 201);
  assert.equal(feito.inseridos.length, 1);
});

test("emitir exige `prescriptions.manage` — ver não basta", async () => {
  const { app, feito } = monta({ permissao: "prescriptions.view" });

  const r = await call(app, "post", `/people/${PESSOA}/prescriptions`, {
    params: { personId: PESSOA },
    body: { items: [{ name: "Vitamina D3" }] },
  });

  assert.equal(r.status, 403);
  assert.deepEqual(feito.inseridos, []);
});

test("o documento vem com a pessoa e com quem assina — é o que a folha imprime", async () => {
  const { app } = monta({ permissao: "todas" });

  const r = await call(app, "get", "/prescriptions/abc", { params: { id: "abc" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.student.name, "Marlon Lima");
  assert.equal(r.body.student.birthDate, "1996-03-15");
  // O nome sai da conta AGORA; o registro do conselho sai do DOCUMENTO, porque
  // é o que estava valendo no dia da emissão.
  assert.equal(r.body.professional.name, "Bruna Sampaio");
  assert.equal(r.body.professional.council, "CRN-1 12345");
});

test("validade antes da emissão é recusada", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/prescriptions`, {
    params: { personId: PESSOA },
    body: { date: "2026-08-20", validUntil: "2026-08-01", items: [{ name: "X" }] },
  });

  assert.equal(r.status, 400);
  assert.deepEqual(feito.inseridos, []);
});

test("editar tirando o último item deixaria o documento em branco — recusado", async () => {
  const { app, feito } = monta({
    doc: { _id: "abc", items: [{ name: "Vitamina D3" }], notes: "", itemCount: 1 },
  });

  const r = await call(app, "put", "/prescriptions/abc", {
    params: { id: "abc" },
    body: { items: [] },
  });

  assert.equal(r.status, 400);
  assert.deepEqual(feito.atualizados, []);
});

test("editar só a validade não exige mandar os itens de novo", async () => {
  const { app, feito } = monta({
    doc: { _id: "abc", items: [{ name: "Vitamina D3" }], notes: "", itemCount: 1 },
  });

  const r = await call(app, "put", "/prescriptions/abc", {
    params: { id: "abc" },
    body: { validUntil: "2026-12-31" },
  });

  assert.equal(r.status, 200);
  assert.equal(feito.atualizados.length, 1);
});

test("apagar registra o tipo no histórico", async () => {
  const { app } = monta();

  const r = await call(app, "delete", "/prescriptions/abc", { params: { id: "abc" } });

  assert.equal(r.status, 200);
  const registro = app.registrados.find((x) => x.action === "delete_prescription");
  assert.ok(registro);
  assert.equal(registro.data.category, "prescriptions");
});

// ── O MODELO ────────────────────────────────────────────────────────────────

test("item sem nome é descartado, e não vira erro", async () => {
  // A tela pode ter uma linha vazia no fim. Transformar isso em "corrija o
  // formulário" seria brigar por nada.
  const m = new Prescription_model({});

  const itens = m.limparItens([
    { name: "Vitamina D3", dose: "1 cápsula", posology: "1x ao dia" },
    { name: "   " },
    {},
    null,
  ]);

  assert.equal(itens.length, 1);
  assert.equal(itens[0].name, "Vitamina D3");
  // Os campos que faltaram nascem vazios, nunca `undefined`: a folha lê todos.
  assert.equal(itens[0].duration, "");
  assert.equal(itens[0].notes, "");
});

test("tipo desconhecido cai em receita, e não grava lixo", () => {
  const m = new Prescription_model({});
  assert.ok(m.TIPOS.includes("medication"));
  assert.ok(!m.TIPOS.includes("qualquer-coisa"));
});
