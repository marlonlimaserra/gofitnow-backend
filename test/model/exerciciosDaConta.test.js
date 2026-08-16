const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Exercise_model = require("../../model/Exercise_model.js");
const instanceContext = require("../../lib/instance.js");

// O catálogo compartilhado e os exercícios de cada conta, na MESMA collection.
//
// O que separa uma conta da outra não é um banco nem uma collection: é o campo
// `instance` e o filtro que toda consulta carrega. Isso torna a paginação
// trivial — uma consulta, uma ordenação, um skip — e concentra o risco num
// lugar só: uma consulta que esqueça o filtro entrega o exercício de um cliente
// para outro.
//
// Estes casos existem para essa consulta não poder ser escrita errada em
// silêncio.
const COMPARTILHADO = { _id: new ObjectId(), name: "Afundo + remada cross", instance: null };
const MEU = { _id: new ObjectId(), name: "Afundo + remada cross + alter", instance: "marlon" };
const DE_OUTRA = { _id: new ObjectId(), name: "Segredo da Bruna", instance: "bruna" };

const TODOS = [COMPARTILHADO, MEU, DE_OUTRA];

// Um Mongo de mentira que aplica os filtros de verdade. É o ponto: se o modelo
// esquecer o filtro, este fake devolve o documento da outra conta — e o teste
// falha, que é o que um fake permissivo demais nunca faria.
function monta(docs = TODOS) {
  const escritas = [];
  // Como a lista pediu a ordenação. O fake não ordena de verdade — o que importa
  // guardar é o CRITÉRIO, porque é ele que decide o que a pessoa vê primeiro.
  const ordens = [];

  function casa(doc, query) {
    return Object.entries(query).every(([campo, cond]) => {
      const valor = doc[campo] === undefined ? null : doc[campo];
      if (cond && typeof cond === "object" && !(cond instanceof ObjectId)) {
        if ("$in" in cond) return cond.$in.some((v) => String(v) === String(valor));
        if ("$nin" in cond) return !cond.$nin.some((v) => String(v) === String(valor));
        if ("$regex" in cond) return new RegExp(cond.$regex).test(String(valor || ""));
        // `$exists` é conferido ANTES de `$ne`, e a ordem importa: a consulta
        // real manda `{$exists: true, $ne: ""}` juntos. Conferindo só o `$ne`
        // primeiro, o documento SEM o campo passava — "null" é diferente de ""
        // — e o filtro não filtrava nada.
        if ("$exists" in cond) {
          const tem = doc[campo] !== undefined && doc[campo] !== null;
          if (tem !== Boolean(cond.$exists)) return false;
        }
        if ("$ne" in cond) return String(valor) !== String(cond.$ne);
      }
      return String(valor) === String(cond);
    });
  }

  const col = {
    async countDocuments(query) {
      return docs.filter((d) => casa(d, query)).length;
    },
    find(query) {
      let saida = docs.filter((d) => casa(d, query));
      const cursor = {
        sort: (criterio) => (ordens.push(criterio), cursor),
        skip: (n) => ((saida = saida.slice(n)), cursor),
        limit: (n) => ((saida = saida.slice(0, n)), cursor),
        async toArray() {
          return saida;
        },
      };
      return cursor;
    },
    async findOne(query) {
      return docs.find((d) => casa(d, query)) || null;
    },
    async insertOne(doc) {
      escritas.push({ tipo: "insert", doc });
      return { insertedId: new ObjectId() };
    },
    async updateOne(query, mudanca) {
      escritas.push({ tipo: "update", query, mudanca });
      return { matchedCount: docs.filter((d) => casa(d, query)).length };
    },
    async deleteOne(query) {
      escritas.push({ tipo: "delete", query });
      return { deletedCount: docs.filter((d) => casa(d, query)).length };
    },
    aggregate(etapas) {
      const filtrados = docs.filter((d) => casa(d, etapas[0].$match));
      return {
        async toArray() {
          return [...new Set(filtrados.map((d) => d.muscleGroup).filter(Boolean))].map((g) => ({
            _id: g,
            total: filtrados.filter((d) => d.muscleGroup === g).length,
          }));
        },
      };
    },
  };

  const app = { mongodb: { async centralDb() { return { collection: () => col } } } };
  return { modelo: new Exercise_model(app), escritas, ordens };
}

