const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const GroupClass_model = require("../../model/GroupClass_model.js");

// A LENTE NA GRADE DE AULAS COLETIVAS.
//
// *"aulas coletivas não respeita unidade"* (22/09/2026).
//
// ── Por que a regra aqui é diferente ──────────────────────────────────────
//
// O campo é `units`, no PLURAL: a aula de bike das 08:00 pode acontecer nas
// duas unidades — ela é uma GRADE, não um evento com lugar e data. Então a
// pergunta não é "qual é a unidade dela", e sim "a unidade escolhida está na
// lista dela".
//
// E lista VAZIA quer dizer TODAS. É o contrato que o formulário já mostra, e
// é o estado de toda aula cadastrada antes de a casa ter duas unidades —
// excluí-las faria a grade sumir inteira na primeira troca de lente.
function fake() {
  const consultas = [];
  const model = new GroupClass_model({});

  model.collection = async () => ({
    find(filtro) {
      consultas.push(filtro);
      return { sort: () => ({ async toArray() { return []; } }) };
    },
  });

  return { model, consultas };
}

const UNIDADE = new ObjectId();

test("sem lente, só o filtro de ativas", async () => {
  const { model, consultas } = fake();

  await model.listActive();

  assert.deepEqual(consultas[0], { active: true });
});

test("com lente, entra a aula DAQUELA unidade", async () => {
  const { model, consultas } = fake();

  await model.listActive(String(UNIDADE));

  const ou = consultas[0].$or;
  assert.ok(ou, "sem $or não há como aceitar as duas formas");
  assert.ok(
    ou.some((c) => String(c.units) === String(UNIDADE)),
    "a unidade escolhida não é procurada dentro de `units`"
  );
});

test("e entram também as SEM unidade — vazio vale para todas", async () => {
  // A regra que impede a grade de sumir: toda aula cadastrada antes de
  // existirem duas unidades tem a lista vazia.
  const { model, consultas } = fake();

  await model.listActive(String(UNIDADE));

  const ou = JSON.stringify(consultas[0].$or);
  assert.ok(ou.includes("$in"), "faltou aceitar lista vazia");
  assert.ok(ou.includes("$exists"), "faltou aceitar o campo ausente");
});

test("id inválido é ignorado, e não esvazia a grade", async () => {
  // Um id sujo no endereço não pode apagar a agenda do dia.
  const { model, consultas } = fake();

  await model.listActive("nao-e-id");

  assert.deepEqual(consultas[0], { active: true });
});
