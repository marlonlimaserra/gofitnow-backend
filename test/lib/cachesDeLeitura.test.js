const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ObjectId } = require("mongodb");

const caches = require("../../lib/cachesDeLeitura.js");
const escopo = require("../../lib/escopo.js");

// A LIMPEZA DE CACHE É ESTRUTURAL — quem escreve não precisa lembrar dela.
//
// ── Por que ela deixou de ser "lembrar" ───────────────────────────────────
//
// O cache de sessão nasceu com a limpeza escrita à mão nos modelos, e três
// caminhos ficaram para trás no MESMO dia — cada um achado por um caminho
// diferente:
//
//   `savePreferences`      o Marlon previu de cabeça
//   `revokeStudentAccess`  e este era de segurança
//   `Avatar_model`         que nem chama a collection pelo nome
//
// A terceira é a que decide o desenho. Uma busca por `collection("users")` não a
// encontra, porque ela pega a collection por outro caminho — então NENHUMA
// varredura de texto daria conta, e um teste que varre texto teria dito que
// estava tudo bem.
//
// A cura foi mover a limpeza para `lib/escopo.js`, o proxy por onde toda escrita
// de cliente passa obrigatoriamente para ganhar o `instance`. Acrescentar uma
// função que escreve não exige nada: ela já nasce coberta.

test("o id sai do filtro quando ele mira um documento", () => {
  const id = new ObjectId();
  assert.deepEqual(caches.idsDoFiltro({ _id: id }), [String(id)]);
  assert.deepEqual(caches.idsDoFiltro({ _id: String(id) }), [String(id)]);
});

test("e vários, quando o filtro mira vários", () => {
  const a = new ObjectId();
  const b = new ObjectId();
  assert.deepEqual(caches.idsDoFiltro({ _id: { $in: [a, b] } }), [String(a), String(b)]);
});

test("filtro SEM _id devolve null — e null quer dizer 'derruba tudo'", () => {
  // Um `updateMany` por outro campo alcança linhas que não dá para nomear daqui.
  // Derrubar o cache do cliente inteiro é desperdício, e é o desperdício certo:
  // o contrário é servir dado velho sem saber.
  assert.equal(caches.idsDoFiltro({ instance: "bruna", type: "student" }), null);
  assert.equal(caches.idsDoFiltro({}), null);
  assert.equal(caches.idsDoFiltro(undefined), null);
});

test("as collections cobertas são as que alimentam algum cache", () => {
  const cobertas = Object.keys(caches.QUANDO_ESCREVE).sort();
  assert.deepEqual(cobertas, ["brand_images", "configurations", "users"]);
});

// ── O GANCHO DE VERDADE, exercitado pelo proxy ────────────────────────────

function colecaoFalsa(nome) {
  const feitas = [];
  const col = {
    collectionName: nome,
    async updateOne(filtro) { feitas.push({ op: "updateOne", filtro }); return { matchedCount: 1 }; },
    async deleteOne(filtro) { feitas.push({ op: "deleteOne", filtro }); return { deletedCount: 1 }; },
    find(filtro) { feitas.push({ op: "find", filtro }); return { sort: () => ({ toArray: async () => [] }) }; },
    async findOne(filtro) { feitas.push({ op: "findOne", filtro }); return null; },
  };
  return { col, feitas };
}

test("escrever numa collection SEM cache não chama nada", () => {
  const { col } = colecaoFalsa("diets");
  const escopada = escopo.colecaoEscopada(col, "bruna");

  // Sem cache registrado para `diets`, o gancho é um caminho morto — e não pode
  // custar nem uma chamada.
  assert.doesNotThrow(() => escopada.updateOne({ _id: new ObjectId() }, { $set: { x: 1 } }));
});

test("LER não passa pelo gancho — e o find continua devolvendo um CURSOR", () => {
  // A primeira versão embrulhava TODOS os métodos num `.then()` para acrescentar
  // a limpeza. `find` devolve um cursor, não uma promessa: o `.sort()` seguinte
  // quebrou, e um teste de outra área pegou.
  const { col } = colecaoFalsa("users");
  const escopada = escopo.colecaoEscopada(col, "bruna");

  const cursor = escopada.find({});
  assert.equal(typeof cursor.sort, "function", "o find deixou de devolver cursor");
});

test("o filtro que chega ao gancho é o JÁ ESCOPADO", async () => {
  // Ele precisa carregar o `instance`, senão a limpeza de um cliente poderia ser
  // disparada pela escrita de outro.
  const { col, feitas } = colecaoFalsa("users");
  const escopada = escopo.colecaoEscopada(col, "bruna");

  await escopada.updateOne({ _id: new ObjectId() }, { $set: { name: "x" } });

  const escrita = feitas.find((f) => f.op === "updateOne");
  assert.equal(escrita.filtro.instance, "bruna");
});

// ── O QUE O CÓDIGO PRECISA CONTINUAR FAZENDO ──────────────────────────────

const escopoTexto = fs.readFileSync(
  path.join(__dirname, "..", "..", "lib", "escopo.js"),
  "utf8"
);

test("a limpeza acontece DEPOIS da escrita", () => {
  // Limpar antes deixa uma fresta: uma leitura concorrente entra no meio e
  // regrava o cache com o valor VELHO, que então sobrevive o prazo inteiro.
  const semComentarios = escopoTexto
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  // Só o trecho do ramo que interessa. `indexOf` no arquivo inteiro acha o
  // `aoEscrever` do bulkWrite, que fica ANTES no texto e é outro ramo — foi o que
  // reprovou este teste na primeira vez. Posição no arquivo não é ordem de
  // execução.
  const ramo = semComentarios.slice(semComentarios.indexOf("if (prop in FILTRO_EM)"));

  const escrita = ramo.indexOf("const r = alvo[prop](...copia);");
  const limpeza = ramo.indexOf("caches.aoEscrever(alvo.collectionName");

  assert.ok(escrita > 0, "a chamada da escrita mudou de forma");
  assert.ok(limpeza > escrita, "a limpeza subiu para antes da escrita");
});

test("o bulkWrite também avisa, e derruba tudo", () => {
  // Um bulk mistura filtros; qual linha mudou não se sabe daqui.
  const trecho = escopoTexto.slice(escopoTexto.indexOf('prop === "bulkWrite"'));
  assert.match(trecho.slice(0, 600), /caches\.aoEscrever\(alvo\.collectionName, null/);
});

test("só os métodos de ESCRITA disparam o gancho", () => {
  const m = /const ESCREVEM = new Set\(\[([\s\S]*?)\]\);/.exec(escopoTexto);
  assert.ok(m, "a lista de métodos de escrita sumiu");

  const lista = m[1];
  for (const escreve of ["updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate"]) {
    assert.ok(lista.includes(escreve), `${escreve} escreve e ficou de fora`);
  }
  for (const le of ["find", "findOne", "countDocuments", "distinct"]) {
    assert.ok(!lista.includes(`"${le}"`), `${le} é leitura e não pode disparar limpeza`);
  }
});
