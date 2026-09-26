const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const PermissionGroup = require("../../model/PermissionGroup_model.js");
const permissions = require("../../lib/permissions.js");

// GRUPOS DE PERMISSÃO — o que SOMA ao tipo de usuário.
//
// *"nesse grupo posso pôr permissões igual faço no usuário, aí posso pôr
// usuários nesse grupo, aí as permissões se somam"* (26/09/2026).
//
// ── O QUE ESTES CASOS SEGURAM ────────────────────────────────────────────
//
// Três coisas que quebram calado: uma chave inventada entrando na lista (não
// concede nada e aparece na contagem), a união pedida em N idas ao banco, e o
// grupo apagado que continua no cadastro de quem estava nele — um grupo
// fantasma que ninguém sabe de onde veio.
function fake({ grupos = [], usuarios = [] } = {}) {
  const feito = { atualizacoes: [], apagados: [] };

  const colecoes = {
    permission_groups: {
      find: (q) => ({
        project: () => ({ async toArray() { return filtrar(grupos, q); } }),
        sort: () => ({ async toArray() { return grupos; } }),
        async toArray() { return filtrar(grupos, q); },
      }),
      async findOne(q) { return filtrar(grupos, q)[0] || null; },
      async insertOne(doc) { grupos.push({ _id: new ObjectId(), ...doc }); return { insertedId: grupos.at(-1)._id }; },
      async updateOne(q, u) { feito.atualizacoes.push({ q, u }); },
      async deleteOne(q) { feito.apagados.push(q); },
    },
    users: {
      find: (q) => ({ project: () => ({ async toArray() { return filtrar(usuarios, q); } }) }),
      async updateMany(q, u) { feito.atualizacoes.push({ q, u }); },
      aggregate: () => ({ async toArray() { return []; } }),
    },
  };

  const app = { mongodb: { async connectToServer() { return { collection: (n) => colecoes[n] }; } } };
  return { modelo: new PermissionGroup(app), feito, grupos, usuarios };
}

function filtrar(lista, consulta) {
  if (!consulta || !Object.keys(consulta).length) return lista;
  return lista.filter((doc) =>
    Object.entries(consulta).every(([campo, valor]) => {
      const atual = doc[campo];
      if (valor && valor.$in) return valor.$in.some((v) => String(v) === String(atual));
      if (Array.isArray(atual)) return atual.some((v) => String(v) === String(valor));
      return String(atual) === String(valor);
    })
  );
}

test("uma chave que não existe no catálogo NÃO entra no grupo", async () => {
  // Ela não concederia nada — e apareceria na contagem da tela, que é pior:
  // quem criou o grupo acharia que deu um acesso que não deu.
  const { modelo, grupos } = fake();

  await modelo.insert({ name: "Caixa", permissions: ["finance.view", "financeiro.ver"] });

  assert.deepEqual(grupos[0].permissions, ["finance.view"]);
});

test("a união de vários grupos é UMA consulta, e vem sem repetição", async () => {
  const a = new ObjectId();
  const b = new ObjectId();
  const { modelo } = fake({
    grupos: [
      { _id: a, permissions: ["finance.view", "people.view"] },
      { _id: b, permissions: ["people.view", "schedule.view"] },
    ],
  });

  const lista = await modelo.permissoesDe([a, b]);

  assert.deepEqual([...lista].sort(), ["finance.view", "people.view", "schedule.view"]);
});

test("sem grupo nenhum, a união é vazia e não vai ao banco", async () => {
  const { modelo } = fake();
  assert.deepEqual(await modelo.permissoesDe([]), []);
  assert.deepEqual(await modelo.permissoesDe(undefined), []);
  // Id inválido é ignorado, não vira consulta torta.
  assert.deepEqual(await modelo.permissoesDe(["lixo"]), []);
});

test("permissão APOSENTADA guardada num grupo antigo não concede mais nada", async () => {
  // A lista sai pelo catálogo na saída também: um grupo salvo antes de a chave
  // morrer continuaria oferecendo o que já não existe.
  const a = new ObjectId();
  const { modelo } = fake({ grupos: [{ _id: a, permissions: [permissions.ALL[0], "clients.view"] }] });

  const lista = await modelo.permissoesDe([a]);

  assert.ok(lista.includes(permissions.ALL[0]));
  assert.ok(!lista.includes("clients.view"));
});

test("definir os membros ACERTA OS DOIS LADOS: entra quem chegou, sai quem saiu", async () => {
  // Uma lista inteira, e não `add`/`remove` por pessoa: duas telas abertas ao
  // mesmo tempo produziriam resultados diferentes conforme a ordem dos cliques.
  const g = new ObjectId();
  const u1 = new ObjectId();
  const { modelo, feito } = fake({ grupos: [{ _id: g, permissions: [] }] });

  await modelo.definirUsuarios(g, [u1]);

  const entrada = feito.atualizacoes.find((a) => a.u.$addToSet);
  const saida = feito.atualizacoes.find((a) => a.u.$pull);

  assert.ok(entrada, "quem chegou entra");
  assert.deepEqual(String(entrada.u.$addToSet.groups), String(g));
  assert.ok(saida, "quem não está mais na lista sai");
  assert.deepEqual(saida.q._id.$nin.map(String), [String(u1)]);
});

test("apagar o grupo TIRA ele de quem estava nele", async () => {
  // Sem isto sobra um id apontando para o nada: não concede, mas aparece na
  // ficha do usuário como um grupo fantasma.
  const g = new ObjectId();
  const { modelo, feito } = fake({ grupos: [{ _id: g, permissions: [] }] });

  await modelo.delete(g);

  const limpeza = feito.atualizacoes.find((a) => a.u.$pull);
  assert.ok(limpeza, "os usuários são limpos");
  assert.deepEqual(String(limpeza.q.groups), String(g));
  assert.equal(feito.apagados.length, 1);
});

test("nome repetido é achado sem diferenciar maiúscula", async () => {
  // "Caixa" e "caixa" seriam dois grupos que ninguém distingue na lista.
  const { modelo } = fake({ grupos: [{ _id: new ObjectId(), name: "Caixa" }] });

  // O fake não aplica regex; o que se confere aqui é que a consulta USA uma.
  const col = await modelo.collection();
  let consulta = null;
  col.findOne = async (q) => {
    consulta = q;
    return null;
  };

  await modelo.dataByName("caixa");

  assert.ok(consulta.name instanceof RegExp);
  assert.ok(consulta.name.flags.includes("i"));
});
