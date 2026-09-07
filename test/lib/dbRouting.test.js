const test = require("node:test");
const assert = require("node:assert/strict");

const instanceContext = require("../../lib/instance.js");

// Para qual BANCO cada coisa vai.
//
// São DOIS bancos no total, e não dois por cliente: `gofitnow` guarda os dados de
// todos os clientes, com o campo `instance` em cada documento, e `gofitnow_center`
// guarda o que é igual para todo mundo. Era um banco por cliente até 24/08/2026 —
// ver o cabeçalho de `config/mongodb.js` para a aritmética que derrubou aquilo.
//
// O módulo lê MONGODB_URI na carga, então ele é exigido depois de a variável
// existir. Nenhum teste aqui abre conexão: o que se prova é o roteamento, que é
// decidido antes de qualquer ida ao servidor.
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/gofitnow";
const mongodb = require("../../config/mongodb.js");

const schema = require("../../database/schema.js");

test("o banco central é o `_center` — o do compartilhado", () => {
  // A URI dá só a BASE dos nomes; ela mesma não guarda nada.
  assert.equal(mongodb.centralName(), "gofitnow_center");
});

test("todo cliente mora no MESMO banco", () => {
  // O nome da URI, que antes era só a base dos outros dois, agora é o banco dos
  // dados. O que separa um cliente do outro é o campo, não o banco.
  assert.equal(mongodb.nomeDoBanco(), "gofitnow");
});

test("nome de cliente inválido é recusado por comoCliente", async () => {
  // Antes um nome ruim não virava nome de banco. Agora não vira ESCOPO — e o
  // perigo aumentou: um escopo vazio leria todos os clientes em vez de um banco
  // inexistente.
  //
  // `await` em cada um: `assert.rejects` devolve promessa, e sem esperar o teste
  // passaria mesmo que nada fosse recusado.
  for (const ruim of ["../admin", "com.ponto", "", "admin", null]) {
    await assert.rejects(
      () => mongodb.comoCliente(ruim),
      /invalid_instance/,
      JSON.stringify(ruim)
    );
  }
});

test("connectToServer NÃO funciona fora de uma requisição", async () => {
  // É o coração do isolamento: um modelo chamado sem instância tem de parar,
  // não escolher um banco por conta própria.
  await assert.rejects(() => mongodb.connectToServer(), /no_instance_in_context/);
});

test("o que é central e o que é por instância não se sobrepõem", () => {
  // Uma collection nos dois lados significaria dois lugares para a mesma
  // informação, e ninguém saberia qual está certo.
  const nos_dois = schema.CENTRAL.filter((c) => schema.POR_INSTANCIA.includes(c));
  assert.deepEqual(nos_dois, []);
});

test("o catálogo de exercícios é CENTRAL — igual para todo mundo", () => {
  assert.ok(schema.CENTRAL.includes("exercises"));
  assert.ok(!schema.POR_INSTANCIA.includes("exercises"));
});

test("o registro das instâncias NÃO é criado por este backend", () => {
  // Ele mora no banco do painel, e o dono do schema dele é o painel. Duas
  // fontes criando o mesmo índice daria dois lugares para manter.
  assert.ok(!schema.CENTRAL.includes("center"));
  assert.ok(!schema.CENTRAL.includes("instances"));
  assert.ok(!schema.POR_INSTANCIA.includes("instances"));
});

test("contas e treinos são da instância, nunca do central", () => {
  for (const c of ["users", "workouts", "professional_links", "roles", "tenants"]) {
    assert.ok(schema.POR_INSTANCIA.includes(c), c);
    assert.ok(!schema.CENTRAL.includes(c), c);
  }
});

test("são dois bancos, e os nomes se leem em conjunto", () => {
  assert.equal(mongodb.nomeDoBanco(), "gofitnow");
  assert.equal(mongodb.centralName(), "gofitnow_center");
});

test("`access_requests` não existe mais em lugar nenhum", () => {
  // O pedido de acesso saiu junto com o motivo dele: com um banco por cliente,
  // a conta de outra instância é outra conta.
  assert.ok(!schema.CENTRAL.includes("access_requests"));
  assert.ok(!schema.POR_INSTANCIA.includes("access_requests"));
});

