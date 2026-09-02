const instanceContext = require("./instance.js");
const caches = require("./cachesDeLeitura.js");

// O ESCOPO DE CLIENTE, aplicado por construção.
//
// ── O que este arquivo substitui ────────────────────────────────────────────
//
// Até aqui cada cliente tinha o próprio banco (`gofitnow_marlon`,
// `gofitnow_bruna`), e disso vinha uma garantia que valia ouro: uma query sem
// filtro NÃO alcançava dado de outro cliente, porque ele não estava ali. Nenhum
// dos 399 pontos que pegam collection precisava lembrar de filtrar.
//
// Um banco por cliente não escala. São 35 collections e ~99 índices por cliente,
// e o WiredTiger cria um arquivo para cada um: com mil clientes são 35 mil
// collections e ~134 mil arquivos; com cem mil, milhões. O catálogo do Mongo mora
// em RAM e cada collection custa um descritor — o servidor deixa de subir muito
// antes da meta.
//
// Então tudo passa a morar num banco só, com o campo `instance` em cada
// documento. E aí a garantia acima morre: uma query sem filtro passa a ver todo
// mundo.
//
// ── Por que não filtrar nos 399 lugares ─────────────────────────────────────
//
// Porque um esquecido é vazamento entre clientes, e vazamento silencioso: a tela
// mostra dado alheio sem erro nenhum. Trezentos e noventa e nove chances de
// errar, e a revisão que encontra 398 não serve.
//
// A garantia volta a ser ESTRUTURAL, num lugar só: os modelos pedem a collection
// ao `connectToServer()`, que devolve um banco escopado. O `.collection()` dele
// entrega este proxy, que injeta o cliente em todo filtro, todo documento
// inserido e toda agregação. Os 45 modelos não mudam de linha.
//
// ── Por que proxy que RECUSA, e não que repassa ─────────────────────────────
//
// Um proxy que repassasse o desconhecido seria pior que nada: o dia em que o
// driver ganhar um método novo — ou alguém usar um que hoje não aparece no
// código — a chamada sairia SEM escopo e sem aviso. Aqui o desconhecido estoura
// com o nome do método, e quem for usá-lo tem de vir aqui declarar como ele é
// escopado. É a mesma escolha do facade dos testes: recusar é o que transforma
// "esqueci" em erro na cara.
const CAMPO = "instance";

// ── Onde mora o filtro em cada método ──────────────────────────────────────
//
// A posição do filtro muda de método para método, e é só isso que a tabela diz.
// `distinct(campo, filtro)` é o único com o filtro fora da primeira posição, e
// foi justamente o que me fez escrever isto como tabela em vez de ifs.
const FILTRO_EM = {
  find: 0,
  findOne: 0,
  countDocuments: 0,
  deleteOne: 0,
  deleteMany: 0,
  updateOne: 0,
  updateMany: 0,
  replaceOne: 0,
  findOneAndUpdate: 0,
  findOneAndDelete: 0,
  findOneAndReplace: 0,
  distinct: 1,
};

// Métodos que INSEREM: o cliente entra no documento, não num filtro.
const INSEREM = new Set(["insertOne", "insertMany"]);

// ── QUAIS DELES ESCREVEM ──────────────────────────────────────────────────
//
// Só estes disparam a limpeza de cache lá embaixo, e a distinção não é
// cosmética: `find` devolve um CURSOR, não uma promessa. Embrulhá-lo num
// `.then()` para acrescentar a limpeza quebra o `.sort()` que vem depois — foi o
// que um teste pegou na primeira versão disto.
const ESCREVEM = new Set([
  "deleteOne",
  "deleteMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
]);

