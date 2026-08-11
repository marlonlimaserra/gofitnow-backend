const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const User_model = require("../../model/User_model.js");
const permissions = require("../../lib/permissions.js");

// Onde o poder de cada conta é decidido. É a função mais sensível do backend:
// os guardas só leem a lista que ela devolve.
function monta(role) {
  const app = {
    crypto,
    api: {
      role: {
        async data() {
          return role;
        },
      },
    },
  };
  return new User_model(app);
}

test("admin recebe o catálogo INTEIRO, não uma lista guardada", () => {
  // Guardada, ela ficaria velha: uma permissão criada depois do cadastro não
  // chegaria a quem administra a plataforma.
  return monta(undefined)
    .withRole({ _id: "u1", admin: true })
    .then((u) => {
      assert.deepEqual([...u.permissions].sort(), [...permissions.ALL].sort());
      assert.equal(u.admin, true);
    });
});

test("admin cobre até uma permissão que não existia quando a conta foi criada", async () => {
  const u = await monta(undefined).withRole({ _id: "u1", admin: true });
  // Qualquer chave do catálogo de hoje serve para provar o ponto.
  for (const k of permissions.ALL) assert.ok(u.permissions.includes(k), k);
});

test("sem tipo, a conta fica SEM permissão — nunca com todas", async () => {
  // O erro que este teste existe para impedir: tratar "sem papel" como
  // "irrestrito". Quem teve o tipo apagado tem de perder acesso.
  const u = await monta(undefined).withRole({ _id: "u1" });
  assert.deepEqual(u.permissions, []);
  assert.equal(u.admin, false);
});

test("tipo apagado depois de atribuído também deixa a conta sem permissão", async () => {
  const users = monta(undefined); // role.data devolve undefined
  const u = await users.withRole({ _id: "u1", role: "papel-que-sumiu" });
  assert.deepEqual(u.permissions, []);
  assert.equal(u.roleName, "");
});

test("conta comum recebe exatamente as permissões do tipo dela", async () => {
  const u = await monta({ name: "Recepção", permissions: ["people.view"] }).withRole({
    _id: "u1",
    role: "r1",
  });

  assert.deepEqual(u.permissions, ["people.view"]);
  assert.equal(u.roleName, "Recepção");
  assert.equal(u.admin, false);
});

test("tipo sem lista de permissões vira lista vazia, não undefined", async () => {
  const u = await monta({ name: "Vazio" }).withRole({ _id: "u1", role: "r1" });
  assert.deepEqual(u.permissions, []);
});

test("admin: true é exigido literalmente — valor parecido não promove ninguém", async () => {
  for (const valor of ["true", 1, "1", "yes", {}]) {
    const u = await monta(undefined).withRole({ _id: "u1", admin: valor });
    assert.equal(u.admin, false, `admin: ${JSON.stringify(valor)} não pode promover`);
    assert.deepEqual(u.permissions, []);
  }
});

test("withRole não vaza hash nem salt", async () => {
  const u = await monta(undefined).withRole({ _id: "u1", password: "hash", salt: "sal" });
  assert.equal(u.password, undefined);
  assert.equal(u.salt, undefined);
});

test("withRole passa reto por documento ausente", async () => {
  assert.equal(await monta(undefined).withRole(null), null);
  assert.equal(await monta(undefined).withRole(undefined), undefined);
});
