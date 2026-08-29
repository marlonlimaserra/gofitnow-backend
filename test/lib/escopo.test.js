const test = require("node:test");
const assert = require("node:assert/strict");

const escopo = require("../../lib/escopo.js");
const instanceContext = require("../../lib/instance.js");

// O ESCOPO DE CLIENTE é a peça de que todo o resto depende: com um banco só, é ela
// que impede uma query de alcançar dado de outro cliente. Então aqui os testes
// não são sobre "funciona", são sobre "não vaza".
//
// A collection de mentira GRAVA o que recebeu em vez de fingir um resultado: o
// que precisa ser afirmado é o argumento que chegaria ao Mongo, e não o retorno.
function colecaoFalsa() {
  const chamadas = [];
  const registrar = (nome) => (...args) => {
    chamadas.push({ nome, args });
    return { fake: nome };
  };

  return {
    chamadas,
    collectionName: "users",
    find: registrar("find"),
    findOne: registrar("findOne"),
    countDocuments: registrar("countDocuments"),
    deleteOne: registrar("deleteOne"),
    deleteMany: registrar("deleteMany"),
    updateOne: registrar("updateOne"),
    updateMany: registrar("updateMany"),
    replaceOne: registrar("replaceOne"),
    findOneAndUpdate: registrar("findOneAndUpdate"),
    findOneAndDelete: registrar("findOneAndDelete"),
    findOneAndReplace: registrar("findOneAndReplace"),
    distinct: registrar("distinct"),
    insertOne: registrar("insertOne"),
    insertMany: registrar("insertMany"),
    aggregate: registrar("aggregate"),
    bulkWrite: registrar("bulkWrite"),
    // Existe no driver e precisa ser recusado — não basta "não estar na lista".
    createIndex: registrar("createIndex"),
    drop: registrar("drop"),
    estimatedDocumentCount: registrar("estimatedDocumentCount"),
    watch: registrar("watch"),
    // Um método que o proxy não conhece, para provar que ele não passa reto.
    metodoNovoDoDriver: registrar("metodoNovoDoDriver"),
  };
}

function escopada(instancia = "marlon") {
  const crua = colecaoFalsa();
  return { crua, col: escopo.colecaoEscopada(crua, instancia) };
}

// ── O filtro, em cada método que filtra ───────────────────────────────────

test("todo método que filtra recebe o cliente no filtro", async () => {
  // A lista vem do próprio módulo: um método novo declarado em FILTRO_EM entra
  // neste teste sozinho, em vez de ser esquecido aqui.
  for (const [metodo, posicao] of Object.entries(escopo.FILTRO_EM)) {
    const { crua, col } = escopada();
    const args = [];
    while (args.length < posicao) args.push("campo");
    args.push({ ativo: true });

    col[metodo](...args);

    const chamada = crua.chamadas.at(-1);
    assert.equal(chamada.nome, metodo, `${metodo} chamou outro método`);
    assert.deepEqual(
      chamada.args[posicao],
      { ativo: true, instance: "marlon" },
      `${metodo} não recebeu o cliente na posição ${posicao}`
    );
  }
});

test("chamada sem filtro nenhum ainda vai com cliente", () => {
  // `findOne()` sem argumento é válido no driver, e era o caso mais perigoso: sem
  // isto ele leria o primeiro documento de QUALQUER cliente.
  const { crua, col } = escopada();
  col.findOne();
  assert.deepEqual(crua.chamadas[0].args[0], { instance: "marlon" });
});

test("o cliente do contexto vence um instance vindo do chamador", () => {
  // Um filtro copiado, um dado exportado, um teste mal montado: se o valor de
  // fora vencesse, uma requisição do cliente A leria o banco do cliente B
  // passando `{ instance: "b" }`.
  const { crua, col } = escopada("marlon");
  col.find({ instance: "bruna", ativo: true });
  assert.equal(crua.chamadas[0].args[0].instance, "marlon");
});

test("$or e $and continuam valendo, dentro do cliente", () => {
  const { crua, col } = escopada();
  col.find({ $or: [{ a: 1 }, { b: 2 }] });

  const filtro = crua.chamadas[0].args[0];
  assert.deepEqual(filtro.$or, [{ a: 1 }, { b: 2 }]);
  assert.equal(filtro.instance, "marlon");
});