// ── O que é RECUSADO, e por quê ────────────────────────────────────────────
//
// `createIndex` e `dropIndex`: índice é assunto de schema, e num banco único todo
// índice precisa do `instance` como PRIMEIRO campo — senão a query varre os
// outros clientes. Reescrever a chave aqui por baixo esconderia justamente a
// decisão que precisa estar visível em `database/schema.js`. Quem cria índice
// pega o banco cru, de propósito.
//
// `drop` e `dropIndexes`: apagariam a collection de TODO MUNDO. Antes eram
// operações de um cliente só, porque o banco era de um cliente só. Hoje seriam
// catástrofe, e o nome do método não avisa mais isso.
//
// `estimatedDocumentCount`: conta a collection inteira, sem filtro — não existe
// versão escopada dela. Quem quer contar de um cliente usa `countDocuments`.
//
// `watch`: um change stream escopado precisa de pipeline própria; ninguém usa
// hoje, e deixar passar seria entregar eventos de todos os clientes.
const RECUSADOS = {
  createIndex: "índice é schema: use o banco cru e ponha `instance` como primeiro campo (ver database/schema.js)",
  createIndexes: "índice é schema: use o banco cru (ver database/schema.js)",
  dropIndex: "índice é schema: use o banco cru",
  dropIndexes: "índice é schema: use o banco cru",
  drop: "apagaria a collection de TODOS os clientes; para apagar um cliente use deleteMany",
  estimatedDocumentCount: "conta a collection inteira, sem cliente; use countDocuments",
  watch: "entregaria eventos de todos os clientes; um change stream escopado precisa de pipeline própria",
};

function comCliente(filtro, instancia) {
  // O cliente entra como IGUALDADE no topo, o que é um E implícito com o resto.
  // Vale para `$or`, `$and` e `$expr` já presentes: eles continuam valendo,
  // dentro do cliente.
  //
  // E é igualdade de propósito por causa do upsert: quando o `updateOne` insere,
  // o Mongo copia para o documento novo os campos de igualdade do filtro — então
  // o `instance` entra no inserido sem ninguém precisar lembrar.
  return { ...(filtro || {}), [CAMPO]: instancia };
}

function comClienteNoDoc(doc, instancia) {
  if (!doc || typeof doc !== "object") {
    throw new TypeError("documento inválido para inserir");
  }
  // O cliente é escrito DEPOIS do documento: se o chamador mandou um `instance`
  // (de um dado exportado, de um teste, de um copiar-e-colar), o do contexto
  // vence. O contrário deixaria um documento entrar no cliente errado.
  return { ...doc, [CAMPO]: instancia };
}

// A agregação recebe o `$match` do cliente como PRIMEIRO estágio.
//
// Primeiro por duas razões, e as duas importam: o Mongo só usa índice no `$match`
// que vem antes de qualquer estágio que embaralhe (`$group`, `$unwind`,
// `$lookup`), e um `$match` depois de um `$group` já teria agrupado dado alheio —
// o total sairia somando outros clientes antes de filtrar.
//
// O que este estágio NÃO alcança: o interior de um `$lookup`. A sub-pipeline dele
// é outra consulta, e o `from` aponta para a collection inteira. Hoje os três
// `$lookup` do projeto casam por `ObjectId`, que é único global — então a
// CORREÇÃO está garantida (nenhum id de um cliente aparece no outro). O que falta
// lá é desempenho, e está tratado à mão em cada um.
function pipelineComCliente(pipeline, instancia) {
  if (!Array.isArray(pipeline)) throw new TypeError("pipeline de agregação precisa ser array");
  return [{ $match: { [CAMPO]: instancia } }, ...pipeline];
}

// `bulkWrite` é uma lista de operações de tipos diferentes, cada uma com o filtro
// (ou o documento) num lugar próprio. Sem tratar uma a uma, um `updateOne` dentro
// de um bulk sairia sem cliente.
function bulkComCliente(operacoes, instancia) {
  if (!Array.isArray(operacoes)) throw new TypeError("bulkWrite precisa de array de operações");

  return operacoes.map((op) => {
    if (!op || typeof op !== "object") throw new TypeError("operação inválida em bulkWrite");
    const [tipo] = Object.keys(op);

    if (tipo === "insertOne") {
      return { insertOne: { ...op.insertOne, document: comClienteNoDoc(op.insertOne?.document, instancia) } };
    }
    if (tipo === "updateOne" || tipo === "updateMany" || tipo === "replaceOne" ||
        tipo === "deleteOne" || tipo === "deleteMany") {
      return { [tipo]: { ...op[tipo], filter: comCliente(op[tipo]?.filter, instancia) } };
    }
    // Tipo novo do driver: estoura em vez de passar sem escopo.
    throw new Error(`bulkWrite: operação "${tipo}" não sabe se escopar em lib/escopo.js`);
  });
}