const comoMarlon = (fn) => instanceContext.run("marlon", fn);

test("a conta vê o compartilhado e o dela — nunca o da outra", async () => {
  const { modelo } = monta();

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20 }));
  const nomes = r.rows.map((e) => e.name);

  assert.ok(nomes.includes("Afundo + remada cross"), "o compartilhado é de todos");
  assert.ok(nomes.includes("Afundo + remada cross + alter"), "o meu é meu");
  assert.ok(!nomes.includes("Segredo da Bruna"), "o da outra conta NÃO pode aparecer");
  assert.equal(r.total, 2, "o total também conta só o que eu vejo");
});

test("documento antigo, sem o campo, continua sendo do catálogo compartilhado", async () => {
  // Os mil e quatrocentos que já estavam lá não têm `instance`. No Mongo, campo
  // ausente casa com null — sem isso o catálogo inteiro sumiria da tela no
  // primeiro deploy.
  const antigo = { _id: new ObjectId(), name: "Agachamento livre" };
  const { modelo } = monta([antigo]);

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20 }));

  assert.deepEqual(r.rows.map((e) => e.name), ["Agachamento livre"]);
});

test("a tela recebe `own`, e não o nome da instância", async () => {
  // O card decide entre editar no lugar e criar a minha versão; para isso ele
  // precisa saber a origem, não o nome do banco de ninguém.
  const { modelo } = monta();

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20 }));
  const meu = r.rows.find((e) => e.name === "Afundo + remada cross + alter");
  const compartilhado = r.rows.find((e) => e.name === "Afundo + remada cross");

  assert.equal(meu.own, true);
  assert.equal(compartilhado.own, false);
  assert.ok(!("instance" in meu), "o nome da instância não precisa sair daqui");
});

test("mine=1 mostra só o que é meu — é a tela de Meus exercícios", async () => {
  const { modelo } = monta();

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20, onlyMine: true }));

  assert.deepEqual(r.rows.map((e) => e.name), ["Afundo + remada cross + alter"]);
});

test("saber o id de outra conta não abre o exercício dela", async () => {
  // Id vaza: em URL, em log, em corpo de requisição. Se `data` procurasse só
  // por `_id`, quem tivesse um id de outro cliente leria o dado dele.
  const { modelo } = monta();

  const achado = await comoMarlon(() => modelo.data(String(DE_OUTRA._id)));

  assert.equal(achado, undefined);
});

test("o compartilhado e o meu são encontrados por id", async () => {
  const { modelo } = monta();

  assert.equal((await comoMarlon(() => modelo.data(String(COMPARTILHADO._id)))).name, "Afundo + remada cross");
  assert.equal((await comoMarlon(() => modelo.data(String(MEU._id)))).name, "Afundo + remada cross + alter");
});

test("o que se cria nasce da conta, e não do catálogo de todos", async () => {
  const { modelo, escritas } = monta();

  await comoMarlon(() => modelo.insert({ name: "Afundo + remada cross + alter", fromCatalog: String(COMPARTILHADO._id) }));

  const gravado = escritas.find((e) => e.tipo === "insert").doc;
  assert.equal(gravado.instance, "marlon");
  assert.equal(String(gravado.fromCatalog), String(COMPARTILHADO._id));
});

// ── A prescrição padrão ──────────────────────────────────────────────────
//
// Um exercício não é só um nome. Quem criou "Remada baixa com triângulo" já
// sabe que ele entra com 4 séries de 15/12/10/8 a partir de 90kg — e digitar
// isso de novo a cada treino é o trabalho que a ficha existe para evitar.