test("as opções do método passam intactas", () => {
  // `find(filtro, { projection })` e `updateOne(filtro, update, { upsert })`:
  // injetar o cliente não pode embaralhar a posição do resto.
  const { crua, col } = escopada();
  col.find({ a: 1 }, { projection: { name: 1 } });
  assert.deepEqual(crua.chamadas[0].args[1], { projection: { name: 1 } });

  col.updateOne({ a: 1 }, { $set: { b: 2 } }, { upsert: true });
  const ultima = crua.chamadas.at(-1);
  assert.deepEqual(ultima.args[1], { $set: { b: 2 } });
  assert.deepEqual(ultima.args[2], { upsert: true });
});

test("distinct recebe o cliente no segundo argumento, não no primeiro", () => {
  // É o único método com o filtro fora da posição zero. Escopá-lo na zero
  // trocaria o NOME DO CAMPO por um filtro e a chamada devolveria bobagem.
  const { crua, col } = escopada();
  col.distinct("goal", { ativo: true });

  const [campo, filtro] = crua.chamadas[0].args;
  assert.equal(campo, "goal");
  assert.deepEqual(filtro, { ativo: true, instance: "marlon" });
});

// ── O upsert, que é onde o filtro se transforma em documento ───────────────

test("o cliente entra por igualdade, para o upsert levá-lo ao documento novo", () => {
  // Quando o `updateOne(..., {upsert:true})` insere, o Mongo copia para o
  // documento novo os campos de IGUALDADE do filtro. Se o cliente entrasse como
  // `{ $eq: ... }` ou `{ $in: [...] }`, o documento nasceria SEM cliente — órfão,
  // invisível para o dono e visível para ninguém.
  const { crua, col } = escopada();
  col.updateOne({ chave: "x" }, { $set: { valor: 1 } }, { upsert: true });

  const filtro = crua.chamadas[0].args[0];
  assert.equal(filtro.instance, "marlon", "o cliente precisa ser igualdade simples");
  assert.equal(typeof filtro.instance, "string");
});

// ── A inserção ────────────────────────────────────────────────────────────

test("insertOne grava o cliente no documento", () => {
  const { crua, col } = escopada();
  col.insertOne({ name: "Ana" });
  assert.deepEqual(crua.chamadas[0].args[0], { name: "Ana", instance: "marlon" });
});

test("insertOne sobrescreve um instance que veio no documento", () => {
  const { crua, col } = escopada("marlon");
  col.insertOne({ name: "Ana", instance: "bruna" });
  assert.equal(crua.chamadas[0].args[0].instance, "marlon");
});

test("insertMany marca TODOS os documentos, não só o primeiro", () => {
  const { crua, col } = escopada();
  col.insertMany([{ a: 1 }, { a: 2 }, { a: 3 }]);

  const docs = crua.chamadas[0].args[0];
  assert.equal(docs.length, 3);
  for (const d of docs) assert.equal(d.instance, "marlon");
});

test("insertMany sem array estoura em vez de gravar sem cliente", () => {
  const { col } = escopada();
  assert.throws(() => col.insertMany({ a: 1 }), /array/);
});

// ── A agregação ───────────────────────────────────────────────────────────

test("a agregação recebe o $match do cliente como PRIMEIRO estágio", () => {
  // Primeiro por duas razões: índice só é usado no $match que vem antes de
  // qualquer estágio que embaralhe, e um $match depois de um $group já teria
  // somado dado alheio.
  const { crua, col } = escopada();
  col.aggregate([{ $group: { _id: "$goal", total: { $sum: 1 } } }]);

  const pipeline = crua.chamadas[0].args[0];
  assert.deepEqual(pipeline[0], { $match: { instance: "marlon" } });
  assert.equal(pipeline.length, 2);
});

test("agregação sem argumento também é escopada", () => {
  const { crua, col } = escopada();
  col.aggregate();
  assert.deepEqual(crua.chamadas[0].args[0], [{ $match: { instance: "marlon" } }]);
});

test("agregação com pipeline que não é array estoura", () => {
  const { col } = escopada();
  assert.throws(() => col.aggregate({ $match: {} }), /array/);
});

// ── O bulkWrite, uma operação por vez ─────────────────────────────────────

