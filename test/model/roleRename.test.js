const test = require("node:test");
const assert = require("node:assert/strict");

const Role_model = require("../../model/Role_model.js");
const permissions = require("../../lib/permissions.js");

// A renomeação dos papéis semeados.
//
// "Profissional" virou "Usuário" e "Pessoa" virou "Cliente" quando "profissional"
// deixou de ser um tipo de conta visível. O risco não é o nome: é que as contas
// apontam para o `_id` do papel. Semear um papel NOVO com o nome novo deixaria o
// antigo para trás com gente dentro, e a plataforma ficaria com dois papéis quase
// iguais sem ninguém saber qual vale.

// Uma collection de mentira com a superfície que o `ensureSystemRoles` usa.
function fakeCollection(docs = []) {
  const dados = docs.map((d, i) => ({ _id: d._id || `id${i}`, ...d }));

  return {
    dados,
    async findOne(query) {
      return (
        dados.find((d) =>
          Object.entries(query).every(([k, v]) =>
            typeof v === "object" && v !== null && "$ne" in v ? d[k] !== v.$ne : d[k] === v
          )
        ) || null
      );
    },
    async insertOne(doc) {
      dados.push({ _id: "novo" + dados.length, ...doc });
      return { insertedId: "novo" };
    },
    async updateOne(query, update) {
      const doc = await this.findOne(query);
      if (doc) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },
  };
}

function monta(docs) {
  const col = fakeCollection(docs);
  const roles = new Role_model({});
  roles.collection = async () => col;
  return { roles, col };
}

test.describe("ensureSystemRoles renomeia em vez de duplicar", () => {
  test("Profissional vira Usuário, MANTENDO o mesmo documento", async () => {
    const { roles, col } = monta([
      { _id: "r1", name: "Profissional", system: true, permissions: ["people.view"] },
    ]);

    await roles.ensureSystemRoles();

    const usuario = col.dados.find((d) => d.name === "Usuário");
    assert.equal(usuario?._id, "r1", "tinha de ser o MESMO documento — as contas apontam para o id");
    assert.equal(
      col.dados.filter((d) => d.name === "Profissional").length,
      0,
      "não pode sobrar o antigo"
    );
  });

  test("Pessoa vira Cliente", async () => {
    const { roles, col } = monta([{ _id: "r2", name: "Pessoa", system: true, permissions: [] }]);

    await roles.ensureSystemRoles();

    assert.equal(col.dados.find((d) => d.name === "Cliente")?._id, "r2");
  });

  test("as permissões que já estavam lá são preservadas", async () => {
    // Renomear não pode devolver o papel ao estado de fábrica: o admin pode ter
    // tirado ou acrescentado permissões, e elas são a razão de o papel existir.
    const { roles, col } = monta([
      {
        _id: "r1",
        name: "Profissional",
        system: true,
        permissions: ["people.view", "logs.view"],
      },
    ]);

    await roles.ensureSystemRoles();

    const usuario = col.dados.find((d) => d.name === "Usuário");
    assert.deepEqual(usuario.permissions, ["people.view", "logs.view"]);
  });

  test("rodar duas vezes não muda mais nada", async () => {
    // Roda em todo boot. Se não fosse idempotente, o segundo boot criaria
    // duplicatas.
    const { roles, col } = monta([
      { _id: "r1", name: "Profissional", system: true, permissions: [] },
      { _id: "r2", name: "Pessoa", system: true, permissions: [] },
    ]);

    await roles.ensureSystemRoles();
    const depoisDoPrimeiro = col.dados.length;
    await roles.ensureSystemRoles();

    assert.equal(col.dados.length, depoisDoPrimeiro);
    assert.equal(col.dados.filter((d) => d.name === "Usuário").length, 1);
    assert.equal(col.dados.filter((d) => d.name === "Cliente").length, 1);
  });

  test("um papel que a pessoa criou à mão com o nome novo não é atropelado", async () => {
    const { roles, col } = monta([
      { _id: "r1", name: "Profissional", system: true, permissions: ["people.view"] },
      { _id: "meu", name: "Usuário", system: false, permissions: ["logs.view"] },
    ]);

    await roles.ensureSystemRoles();

    const meu = col.dados.find((d) => d._id === "meu");
    assert.deepEqual(meu.permissions, ["logs.view"], "o papel de quem administra fica intacto");
    assert.equal(col.dados.find((d) => d._id === "r1").name, "Profissional", "o antigo não é tocado");
  });

  test("papel NÃO semeado com o nome antigo fica em paz", async () => {
    // `system: false` é papel que alguém criou. Renomeá-lo seria mexer no trabalho
    // de outra pessoa por causa de uma coincidência de nome.
    const { roles, col } = monta([{ _id: "x", name: "Pessoa", system: false, permissions: [] }]);

    await roles.ensureSystemRoles();

    assert.equal(col.dados.find((d) => d._id === "x").name, "Pessoa");
  });
});

test("o banco vazio nasce com os três papéis certos", async () => {
  const { roles, col } = monta([]);

  await roles.ensureSystemRoles();

  assert.deepEqual(
    col.dados.map((d) => d.name).sort(),
    ["Administrador", "Cliente", "Usuário"].sort()
  );
  assert.equal(
    col.dados.find((d) => d.name === "Administrador").permissions.length,
    permissions.ALL.length,
    "o Administrador nasce com tudo"
  );
  assert.deepEqual(col.dados.find((d) => d.name === "Cliente").permissions, []);
});

test("os nomes ficam no modelo, não escritos à mão em cada controller", () => {
  // Nome com acento repetido em dois lugares é erro de digitação esperando para
  // virar conta sem permissão.
  const roles = new Role_model({});
  assert.equal(roles.defaultName, "Usuário");
  assert.equal(roles.clientName, "Cliente");
  assert.equal(roles.adminName, "Administrador");
});