test("a prescrição padrão é gravada junto com o exercício", async () => {
  const { modelo, escritas } = monta();

  await comoMarlon(() =>
    modelo.insert({
      name: "Remada baixa com triângulo",
      defaultMethod: "pyramid",
      defaultGoal: "Hipertrofia",
      defaultSets: [
        { unit: "reps", quantity: "15", load: "90", rest: "60" },
        { unit: "reps", quantity: "12", load: "95" },
      ],
    })
  );

  const gravado = escritas.find((e) => e.tipo === "insert").doc;
  assert.equal(gravado.defaultMethod, "pyramid");
  assert.equal(gravado.defaultGoal, "Hipertrofia");
  assert.equal(gravado.defaultSets.length, 2);
  assert.deepEqual(gravado.defaultSets[0], {
    unit: "reps",
    quantity: "15",
    load: "90",
    intensity: "",
    speed: "",
    // A pausa é uma FAIXA: `rest` é o mínimo, `restMax` o teto.
    rest: "60",
    restMax: "",
  });
});

test("a pausa é uma faixa: mínimo e máximo", async () => {
  // "Descanse de 60 a 90 segundos" é como se prescreve — um número só obriga a
  // escolher entre o piso e o teto, e o profissional escreve o outro na dica.
  const { modelo, escritas } = monta();

  await comoMarlon(() =>
    modelo.insert({ name: "x", defaultSets: [{ quantity: "12", rest: "60", restMax: "90" }] })
  );

  const serie = escritas.find((e) => e.tipo === "insert").doc.defaultSets[0];
  assert.equal(serie.rest, "60");
  assert.equal(serie.restMax, "90");
});

test("série sem unidade cai em repetições — nunca em vazio", async () => {
  // A unidade decide o rótulo do campo na tela ("Repetições", "Segundos"). Vazia,
  // a série chegaria ao treino sem saber o que ela mede.
  const { modelo, escritas } = monta();

  await comoMarlon(() => modelo.insert({ name: "x", defaultSets: [{ quantity: "10" }] }));

  assert.equal(escritas.find((e) => e.tipo === "insert").doc.defaultSets[0].unit, "reps");
});

test("o que não é lista não vira prescrição", async () => {
  const { modelo, escritas } = monta();

  await comoMarlon(() => modelo.insert({ name: "x", defaultSets: "4x10" }));

  assert.deepEqual(escritas.find((e) => e.tipo === "insert").doc.defaultSets, []);
});

test("sem prescrição, o exercício continua nascendo vazio", async () => {
  // É o caso da maioria, e do catálogo compartilhado inteiro: quem não preencher
  // adiciona com uma série em branco, como sempre foi.
  const { modelo, escritas } = monta();

  await comoMarlon(() => modelo.insert({ name: "x" }));

  const gravado = escritas.find((e) => e.tipo === "insert").doc;
  assert.deepEqual(gravado.defaultSets, []);
  assert.equal(gravado.defaultMethod, "");
});

test("editar um compartilhado não muda nada — ele é de todos os clientes", async () => {
  // Este é o bug que a tela inteira existe para evitar: um "Editar" no card do
  // catálogo mudaria o exercício de todas as contas. Aqui a escrita simplesmente
  // não encontra alvo, e o controller responde 404.
  const { modelo } = monta();

  const ok = await comoMarlon(() => modelo.update(String(COMPARTILHADO._id), { name: "Outro nome" }));

  assert.equal(ok, false);
});

test("editar o exercício de outra conta também não encontra alvo", async () => {
  const { modelo } = monta();

  assert.equal(await comoMarlon(() => modelo.update(String(DE_OUTRA._id), { name: "x" })), false);
  assert.equal(await comoMarlon(() => modelo.delete(String(DE_OUTRA._id))), false);
});

test("o meu, esse sim, muda e some quando eu mando", async () => {
  const { modelo } = monta();

  assert.equal(await comoMarlon(() => modelo.update(String(MEU._id), { name: "Novo nome" })), true);
  assert.equal(await comoMarlon(() => modelo.delete(String(MEU._id))), true);
});

