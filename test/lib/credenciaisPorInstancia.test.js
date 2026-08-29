const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const escopo = require("../../lib/escopo.js");
const instanceContext = require("../../lib/instance.js");
const ApiKey_model = require("../../model/ApiKey_model.js");
const Auth_model = require("../../model/Auth_model.js");

// A CREDENCIAL É DADO DO CLIENTE — e é isso que impede o vazamento entre eles.
//
// ── O medo, dito por quem usa ───────────────────────────────────────────────
//
// "tenho medo da parte do mcp, acabar consultando dados de outra instancia sem
// querer, já que agora o banco é único".
//
// O medo é o certo, e a resposta não está no MCP: está aqui. O caminho de uma
// chamada MCP é `X-Instance` (ou o host) → `instanceGate` confere na central e
// abre o contexto → `ApiKeyAuth` procura a chave → as ferramentas usam os
// modelos → todo modelo pega collection pelo `connectToServer()`, que é escopado.
//
// O elo que sustenta tudo é o do meio: a chave e o token de sessão são
// DOCUMENTOS COMO OS OUTROS, guardados com `instance`. Uma chave da instância A
// apresentada com o cabeçalho da B não é "recusada por permissão" — ela não
// EXISTE naquele escopo. Não há dado da B para alcançar porque não há sessão.
//
// ── Por que este teste existe, tendo escopo.test.js ─────────────────────────
//
// `escopo.test.js` prova que o proxy injeta o cliente. Ele não prova que a
// AUTENTICAÇÃO passa por ele — e é justamente aí que uma otimização razoável
// abriria tudo: procurar a chave uma vez na central, ou no banco cru, em vez de
// uma busca escopada por requisição. O código ficaria mais rápido, os testes
// todos continuariam verdes, e uma chave passaria a valer em qualquer instância.
//
// Então o que se afirma aqui é o comportamento de ponta: a MESMA chave, em dois
// contextos, com um único banco embaixo.

// Um banco só, como em produção: uma lista de documentos com `instance` em cada.
// O filtro é comparado de verdade — é o que faz o teste medir isolamento em vez
// de medir o dublê.
function bancoUnico() {
  const docs = { api_keys: [], user_tokens: [] };

  const casa = (doc, filtro) =>
    Object.entries(filtro).every(([campo, valor]) => {
      if (valor === null) return doc[campo] === null || doc[campo] === undefined;
      return String(doc[campo]) === String(valor);
    });

  const cru = {
    collection(nome) {
      docs[nome] = docs[nome] || [];
      const lista = docs[nome];

      return {
        collectionName: nome,
        async findOne(filtro) {
          return lista.find((d) => casa(d, filtro)) || null;
        },
        async insertOne(doc) {
          lista.push({ ...doc, _id: doc._id || crypto.randomUUID() });
          return { insertedId: lista[lista.length - 1]._id };
        },
        async updateOne(filtro, update) {
          const doc = lista.find((d) => casa(d, filtro));
          if (doc) Object.assign(doc, update.$set || {});
          return { matchedCount: doc ? 1 : 0 };
        },
        async deleteOne(filtro) {
          const i = lista.findIndex((d) => casa(d, filtro));
          if (i >= 0) lista.splice(i, 1);
          return { deletedCount: i >= 0 ? 1 : 0 };
        },
        async deleteMany(filtro) {
          const antes = lista.length;
          for (let i = lista.length - 1; i >= 0; i--) if (casa(lista[i], filtro)) lista.splice(i, 1);
          return { deletedCount: antes - lista.length };
        },
        find(filtro) {
          // `sort` e `limit` existem porque o driver os tem e os modelos os
          // encadeiam. Devolver `this` mantém o encadeamento sem ordenar de
          // verdade: o que este arquivo mede é o FILTRO, não a ordem.
          const cursor = {
            sort: () => cursor,
            limit: () => cursor,
            project: () => cursor,
            async toArray() {
              return lista.filter((d) => casa(d, filtro));
            },
          };
          return cursor;
        },
      };
    },
  };

  // O MESMO caminho dos modelos em produção: `connectToServer` devolve o banco
  // escopado pelo cliente do contexto.
  return {
    docs,
    app: {
      crypto,
      // O `Auth_model` gera o token por aqui, como em produção.
      uuidv4: () => crypto.randomUUID(),
      mongodb: { connectToServer: async () => escopo.escopar(cru) },
    },
  };
}

