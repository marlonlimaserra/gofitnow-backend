const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const Controller = require("../../controllers/CustomFieldGroup.js");
const Grupo = require("../../model/CustomFieldGroup_model.js");

// AS GAVETAS — e a ordem em que a ficha as empilha.
//
// *"permita reordenar, assim no cadastro do cliente abre na ordem"*
// (02/10/2026).
function monta({ permissoes = ["people.view", "users.manage"] } = {}) {
  const pedidas = [];
  const gravado = {};

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidas.push(permissao);
          if (!permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon" };
        },
      },
    },
    api: {
      customFieldGroup: {
        async list() {
          return [{ _id: "g1", key: "principal", name: "", rotuloPadrao: "customFields.group.principal", ordem: 10 }];
        },
        async data(id) {
          return { _id: String(id), key: "saude", name: "Saúde" };
        },
        async reordenar(ids) {
          gravado.ordem = ids;
          return Array.isArray(ids) && ids.length ? { ok: true, quantos: ids.length } : { ok: false };
        },
        async remove() {
          return { ok: true, movidos: 3 };
        },
        async insert() {
          return { id: "g2" };
        },
        async update() {
          return { id: "g1" };
        },
      },
    },
  });

  Controller(app);
  return { app, pedidas, gravado };
}

test("`/ordem` não é tratado como um id de grupo", async () => {
  // O Express casa na ordem de registro. Com `/:id` em cima, este pedido cairia
  // na rota de UM grupo com `id = "ordem"` — e a ordem nunca salvaria, calada.
  const { app, gravado } = monta();
  const r = await call(app, "put", "/custom-field-groups/ordem", { body: { ids: ["g2", "g1"] } });

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.ordem, ["g2", "g1"]);
});

test("reordenar devolve a lista já na ordem nova", async () => {
  // A tela redesenha com o que voltou, e não com o palpite dela.
  const { app } = monta();
  const r = await call(app, "put", "/custom-field-groups/ordem", { body: { ids: ["g1"] } });
  assert.ok(Array.isArray(r.body.rows));
});

test("lista vazia é recusada — não é ordem nenhuma", async () => {
  const { app } = monta();
  const r = await call(app, "put", "/custom-field-groups/ordem", { body: { ids: [] } });
  assert.equal(r.status, 400);
});

test("reordenar pede `users.manage`", async () => {
  const { app, pedidas } = monta();
  await call(app, "put", "/custom-field-groups/ordem", { body: { ids: ["g1"] } });
  assert.deepEqual(pedidas, ["users.manage"]);
});

test("o nome do grupo padrão sai da tradução, e não vazio", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/custom-field-groups");

  assert.ok(r.body.rows[0].name);
  assert.ok(!r.body.rows[0].name.startsWith("customFields."));
});

test("apagar diz quantos campos voltaram para o principal", async () => {
  // Sem o número, a pessoa só descobre rolando a lista.
  const { app } = monta();
  const r = await call(app, "delete", "/custom-field-groups/g2");
  assert.equal(r.body.movidos, 3);
});

// ── A COR ────────────────────────────────────────────────────────────────
test("os oito nomes antigos continuam virando hex", () => {
  // Os grupos criados antes do seletor livre têm nome gravado; recusá-los
  // apagaria a cor deles.
  assert.equal(Grupo.corValida("rose"), "#f43f5e");
});

test("hex curto completa, maiúscula normaliza, lixo cai no padrão", () => {
  assert.equal(Grupo.corValida("#ABC"), "#aabbcc");
  assert.equal(Grupo.corValida("#E91E63"), "#e91e63");
  // Nunca vazio: um selo sem cor some do fundo branco.
  assert.equal(Grupo.corValida("azulzinho"), Grupo.COR_PADRAO);
});
