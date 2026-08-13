const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const User_model = require("../../model/User_model.js");

// As preferências de tela de cada conta.
//
// Duas garantias moram aqui. A primeira é o MERGE por chave: a lista de pessoas
// gravando as colunas dela não pode apagar o que outra tela guardou. A segunda é
// o teto de tamanho — as preferências vêm do cliente sem esquema nenhum, e um
// cliente com defeito não pode inflar o documento do usuário.
function fakeUsers(docs) {
  return {
    docs,
    ultimoSet: null,
    async updateOne(query, update) {
      const doc = docs.find((d) => String(d._id) === String(query._id));
      if (!doc) return { matchedCount: 0 };

      this.ultimoSet = update.$set;
      // Imita o `$set` com caminho pontuado do Mongo: "preferences.people"
      // escreve DENTRO de preferences, sem tocar nas irmãs.
      for (const [caminho, valor] of Object.entries(update.$set)) {
        const partes = caminho.split(".");
        let alvo = doc;
        while (partes.length > 1) {
          const p = partes.shift();
          alvo[p] = alvo[p] || {};
          alvo = alvo[p];
        }
        alvo[partes[0]] = valor;
      }
      return { matchedCount: 1 };
    },
  };
}

const EU = new ObjectId();

function monta(preferences) {
  const col = fakeUsers([{ _id: EU, name: "Marlon", preferences }]);
  const user = new User_model({ crypto });
  user.collection = async () => col;
  return { user, col };
}

test("grava a preferência de uma tela", async () => {
  const { user, col } = monta();

  const ok = await user.savePreferences(EU, { people: { porPagina: 30 } });

  assert.equal(ok, true);
  assert.deepEqual(col.docs[0].preferences, { people: { porPagina: 30 } });
});

test("salvar uma tela NÃO apaga a preferência de outra", async () => {
  const { user, col } = monta({ workouts: { colunas: ["nome"] } });

  await user.savePreferences(EU, { people: { porPagina: 50 } });

  assert.deepEqual(col.docs[0].preferences, {
    workouts: { colunas: ["nome"] },
    people: { porPagina: 50 },
  });
});

test("escreve por caminho pontuado, não o objeto inteiro", async () => {
  // É esta forma que garante o merge acima. Trocá-la por `preferences: {...}`
  // faria o teste anterior passar a apagar a tela vizinha.
  const { user, col } = monta();

  await user.savePreferences(EU, { people: { ordem: null } });

  assert.deepEqual(Object.keys(col.ultimoSet).sort(), ["preferences.people", "updatedAt"]);
});

test("recusa o que não é objeto", async () => {
  const { user, col } = monta();

  assert.equal(await user.savePreferences(EU, null), false);
  assert.equal(await user.savePreferences(EU, "colunas"), false);
  assert.equal(await user.savePreferences(EU, ["a", "b"]), false);
  assert.equal(await user.savePreferences(EU, {}), false);
  assert.equal(col.ultimoSet, null);
});

test("recusa preferência grande demais", async () => {
  const { user, col } = monta();

  const gigante = { people: { lixo: "x".repeat(5000) } };
  assert.equal(await user.savePreferences(EU, gigante), false);
  assert.equal(col.ultimoSet, null);
});

test("id inválido não chega ao banco", async () => {
  const { user, col } = monta();

  assert.equal(await user.savePreferences("não-é-id", { people: {} }), false);
  assert.equal(col.ultimoSet, null);
});