const em = (instancia, fn) => instanceContext.run(instancia, fn);

test("a chave criada numa instância NÃO autentica na outra", async () => {
  const { app, docs } = bancoUnico();
  const chaves = new ApiKey_model(app);

  const criada = await em("marlon", () => chaves.create("507f1f77bcf86cd799439011", "MCP"));
  const segredo = criada.key || criada.chave || criada;
  assert.equal(typeof segredo, "string");

  // Na casa dela, vale.
  const naDela = await em("marlon", () => chaves.verify(segredo));
  assert.ok(naDela, "a chave tem de valer na instância que a criou");

  // Na casa de outro, não existe. É a diferença que importa: não é "sem
  // permissão", é sem sessão — e sem sessão nenhuma ferramenta roda.
  const naOutra = await em("bruna", () => chaves.verify(segredo));
  assert.equal(naOutra, undefined);

  // E o documento gravado carrega o cliente: é isso que o escopo procura.
  assert.equal(docs.api_keys.length, 1);
  assert.equal(docs.api_keys[0].instance, "marlon");
});

test("o token de sessão também é da instância, não do sistema", async () => {
  const { app, docs } = bancoUnico();
  const auth = new Auth_model(app);

  const token = await em("marlon", () => auth.registerToken("507f1f77bcf86cd799439011"));
  const valor = typeof token === "string" ? token : token?.token;

  assert.ok(await em("marlon", () => auth.verify(valor)));
  assert.ok(!(await em("bruna", () => auth.verify(valor))));

  assert.equal(docs.user_tokens[0].instance, "marlon");
});

test("duas instâncias com dados no MESMO banco não se veem", async () => {
  const { app, docs } = bancoUnico();
  const chaves = new ApiKey_model(app);

  const daMarlon = await em("marlon", () => chaves.create("507f1f77bcf86cd799439011", "A"));
  const daBruna = await em("bruna", () => chaves.create("507f1f77bcf86cd799439022", "B"));

  const segredoMarlon = daMarlon.key || daMarlon;
  const segredoBruna = daBruna.key || daBruna;

  // Duas linhas no mesmo banco — é o cenário do banco único, não uma abstração.
  assert.equal(docs.api_keys.length, 2);

  // Cada uma só é encontrada na sua.
  assert.ok(await em("marlon", () => chaves.verify(segredoMarlon)));
  assert.ok(await em("bruna", () => chaves.verify(segredoBruna)));
  assert.equal(await em("marlon", () => chaves.verify(segredoBruna)), undefined);
  assert.equal(await em("bruna", () => chaves.verify(segredoMarlon)), undefined);
});

test("sem contexto de instância, autenticar ESTOURA — não cai num padrão", async () => {
  // É o que garante que uma rota nova, esquecida fora do `instanceGate`, falhe
  // ruidosamente em vez de rodar sem cliente. Fechar é o padrão.
  const { app } = bancoUnico();
  const chaves = new ApiKey_model(app);

  // Com o prefixo CERTO: `verify` recusa outro formato antes de tocar o banco,
  // e um teste com prefixo errado passaria sem provar nada.
  await assert.rejects(() => chaves.verify("gfn_abc123_umsegredoqualquer"), /no_instance_in_context/);
});

test("listar chaves de um usuário não atravessa a instância", async () => {
  const { app } = bancoUnico();
  const chaves = new ApiKey_model(app);
  const dono = "507f1f77bcf86cd799439011";

  await em("marlon", () => chaves.create(dono, "A"));

  // O MESMO id de usuário, na outra instância: um id não é um passe. Se a busca
  // fosse por `user` sem cliente, a lista da Bruna mostraria a chave do Marlon.
  const naOutra = await em("bruna", () => chaves.list(dono));
  assert.deepEqual(naOutra, []);

  // E na dela continua aparecendo — o teste não passaria por a busca estar
  // quebrada dos dois lados.
  assert.equal((await em("marlon", () => chaves.list(dono))).length, 1);
});
