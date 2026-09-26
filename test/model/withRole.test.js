const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const User_model = require("../../model/User_model.js");
const permissions = require("../../lib/permissions.js");

// Onde o poder de cada conta é decidido. É a função mais sensível do backend:
// os guardas só leem a lista que ela devolve.
// `grupos` é o que os GRUPOS DE PERMISSÃO somam (26/09/2026). Vazio por
// padrão: quase todo caso aqui é sobre o TIPO, e a soma tem casos próprios no
// fim do arquivo.
function monta(role, grupos = []) {
  const app = {
    crypto,
    api: {
      role: {
        async data() {
          return role;
        },
      },
      permissionGroup: {
        async permissoesDe() {
          return grupos;
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

// ── A SOMA: TIPO + GRUPOS ─────────────────────────────────────────────────
//
// *"aí posso pôr usuários nesse grupo, aí as permissões se somam"*
// (26/09/2026).
test("o que o grupo dá SOMA ao que o tipo dá", async () => {
  const u = await monta({ permissions: ["people.view"] }, ["finance.view"]).withRole({
    _id: "u1",
    role: "r1",
    groups: ["g1"],
  });

  assert.deepEqual([...u.permissions].sort(), ["finance.view", "people.view"]);
});

test("permissão repetida nos dois não aparece duas vezes", async () => {
  // A lista vai para o frontend e para todo guarda; duplicata não quebra nada e
  // faz a contagem da tela mentir.
  const u = await monta({ permissions: ["people.view"] }, ["people.view"]).withRole({
    _id: "u1",
    role: "r1",
    groups: ["g1"],
  });

  assert.deepEqual(u.permissions, ["people.view"]);
});

test("grupo SEM tipo nenhum já concede — é soma, não multiplicação", async () => {
  // Quem não tem tipo atribuído mas está num grupo recebe o que o grupo dá. O
  // contrário faria o grupo depender de um tipo qualquer para valer.
  const u = await monta(undefined, ["schedule.view"]).withRole({ _id: "u1", groups: ["g1"] });

  assert.deepEqual(u.permissions, ["schedule.view"]);
});

test("grupo NUNCA tira o que o tipo deu", async () => {
  // União pura, e é deliberado: com subtração, "por que fulano não abre o
  // financeiro?" exigiria simular a ordem das regras.
  const u = await monta({ permissions: ["finance.view"] }, []).withRole({
    _id: "u1",
    role: "r1",
    groups: ["g1"],
  });

  assert.ok(u.permissions.includes("finance.view"));
});

test("admin não passa pela soma — ele já tem o catálogo inteiro", async () => {
  const u = await monta({ permissions: [] }, ["people.view"]).withRole({
    _id: "u1",
    role: "r1",
    admin: true,
    groups: ["g1"],
  });

  assert.deepEqual([...u.permissions].sort(), [...permissions.ALL].sort());
});

test("os grupos da conta voltam na resposta, como texto", async () => {
  // A tela de usuário precisa saber em quais grupos a pessoa está; ObjectId
  // cru viraria `{}` no JSON.
  const u = await monta({ permissions: [] }, []).withRole({ _id: "u1", groups: ["g1", "g2"] });

  assert.deepEqual(u.groups, ["g1", "g2"]);
});