test("o modelo de exercícios lê o banco CENTRAL, não o da instância", async () => {
  // Prova pelo comportamento: se ele usasse connectToServer, estouraria fora de
  // uma requisição — como os outros modelos fazem.
  const Exercise = require("../../model/Exercise_model.js");
  const chamadas = [];

  const model = new Exercise({
    mongodb: {
      async centralDb() {
        chamadas.push("central");
        return { collection: () => ({}) };
      },
      async connectToServer() {
        chamadas.push("instancia");
        return { collection: () => ({}) };
      },
    },
  });

  await model.collection();
  assert.deepEqual(chamadas, ["central"]);
});

test("o registro das instâncias é lido no banco CENTRAL", async () => {
  // O mesmo banco do catálogo: os dois são "igual para todo mundo".
  const Center = require("../../model/Center_model.js");
  const chamadas = [];

  const model = new Center({
    mongodb: {
      async centralDb() {
        chamadas.push("central");
        return { collection: (n) => ({ nome: n }) };
      },
      async connectToServer() {
        chamadas.push("instancia");
        return { collection: () => ({}) };
      },
    },
  });

  const col = await model.collection();
  assert.deepEqual(chamadas, ["central"]);
  assert.equal(col.nome, "instances", "sem prefixo — o banco já diz de quem é");
});

test("um modelo comum lê o banco da INSTÂNCIA", async () => {
  // O contrário do de cima, e o caso da esmagadora maioria: quem não é
  // compartilhado tem de estar dentro do banco do cliente.
  const User = require("../../model/User_model.js");
  const chamadas = [];

  const model = new User({
    mongodb: {
      async centralDb() {
        chamadas.push("central");
        return { collection: () => ({}) };
      },
      async connectToServer() {
        chamadas.push("instancia");
        return { collection: () => ({}) };
      },
    },
  });

  await model.collection();
  assert.deepEqual(chamadas, ["instancia"]);
});

test("o comentário de `access_requests` já não vale pelo motivo antigo", () => {
  // Ficava escrito que "com um banco por cliente, a conta de outra instância é
  // outra conta". O banco por cliente acabou; a collection continua não
  // existindo, e agora o motivo é o produto, não o armazenamento.
  assert.ok(!schema.CENTRAL.includes("access_requests"));
  assert.ok(!schema.POR_INSTANCIA.includes("access_requests"));
});

test("só os modelos DECLARADOS usam o banco cru, sem escopo", () => {
  // O cru vê todos os clientes. Um modelo que o chamasse por descuido desfaria o
  // isolamento inteiro sem erro nenhum — a tela mostraria dado alheio e nada
  // acenderia.
  //
  // Mas a proibição total seria mentira: existem duas leituras que são, por
  // definição, sobre todos os clientes ao mesmo tempo — as contagens que o painel
  // mostra. Então a regra é uma LISTA, e não um "nunca": um uso novo quebra este
  // teste e obriga quem escreveu a vir aqui declarar por quê.
  //
  // O que autoriza estas duas: as duas devolvem AGREGADO (contagem por categoria,
  // lista de chaves e de quem usa), nunca documento de ninguém, e as duas
  // alimentam o painel, que é nosso.
  const AUTORIZADOS = {
    "UserCategory_model.js": "contagens() — quantas pessoas por categoria, somando os clientes ativos",
    "RecipeCategory_model.js": "dosClientes() — quais categorias os clientes inventaram",
  };

  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "..", "model");

  const usam = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("bancoCruSemEscopo"));

  const naoDeclarados = usam.filter((f) => !AUTORIZADOS[f]);
  assert.deepEqual(
    naoDeclarados,
    [],
    "modelo lendo TODOS os clientes sem estar declarado em AUTORIZADOS"
  );

  // E o contrário: um nome que saiu da lista mas continua declarado esconde que
  // a autorização deixou de ser usada.
  const declaradosSemUso = Object.keys(AUTORIZADOS).filter((f) => !usam.includes(f));
  assert.deepEqual(declaradosSemUso, [], "autorização sobrando em AUTORIZADOS");
});