test("os grupos do filtro também param na fronteira da conta", async () => {
  // Um grupo que só existe no exercício de outro cliente não pode aparecer no
  // filtro: seria dizer que ele existe, e clicar traria uma lista vazia.
  const { modelo } = monta([
    { ...COMPARTILHADO, muscleGroup: "Costas" },
    { ...MEU, muscleGroup: "Funcional" },
    { ...DE_OUTRA, muscleGroup: "Pilates da Bruna" },
  ]);

  const nomes = (await comoMarlon(() => modelo.groups())).map((g) => g.name);

  assert.deepEqual(nomes.sort(), ["Costas", "Funcional"]);
});

// ── O exercício aposentado ───────────────────────────────────────────────
//
// O catálogo compartilhado tem mil e quatrocentas linhas, e parte delas é lixo:
// o mesmo exercício em dois grupos, o nome com e sem acento, o nome que não quer
// dizer nada. A central desliga essas linhas em vez de apagá-las — apagar
// alcança todo mundo de uma vez e não tem volta.
const APOSENTADO = {
  _id: new ObjectId(),
  name: "Aviaozinho",
  muscleGroup: "Ombros",
  instance: null,
  active: 0,
};

test("o exercício desligado some da lista", async () => {
  const { modelo } = monta([COMPARTILHADO, APOSENTADO]);

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20 }));

  assert.deepEqual(r.rows.map((e) => e.name), ["Afundo + remada cross"]);
  assert.equal(r.total, 1, "o rodapé não pode contar o que não aparece");
});

test("desligado por id CONTINUA abrindo — o treino de ontem não pode quebrar", async () => {
  // A separação que importa: parar de oferecer é uma coisa, sumir de um treino
  // já montado é outra. Se `data` filtrasse por ativo, uma limpeza de catálogo
  // apagaria exercício da ficha de aluno que nada tem a ver com ela.
  const { modelo } = monta([COMPARTILHADO, APOSENTADO]);

  const achado = await comoMarlon(() => modelo.data(String(APOSENTADO._id)));

  assert.equal(achado.name, "Aviaozinho");
});

test("quem nunca teve o campo continua em pé", async () => {
  // Os mil e quatrocentos existentes não têm `active`. No Mongo campo ausente não
  // casa com `1` — filtrar por `active: 1` esvaziaria o catálogo inteiro no
  // primeiro deploy.
  const { modelo } = monta([{ _id: new ObjectId(), name: "Agachamento livre" }]);

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20 }));

  assert.deepEqual(r.rows.map((e) => e.name), ["Agachamento livre"]);
});

test("o grupo que só o desligado tinha some do filtro", async () => {
  const { modelo } = monta([{ ...COMPARTILHADO, muscleGroup: "Costas" }, APOSENTADO]);

  const nomes = (await comoMarlon(() => modelo.groups())).map((g) => g.name);

  assert.deepEqual(nomes, ["Costas"]);
});

test("o que a conta cria nasce marcado como ativo", async () => {
  // Sem o campo escrito, a central não consegue listar "os desativados" sem
  // varrer tudo o que nunca o teve.
  const { modelo, escritas } = monta();

  await comoMarlon(() => modelo.insert({ name: "x" }));

  assert.equal(escritas.find((e) => e.tipo === "insert").doc.active, 1);
});

test("fora de uma requisição, nada é lido — falhar alto é a resposta segura", async () => {
  // Sem instância no contexto, um filtro com `undefined` viraria "os que não
  // têm dono": o catálogo compartilhado de todo mundo, servido a ninguém em
  // particular. Estourar é melhor que devolver a fatia errada em silêncio.
  const { modelo } = monta();

  await assert.rejects(() => modelo.list({ page: 1, limit: 20 }), /no_instance_in_context/);
});

// ── Só com demonstração ──────────────────────────────────────────────────
//
// O catálogo não tem mais vídeo do YouTube: ou o exercício tem o clipe em 3D que
// nós fizemos, ou não tem demonstração nenhuma. O filtro existe para ver o que
// já está pronto — e, invertido na cabeça de quem olha, é a lista do que falta.

