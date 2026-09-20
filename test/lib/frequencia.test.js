const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Checkin = require("../../model/Checkin_model.js");

// A ENTRADA NA ACADEMIA.
//
// *"crie esse menu no aluno: frequência de entrada na academia e frequência nas
// aulas. Já comprei o negócio de face ID para a gente testar quando chegar."*
//
// O caso que este arquivo existe para garantir é a JANELA DE REPETIÇÃO: uma
// catraca dispara duas vezes quando a pessoa hesita na roleta, e um leitor
// facial dispara enquanto o rosto estiver na frente dele. Sem ela, uma visita
// vira cinco entradas e a frequência do mês triplica.
const PESSOA = new ObjectId().toString();

function fakeCheckin(existente = null) {
  const inseridos = [];
  let consulta = null;

  const model = new Checkin({});
  model.collection = async () => ({
    async findOne(filtro) {
      consulta = filtro;
      return existente;
    },
    async insertOne(doc) {
      inseridos.push(doc);
      return { insertedId: new ObjectId() };
    },
  });

  return { model, inseridos, consultaFeita: () => consulta };
}

test("a primeira passada grava", async () => {
  const { model, inseridos } = fakeCheckin();
  const r = await model.registrar(PESSOA, { por: { _id: new ObjectId(), name: "Marlon" } });

  assert.equal(r.ok, true);
  assert.equal(r.repetido, false);
  assert.equal(inseridos.length, 1);
  assert.equal(inseridos[0].porNome, "Marlon");
});

test("a segunda passada em dois minutos NÃO grava, e não é erro", async () => {
  // É a resposta certa para o segundo disparo da catraca: 200, e a tela não
  // mostra nada.
  const agora = new Date();
  const { model, inseridos } = fakeCheckin({ _id: new ObjectId(), em: agora });

  const r = await model.registrar(PESSOA);

  assert.equal(r.ok, true);
  assert.equal(r.repetido, true);
  assert.deepEqual(inseridos, []);
});

test("a janela procura trinta minutos para trás, e não o dia inteiro", async () => {
  // Quem vem de manhã e de novo à noite conta DUAS vezes — é treino duplo, e
  // existe. Uma janela de um dia esconderia a segunda visita.
  const agora = new Date("2026-09-20T18:00:00Z");
  const { model, consultaFeita } = fakeCheckin();

  await model.registrar(PESSOA, { em: agora });

  const filtro = consultaFeita();
  const desde = filtro.em.$gte;
  assert.equal((agora - desde) / 60000, Checkin.REPETICAO_MIN);
});

test("a origem diz de onde veio, e o que não conhecemos vira `balcao`", async () => {
  for (const [pedida, esperada] of [
    ["catraca", "catraca"],
    ["app", "app"],
    ["inventada", "balcao"],
    [undefined, "balcao"],
  ]) {
    const { model, inseridos } = fakeCheckin();
    await model.registrar(PESSOA, { origem: pedida });
    assert.equal(inseridos[0].origem, esperada, String(pedida));
  }
});

test("o leitor é identificado, para o dia em que houver dois", async () => {
  const { model, inseridos } = fakeCheckin();
  await model.registrar(PESSOA, { origem: "catraca", dispositivo: "porta-principal" });

  assert.equal(inseridos[0].dispositivo, "porta-principal");
  // A catraca não tem nome de gente, e o `origem` já conta essa parte.
  assert.equal(inseridos[0].porNome, "");
});

test("id inválido e data inválida são recusados", async () => {
  const { model, inseridos } = fakeCheckin();

  assert.deepEqual(await model.registrar("nao-e-id"), { ok: false, erro: "invalido" });
  assert.deepEqual(await model.registrar(PESSOA, { em: "banana" }), { ok: false, erro: "data" });
  assert.deepEqual(inseridos, []);
});

test("a janela é de trinta minutos — o número está publicado", () => {
  // A tela explica por que duas passadas viraram uma, e ela lê daqui.
  assert.equal(Checkin.REPETICAO_MIN, 30);
});