test("as duas leituras cruzadas filtram pelos clientes ATIVOS", () => {
  // Ler o banco cru sem `$match` nenhum contaria cliente desativado — e, pior,
  // contaria um cliente que foi apagado do registro mas cujos documentos ainda
  // estão lá. O `$in` na lista de ativos é o que mantém a resposta igual à do
  // laço por banco que existia antes.
  const fs = require("node:fs");
  const path = require("node:path");

  for (const arquivo of ["UserCategory_model.js", "RecipeCategory_model.js"]) {
    const texto = fs.readFileSync(path.join(__dirname, "..", "..", "model", arquivo), "utf8");
    assert.ok(
      texto.includes("instance: { $in: ativos }"),
      `${arquivo} lê o banco cru sem filtrar pelos clientes ativos`
    );
  }
});

test("toda collection de cliente que um modelo toca está DECLARADA", () => {
  // ── O DEFEITO QUE ISTO FECHA ───────────────────────────────────────────────
  //
  // `diet_templates` e `recipe_categories` eram usadas por modelos e não estavam
  // em `POR_INSTANCIA`. Existiam só porque o Mongo cria a collection na primeira
  // inserção — e por isso nunca ganharam índice.
  //
  // Com um banco por cliente o preço era baixo: varrer uma collection de dois
  // documentos. Num banco só, é varrer os documentos de TODOS os clientes a cada
  // abertura de tela. E a migração deixaria os dados para trás, porque ela copia
  // o que está declarado.
  //
  // Achei as duas conferindo uma diferença de 2 documentos no ensaio da migração.
  // Não quero depender de eu conferir: aqui a lista é comparada com o uso.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "..", "model");

  // Collections do PAINEL: quem cria e indexa é o outro sistema, e este backend
  // só as lê pelo `centralDb()`. A fronteira está no cabeçalho de
  // `config/mongodb.js` — duas fontes criando o mesmo índice daria dois lugares
  // para manter, um sempre atrasado.
  const DO_PAINEL = new Set([
    "instances", "plans", "settings", "admins", "sessions", "groups",
    "client_errors", "commissions", "oauth_states", "food_images",
    "exercise_clips", "user_categories", "all_users", "all_avatars",
    // O SUPORTE (01/09/2026): o chamado é uma conversa entre um cliente e NÓS.
    // Quem atende trabalha numa fila só, no painel — no banco de cada instância
    // ela estaria espalhada em tantos lugares quantos clientes existem. Aqui
    // este backend escreve nelas (o cliente abre e responde do app dele), e o
    // `instance` é campo, como em todo o resto do central.
    "tickets", "ticket_messages", "faq_posts",
    // AS SOLICITAÇÕES DE EXCLUSÃO (02/09/2026): mesma família dos chamados, e
    // por um motivo a mais — o pedido tem de SOBREVIVER à exclusão que ele
    // pede. Guardado no banco do cliente, ele desapareceria junto com a prova
    // de que alguém pediu, e com o nome e o e-mail de quem pedir.
    //
    // Este backend só ESCREVE (a pessoa pedindo, do app dela) e lê o próprio
    // pedido; quem atende trabalha no painel, que é quem cria os índices.
    "deletion_requests",
    // AS IDEIAS (04/09/2026): "gostaria de um botão para ver ideias, e poder
    // sugerir ideias". O quadro é UM só para todos os clientes, e é o voto que
    // exige isso — com a lista no banco de cada instância, o voto do Willian não
    // somaria com o da Bruna, e o número diria "quantos querem isto dentro da
    // minha academia", que não prioriza nada.
    //
    // Este backend escreve nelas (a pessoa sugere e vota do app dela) e o painel
    // responde. Os índices — inclusive o único que impede votar duas vezes —
    // nascem no painel, como manda a fronteira do cabeçalho de config/mongodb.js.
    // E `idea_comments` (04/09/2026): *"quero que as pessoas comentem etc."* O fio
    // é público a todos os clientes, então mora onde as ideias moram.
    "idea_posts", "idea_votes", "idea_comments",
  ]);

  const declaradas = new Set([...schema.POR_INSTANCIA, ...schema.CENTRAL, ...DO_PAINEL]);
  const faltando = new Map();

  for (const arquivo of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const texto = fs.readFileSync(path.join(dir, arquivo), "utf8");
    for (const m of texto.matchAll(/\.collection\("([a-z_]+)"/g)) {
      if (!declaradas.has(m[1])) faltando.set(m[1], arquivo);
    }
  }

  assert.deepEqual(
    [...faltando.entries()],
    [],
    "collection usada por modelo e não declarada em POR_INSTANCIA/CENTRAL/DO_PAINEL"
  );
});