test("o filtro mostra só o que tem demonstração", async () => {
  const { modelo } = monta([
    { _id: new ObjectId(), name: "Agachamento", instance: null, clipSlug: "agachamento-livre" },
    { _id: new ObjectId(), name: "Sem demonstração", instance: null },
  ]);

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20, comClipe: true }));

  assert.deepEqual(r.rows.map((e) => e.name), ["Agachamento"]);
  assert.equal(r.total, 1, "o rodapé conta só o que aparece");
});

test("sem o filtro, o catálogo inteiro continua aparecendo", async () => {
  const { modelo } = monta([
    { _id: new ObjectId(), name: "Agachamento", instance: null, clipSlug: "agachamento-livre" },
    { _id: new ObjectId(), name: "Sem demonstração", instance: null },
  ]);

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20 }));

  assert.equal(r.total, 2);
});

test("chave vazia não conta como demonstração", async () => {
  // Um `clipSlug: ""` gravado por engano faria o exercício entrar no filtro e
  // aparecer sem clipe nenhum na tela.
  const { modelo } = monta([{ _id: new ObjectId(), name: "x", instance: null, clipSlug: "" }]);

  const r = await comoMarlon(() => modelo.list({ page: 1, limit: 20, comClipe: true }));

  assert.equal(r.total, 0);
});

// ── A demonstração em 3D ─────────────────────────────────────────────────
//
// Cada PADRÃO de movimento ganhou um clipe animado (WebP, uns 70 KB) gerado a
// partir de um boneco articulado — sem YouTube, sem player, sem espera.
//
// Um por padrão, e não por exercício: o catálogo tem "Rosca direta articulada",
// "Rosca direta barra h", "Rosca direta cross", e as três mostram o mesmo
// cotovelo dobrando. O documento guarda só a CHAVE (`clipSlug`); o binário mora
// numa collection à parte, e a tela o busca por URL própria, que o navegador
// guarda em cache por um ano.

function comClipes(clipes = {}) {
  const app = {
    mongodb: {
      async centralDb() {
        return {
          collection: () => ({
            async findOne(q) {
              return clipes[q._id] || null;
            },
          }),
        };
      },
    },
  };
  return new Exercise_model(app);
}

test("o clipe é lido pela CHAVE do movimento, em bytes", async () => {
  const modelo = comClipes({
    "rosca-direta": { _id: "rosca-direta", webp: Buffer.from("webp-de-mentira"), updatedAt: new Date() },
  });

  const clipe = await modelo.clip("rosca-direta");

  assert.equal(clipe.dados.toString(), "webp-de-mentira");
  assert.ok(clipe.quando instanceof Date);
});

test("chave que não existe não devolve imagem vazia — devolve nada", async () => {
  // Um Buffer vazio viraria imagem quebrada na tela, que é pior que a ausência.
  // A rota responde 404 a partir daqui.
  const modelo = comClipes({});

  assert.equal(await modelo.clip("nao-existe"), undefined);
});

test("chave malformada nem chega ao banco", async () => {
  // A chave vem da URL, e a URL é digitada. `../` e caractere estranho param
  // aqui, antes de virarem consulta.
  const modelo = comClipes({});

  assert.equal(await modelo.clip("../../etc/passwd"), undefined);
  assert.equal(await modelo.clip("Rosca Direta"), undefined);
  assert.equal(await modelo.clip(""), undefined);
});

test("o binário do clipe não viaja na listagem de exercícios", async () => {
  // O que a lista carrega é a CHAVE. Setenta quilobytes por linha seriam um mega
  // e meio de binário por rolagem, para nada.
  const { modelo } = monta([
    { _id: new ObjectId(), name: "Rosca direta cross", instance: null, clipSlug: "rosca-direta" },
  ]);

  const [linha] = (await comoMarlon(() => modelo.list({ page: 1, limit: 20 }))).rows;

  assert.equal(linha.clipSlug, "rosca-direta");
  assert.ok(!("webp" in linha));
});
