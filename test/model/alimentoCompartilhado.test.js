const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Food_model = require("../../model/Food_model.js");
const instanceContext = require("../../lib/instance.js");

// O CATÁLOGO DE ALIMENTOS MORA FORA DAS INSTÂNCIAS, e é isso que faz este
// arquivo existir.
//
// As 10.398 linhas da TACO, do IBGE e da USDA são as mesmas para todo cliente:
// elas vivem no banco CENTRAL, que `lib/escopo.js` de propósito NÃO escopa —
// quase tudo ali é de todos. O preço é que o filtro por cliente tem de ser
// escrito à mão, e foi exatamente ele que faltou:
//
//   até 29/08/2026, `update` e `delete` filtravam só pelo `_id`. A rota pede
//   `foods.manage`, que está em `permissions.ALL`, que todo `admin: true`
//   recebe — então o administrador de QUALQUER cliente apagava um alimento do
//   catálogo de TODOS. Sem erro e sem quebrar as dietas já montadas (cada
//   refeição guarda uma cópia dos valores), ninguém perceberia até tentar
//   montar a próxima.
//
// Estes testes olham o FILTRO que chega ao Mongo, e não o resultado, porque é
// no filtro que o defeito estava.

function fakeModel() {
  const chamadas = [];

  const model = new Food_model({});
  model.collection = async () => ({
    async insertOne(doc) {
      chamadas.push({ op: "insertOne", doc });
      return { insertedId: new ObjectId() };
    },
    async updateOne(filtro, update) {
      chamadas.push({ op: "updateOne", filtro, update });
      return { matchedCount: 0 };
    },
    async deleteOne(filtro) {
      chamadas.push({ op: "deleteOne", filtro });
      return { deletedCount: 0 };
    },
    async findOne(filtro) {
      chamadas.push({ op: "findOne", filtro });
      return null;
    },
    async countDocuments(filtro) {
      chamadas.push({ op: "countDocuments", filtro });
      return 0;
    },
    find(filtro) {
      chamadas.push({ op: "find", filtro });
      return { sort: () => ({ skip: () => ({ limit: () => ({ async toArray() { return []; } }) }) }) };
    },
    async distinct(campo, filtro) {
      chamadas.push({ op: "distinct", campo, filtro });
      return [];
    },
    aggregate(pipeline) {
      chamadas.push({ op: "aggregate", pipeline });
      return { async toArray() { return []; } };
    },
  });

  return { model, chamadas };
}

const comCliente = (fn) => instanceContext.run("bruna", fn);

// O `$or` que define o que é visível, de dentro do `$and`.
const orDe = (filtro) => filtro.$and?.[0]?.$or;

test("apagar alcança SÓ o alimento do próprio cliente", async () => {
  const { model, chamadas } = fakeModel();
  const id = new ObjectId();

  await comCliente(() => model.delete(String(id)));

  const { filtro } = chamadas.find((c) => c.op === "deleteOne");
  assert.equal(filtro.instance, "bruna", "sem isto, apaga do catálogo de TODOS");
  assert.ok(filtro._id);
});

test("editar alcança SÓ o alimento do próprio cliente", async () => {
  const { model, chamadas } = fakeModel();

  await comCliente(() => model.update(String(new ObjectId()), { name: "Arroz" }));

  const { filtro } = chamadas.find((c) => c.op === "updateOne");
  assert.equal(filtro.instance, "bruna");
});

test("alimento criado nasce COM dono", async () => {
  // Sem dono ele entraria no catálogo compartilhado, e o "meu shake caseiro" de
  // um cliente apareceria na busca de todos os outros.
  const { model, chamadas } = fakeModel();

  await comCliente(() => model.insert({ name: "Shake da casa", kcal: 200 }));

  const { doc } = chamadas.find((c) => c.op === "insertOne");
  assert.equal(doc.instance, "bruna");
});

test("um `instance` vindo no pedido NÃO vence o do contexto", async () => {
  // Corpo de requisição é dado de fora. Se ele pudesse escolher o dono, daria
  // para plantar um alimento na conta alheia — ou no catálogo compartilhado.
  const { model, chamadas } = fakeModel();

  await comCliente(() => model.insert({ name: "X", instance: "will" }));

  const { doc } = chamadas.find((c) => c.op === "insertOne");
  assert.equal(doc.instance, "bruna");
});

test("a lista mostra o compartilhado MAIS o próprio, e nada de terceiro", async () => {
  const { model, chamadas } = fakeModel();

  await comCliente(() => model.list({}));

  const { filtro } = chamadas.find((c) => c.op === "find");
  const alternativas = orDe(filtro);
  assert.equal(alternativas.length, 2);
  // O compartilhado é o que NÃO tem dono.
  assert.deepEqual(alternativas[0], { instance: { $exists: false } });
  assert.deepEqual(alternativas[1], { instance: "bruna" });
});

test("abrir um alimento por id também respeita o que é visível", async () => {
  // Sem isto, um id copiado à mão abriria o alimento privado de outro cliente.
  const { model, chamadas } = fakeModel();

  await comCliente(() => model.data(String(new ObjectId())));

  assert.ok(orDe(chamadas.find((c) => c.op === "findOne").filtro));
});

test("os filtros da tela não vazam o que outro cliente criou", async () => {
  // Categoria e tabela saem de `distinct` e de uma agregação — e nenhum dos
  // dois passa pelo escopo, porque esta collection é do banco central.
  const { model, chamadas } = fakeModel();

  await comCliente(() => model.categories());
  await comCliente(() => model.sources());

  assert.ok(orDe(chamadas.find((c) => c.op === "distinct").filtro));

  const { pipeline } = chamadas.find((c) => c.op === "aggregate");
  assert.ok(orDe(pipeline[0].$match), "o $match do cliente precisa ser o PRIMEIRO estágio");
});

test("fora de uma requisição, tudo estoura em vez de rodar sem cliente", async () => {
  // A mesma escolha de `lib/escopo.js`: um `undefined` que virasse "sem filtro"
  // é como o defeito volta.
  const { model } = fakeModel();

  await assert.rejects(() => model.delete(String(new ObjectId())), /no_instance_in_context/);
  await assert.rejects(() => model.insert({ name: "X" }), /no_instance_in_context/);
  await assert.rejects(() => model.list({}), /no_instance_in_context/);
});