test("bulkWrite escopa cada operação da lista", () => {
  const { crua, col } = escopada();
  col.bulkWrite([
    { insertOne: { document: { a: 1 } } },
    { updateOne: { filter: { b: 2 }, update: { $set: { c: 3 } } } },
    { deleteOne: { filter: { d: 4 } } },
  ]);

  const [ins, upd, del] = crua.chamadas[0].args[0];
  assert.equal(ins.insertOne.document.instance, "marlon");
  assert.equal(upd.updateOne.filter.instance, "marlon");
  assert.deepEqual(upd.updateOne.update, { $set: { c: 3 } }, "o update não pode ser mexido");
  assert.equal(del.deleteOne.filter.instance, "marlon");
});

test("bulkWrite com operação desconhecida estoura em vez de passar sem escopo", () => {
  const { col } = escopada();
  assert.throws(
    () => col.bulkWrite([{ operacaoInventada: { filter: {} } }]),
    /operacaoInventada/
  );
});

// ── O que é RECUSADO ──────────────────────────────────────────────────────

test("os métodos recusados estouram, e a mensagem diz o que fazer", () => {
  for (const nome of Object.keys(escopo.RECUSADOS)) {
    const { crua, col } = escopada();
    assert.throws(() => col[nome](), new RegExp(nome), `${nome} deveria ser recusado`);
    assert.equal(crua.chamadas.length, 0, `${nome} chegou na collection crua`);
  }
});

test("drop é recusado porque apagaria a collection de todos os clientes", () => {
  // Antes `drop()` era de um cliente só, porque o banco era de um cliente só. O
  // nome do método não avisa que isso mudou — então quem chamar leva erro.
  const { col } = escopada();
  assert.throws(() => col.drop(), /TODOS/);
});

test("createIndex é recusado para o índice composto não ficar escondido", () => {
  // Num banco único todo índice precisa do `instance` como primeiro campo.
  // Reescrever a chave por baixo faria o schema parecer certo estando errado.
  const { col } = escopada();
  assert.throws(() => col.createIndex({ email: 1 }), /schema/);
});

// ── O desconhecido ────────────────────────────────────────────────────────

test("método que o escopo não conhece estoura em vez de rodar sem cliente", () => {
  // É a razão de o proxy recusar em vez de repassar: o dia em que o driver ganhar
  // um método novo, a chamada não pode sair sem escopo em silêncio.
  const { crua, col } = escopada();
  assert.throws(() => col.metodoNovoDoDriver(), /não sabe se escopar/);
  assert.equal(crua.chamadas.length, 0);
});

test("propriedade que não é função passa reto", () => {
  const { col } = escopada();
  assert.equal(col.collectionName, "users");
});

// ── Sem cliente no contexto ───────────────────────────────────────────────

test("sem cliente, escopar estoura — não cai num banco padrão", () => {
  // Fora de uma requisição não há cliente. Cair em "o primeiro" ou "todos" seria
  // entregar dado alheio; estourar é a única resposta segura, e é a mesma regra
  // que o instanceDb() já seguia.
  assert.throws(() => escopo.escopar({}), /no_instance_in_context/);
  assert.throws(() => escopo.colecaoEscopada(colecaoFalsa(), ""), /no_instance_in_context/);
});

test("dentro de um contexto, escopar usa o cliente dele", () => {
  const bancoFalso = { collection: (nome) => ({ ...colecaoFalsa(), collectionName: nome }) };

  instanceContext.run("bruna", () => {
    const db = escopo.escopar(bancoFalso);
    const col = db.collection("workouts");
    assert.equal(col.collectionName, "workouts");
  });
});

test("a collection guardada numa variável não muda de cliente", () => {
  // A instância é lida uma vez, no `.collection()`. Se fosse lida dentro de cada
  // método, uma collection guardada e usada depois de um await poderia atender
  // outro cliente — o pior tipo de vazamento, porque depende de concorrência.
  const crua = colecaoFalsa();
  const bancoFalso = { collection: () => crua };

  let guardada;
  instanceContext.run("marlon", () => {
    guardada = escopo.escopar(bancoFalso).collection("users");
  });

  instanceContext.run("bruna", () => {
    guardada.findOne({ a: 1 });
  });

  assert.equal(crua.chamadas[0].args[0].instance, "marlon");
});

// ── O banco escopado ──────────────────────────────────────────────────────

test("o banco escopado só mexe no .collection(); o resto passa", () => {
  const bancoFalso = {
    databaseName: "gofitnow",
    collection: () => colecaoFalsa(),
    command: () => "comando",
  };

  instanceContext.run("marlon", () => {
    const db = escopo.escopar(bancoFalso);
    assert.equal(db.databaseName, "gofitnow");
    assert.equal(db.command(), "comando");
  });
});