// Envolve UMA collection. `instancia` é passada em vez de lida aqui dentro para o
// teste poder exercitar sem montar contexto assíncrono — e porque o `escopar()`
// abaixo já a resolveu uma vez, no ponto certo.
function colecaoEscopada(col, instancia) {
  if (!instancia) throw new Error("no_instance_in_context");

  return new Proxy(col, {
    get(alvo, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(alvo, prop, receiver);

      if (RECUSADOS[prop]) {
        return () => {
          throw new Error(`${prop} não é permitido numa collection escopada: ${RECUSADOS[prop]}`);
        };
      }

      if (INSEREM.has(prop)) {
        return (docs, ...resto) => {
          const carga = prop === "insertMany"
            ? (Array.isArray(docs) ? docs : (() => { throw new TypeError("insertMany precisa de array"); })())
                .map((d) => comClienteNoDoc(d, instancia))
            : comClienteNoDoc(docs, instancia);
          return alvo[prop](carga, ...resto);
        };
      }

      if (prop === "aggregate") {
        return (pipeline = [], ...resto) => alvo.aggregate(pipelineComCliente(pipeline, instancia), ...resto);
      }

      if (prop === "bulkWrite") {
        return (ops, ...resto) =>
          Promise.resolve(alvo.bulkWrite(bulkComCliente(ops, instancia), ...resto)).then((v) => {
            // Um bulk mistura filtros; qual linha mudou não se sabe daqui. O
            // cache do cliente inteiro cai, que é o seguro.
            caches.aoEscrever(alvo.collectionName, null, instancia);
            return v;
          });
      }

      if (prop in FILTRO_EM) {
        const posicao = FILTRO_EM[prop];
        return (...args) => {
          const copia = [...args];
          // Preenche o que falta até a posição do filtro: `findOne()` sem
          // argumento nenhum é válido no driver e precisa virar
          // `findOne({instance})`, não `findOne(undefined, ..., {instance})`.
          while (copia.length <= posicao) copia.push(undefined);
          copia[posicao] = comCliente(copia[posicao], instancia);

          const r = alvo[prop](...copia);
          if (!ESCREVEM.has(prop)) return r;

          // ── QUEM ESCREVE NÃO PRECISA LEMBRAR DE LIMPAR O CACHE ──────────
          //
          // Ver `lib/cachesDeLeitura.js`. Aqui é o único lugar por onde TODA
          // escrita de cliente passa — e foi por não existir esse lugar que
          // três caminhos ficaram para trás quando o cache de sessão entrou
          // (`savePreferences`, `revokeStudentAccess`, o `avatarAt` do
          // Avatar_model).
          //
          // Depois da escrita, e não antes: limpar antes deixa uma fresta em que
          // uma leitura concorrente regrava o valor VELHO.
          return Promise.resolve(r).then((valor) => {
            caches.aoEscrever(alvo.collectionName, copia[posicao], instancia);
            return valor;
          });
        };
      }

      const valor = Reflect.get(alvo, prop, receiver);

      // Propriedade que não é função (o `collectionName`, por exemplo) passa.
      // Função desconhecida, não: ela sairia sem escopo, e é justamente o que
      // este arquivo existe para impedir.
      if (typeof valor === "function") {
        return () => {
          throw new Error(
            `"${prop}" não sabe se escopar por cliente. Declare em lib/escopo.js ` +
              `(em FILTRO_EM, INSEREM ou RECUSADOS) antes de usar.`
          );
        };
      }
      return valor;
    },
  });
}

// Envolve o BANCO: só o `.collection()` muda, e é por ele que todo modelo passa.
//
// A instância é lida AQUI, uma vez por `.collection()`, e não dentro de cada
// método: assim uma collection guardada numa variável não muda de cliente no meio
// de uma requisição. `required()` estoura quando não há contexto — que é o que
// já protegia o `instanceDb()` antes.
function escopar(db, instancia = instanceContext.required()) {
  return new Proxy(db, {
    get(alvo, prop, receiver) {
      if (prop === "collection") {
        return (nome, ...resto) => colecaoEscopada(alvo.collection(nome, ...resto), instancia);
      }
      return Reflect.get(alvo, prop, receiver);
    },
  });
}

module.exports = {
  escopar,
  colecaoEscopada,
  comCliente,
  comClienteNoDoc,
  pipelineComCliente,
  bulkComCliente,
  CAMPO,
  RECUSADOS,
  FILTRO_EM,
};
