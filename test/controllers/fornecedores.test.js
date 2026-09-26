const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const SupplierController = require("../../controllers/Supplier.js");

// OS FORNECEDORES — quem recebe o dinheiro que sai.
//
// *"Fornecedor, em cima ponha 'novo fornecedor', aí abre um dialog para digitar
// todos os dados do fornecedor e foto"*.
//
// O fornecedor era texto livre. Virou cadastro pela mesma razão que fez a
// categoria ser lista fechada: com campo livre, "Enel", "ENEL" e "Enel SP" são
// três fornecedores, e "quanto paguei para a Enel este ano" não tem resposta.
function monta({ permissoes = ["finance.view", "finance.manage"], contas = 0 } = {}) {
  const pedidas = [];
  const gravado = { criados: [], mudancas: [], apagados: [], fotos: [] };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidas.push(permissao);
          if (!permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon" };
        },
      },
    },
    api: {
      supplier: {
        async list() {
          return [
            { _id: "f1", name: "Enel", active: true, photo: "img1" },
            { _id: "f2", name: "Oi", active: false, photo: null },
          ];
        },
        async listActive() {
          return [{ _id: "f1", name: "Enel", active: true, photo: "img1" }];
        },
        async data(id) {
          return String(id) === "sumiu" ? undefined : { _id: String(id), name: "Enel" };
        },
        async insert(obj) {
          gravado.criados.push(obj);
          return obj.name ? "f1" : null;
        },
        async update(id, obj) {
          gravado.mudancas.push({ id: String(id), obj });
          return obj.name === "" ? false : true;
        },
        async quantasContas() {
          return contas;
        },
        // A PÁGINA da aba: busca, ordem, corte e a contagem de contas, tudo do
        // banco. Ver `pagina()` no modelo.
        async pagina(filtros) {
          gravado.paginou = filtros;
          // A aba mostra também o DESATIVADO — é a única tela de onde se
          // reativa um.
          return {
            rows: [
              { _id: "f1", name: "Enel", active: true, photo: "img1", contas: 12 },
              { _id: "f2", name: "Oi", active: false, photo: null, contas: 0 },
            ],
            total: 2,
            pagina: 1,
            porPagina: 15,
          };
        },
        async remove(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      supplierImage: {
        parseDataUri: (v) => (v ? { mime: "image/png", buffer: Buffer.from("x") } : undefined),
        async save(id, mime, buffer) {
          gravado.fotos.push({ id: String(id), mime, bytes: buffer.length });
          return { id: "img2", updatedAt: new Date() };
        },
        async data() {
          return undefined;
        },
      },
    },
  });

  SupplierController(app);
  return { app, pedidas, gravado };
}

test("LER pede finance.view; MEXER pede finance.manage", async () => {
  const { app, pedidas } = monta();

  await call(app, "get", "/suppliers");
  await call(app, "post", "/suppliers", { body: { name: "Enel" } });

  assert.equal(pedidas[0], "finance.view");
  assert.equal(pedidas[1], "finance.manage");
});

test("o seletor recebe só os ATIVOS; a tela de cadastro pede todos", async () => {
  // Oferecer quem saiu faria alguém lançar uma conta para um fornecedor que a
  // casa já dispensou.
  const { app } = monta();

  const doSeletor = await call(app, "get", "/suppliers");
  assert.equal(doSeletor.body.rows.length, 1);

  const doCadastro = await call(app, "get", "/suppliers", { query: { todos: "1" } });
  assert.equal(doCadastro.body.rows.length, 2);
});

test("a foto sai como URL, e o documento guarda só o id", async () => {
  // Guardar o endereço inteiro prenderia o fornecedor ao domínio do backend do
  // dia em que a foto subiu.
  const { app } = monta();
  const r = await call(app, "get", "/suppliers");

  assert.match(r.body.rows[0].photoUrl, /\/public\/supplier-image\/marlon\/img1$/);
});

test("sem nome é 400 — a conta não diria para quem foi", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/suppliers", { body: { document: "123" } });

  assert.equal(r.status, 400);
});

test("as CATEGORIAS vêm junto: é delas que sai o preenchimento automático", async () => {
  // *"se escolher 'enel' já auto preenche com conta de luz a descrição"* — o
  // formulário precisa do catálogo para mostrar a categoria escolhida.
  const { app } = monta();
  const r = await call(app, "get", "/suppliers");

  assert.ok(r.body.categorias.some((c) => c.id === "energia"));
});

test("fornecedor COM contas não é apagado, e o erro diz quantas", async () => {
  // Sumir com ele deixaria trinta linhas de histórico sem dizer para quem o
  // dinheiro foi. Quem quer tirá-lo da lista desativa.
  const { app, gravado } = monta({ contas: 12 });
  const r = await call(app, "delete", "/suppliers/f1");

  assert.equal(r.status, 409);
  assert.deepEqual(gravado.apagados, []);
});

test("sem contas, apaga", async () => {
  const { app, gravado } = monta({ contas: 0 });
  const r = await call(app, "delete", "/suppliers/f1");

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.apagados, ["f1"]);
});

test("a foto sobe pelo dono, e id que não existe é 404", async () => {
  const { app, gravado } = monta();

  const ok = await call(app, "post", "/suppliers/f1/photo", { body: { image: "data:image/png;base64,AA" } });
  assert.equal(ok.status, 201);
  assert.equal(gravado.fotos[0].id, "f1");

  const nao = await call(app, "post", "/suppliers/sumiu/photo", { body: { image: "data:x" } });
  assert.equal(nao.status, 404);
});

test("a imagem PÚBLICA não pede sessão — a tag do navegador não manda cabeçalho", async () => {
  const { app } = monta();
  app.helpers.ReqProtected.can = async () => {
    throw new Error("esta rota não pode pedir sessão");
  };

  const r = await call(app, "get", "/public/supplier-image/marlon/img1");
  // 404 porque o dobro não tem a imagem — o que importa é não ter estourado.
  assert.equal(r.status, 404);
});

// ── O CATÁLOGO SUGERE, EM VEZ DE DESPEJAR ─────────────────────────────────
//
// Havia aqui um botão "Usar os do VAFIT" que trazia os CENTO E DEZOITO do
// catálogo de uma vez. *"cliquei em 'usar os do vafit' mas isso faz o quê?"* e,
// na sequência, *"ele importou tudo, e demorou pra caramba"* (24/09/2026).
//
// As duas frases são o mesmo defeito: um botão que não diz o que faz e faz
// demais. O que ficou no lugar: *"o certo seria eu clicar em 'novo fornecedor'
// e, assim que eu digitar o nome, já aparece um search select que busca da
// central; aí se ele clicar, já puxa os dados da central, copia foto etc."*
//
// O que entra continua sendo CÓPIA: o cliente edita à vontade, e uma correção
// nossa no catálogo não sobrescreve o que ele ajustou.
function comCatalogo({ achados = [], daCasa = [], conhecido = null, logos = {}, comLogo = [] } = {}) {
  const gravado = { importados: [], logos: [], procurados: [] };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can() {
          return { _id: "u1", name: "Marlon" };
        },
      },
    },
    api: {
      center: {
        async procurarConhecidos(termo) {
          gravado.procurados.push(termo);
          return achados;
        },
        async conhecido(id) {
          gravado.pedido = String(id);
          return conhecido;
        },
        async logosDeConhecidos(ids) {
          gravado.logos.push(ids);
          return logos;
        },
        async idsComLogo(ids) {
          gravado.perguntouLogo = ids.map(String);
          return new Set(comLogo.map(String));
        },
        async logoDeConhecido(id) {
          return comLogo.includes(String(id))
            ? { _id: String(id), mime: "image/png", data: Buffer.from([1, 2, 3]) }
            : null;
        },
      },
      supplier: {
        async list() {
          return daCasa;
        },
        async importarConhecidos(lista, comQuaisLogos) {
          gravado.importados.push(lista.map((c) => c.name));
          gravado.recebeuLogos = comQuaisLogos;
          return { criados: 1, jaExistiam: 0 };
        },
        async listActive() {
          return [];
        },
      },
      supplierImage: { parseDataUri: () => undefined, async data() {} },
    },
  });

  SupplierController(app);
  return { app, gravado };
}

const ACHADOS = [
  { _id: "c1", name: "Enel", categoria: "energia", defaultDescription: "Conta de luz", photo: "p1" },
  { _id: "c2", name: "Enel Distribuição", categoria: "energia", defaultDescription: "" },
];

test("a busca leva o termo à central, e volta só o que casa", async () => {
  const { app, gravado } = comCatalogo({ achados: ACHADOS });
  const r = await call(app, "get", "/suppliers/catalogo", { query: { q: "enel" } });

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.procurados, ["enel"]);
  assert.deepEqual(r.body.rows.map((x) => x.name), ["Enel", "Enel Distribuição"]);
});

test("a sugestão traz a LOGO da marca — por URL, e não os bytes", async () => {
  // *"tire esse ícone de I.A, coloque a foto da empresa"* (24/09/2026). Uma
  // estrelinha ao lado de "Vivo" não diz nada; a logo da Vivo diz tudo.
  //
  // Por URL porque a lista aparece a cada tecla: trazer imagens aqui seria
  // pagar por elas em toda digitação.
  const { app, gravado } = comCatalogo({ achados: ACHADOS, comLogo: ["c1"] });
  const r = await call(app, "get", "/suppliers/catalogo", { query: { q: "enel" } });

  assert.match(r.body.rows[0].logoUrl, /\/public\/known-supplier-image\/c1$/);
  // `null`, e não uma URL que vai voltar 404: seriam oito requisições vermelhas
  // por digitação, por um desenho que não existe.
  assert.equal(r.body.rows[1].logoUrl, null);
  assert.equal(r.body.rows[0].data, undefined);

  // UMA consulta para os dois, e não uma por linha.
  assert.deepEqual(gravado.perguntouLogo, ["c1", "c2"]);
});

test("a logo do catálogo é pública e cacheada — a tag <img> não manda sessão", async () => {
  // E sem instância no caminho: o catálogo é um só, o mesmo para todo cliente.
  const { app } = comCatalogo({ comLogo: ["c1"] });
  const r = await call(app, "get", "/public/known-supplier-image/c1");

  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.match(r.headers["cache-control"], /max-age=604800/);
});

test("logo que não existe é 404 — e não uma imagem quebrada", async () => {
  const { app } = comCatalogo({ comLogo: [] });
  const r = await call(app, "get", "/public/known-supplier-image/c9");

  assert.equal(r.status, 404);
});

test("o que a casa JÁ tem não é sugerido de novo", async () => {
  // Sugerir a Enel cadastrada levaria a um segundo cadastro com o mesmo nome —
  // e o duplicado só aparece no dia em que alguém lança a conta no errado.
  const { app } = comCatalogo({ achados: ACHADOS, daCasa: [{ name: "ENEL" }] });
  const r = await call(app, "get", "/suppliers/catalogo", { query: { q: "enel" } });

  // "ENEL" e "Enel" são o mesmo fornecedor — a comparação é sem acento e em
  // minúsculas, a mesma do modelo.
  assert.deepEqual(r.body.rows.map((x) => x.name), ["Enel Distribuição"]);
});

test("central fora do ar não derruba o cadastro", async () => {
  // `procurarConhecidos` devolve lista vazia quando o painel não responde — ver
  // o modelo. Sem sugestão, quem está cadastrando digita o nome e segue.
  const { app } = comCatalogo({ achados: [] });
  const r = await call(app, "get", "/suppliers/catalogo", { query: { q: "enel" } });

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows, []);
});

test("escolher um do catálogo cria UM, com a logo dele", async () => {
  const { app, gravado } = comCatalogo({
    conhecido: { _id: "c1", name: "Enel" },
    daCasa: [{ _id: "f9", name: "Enel", photo: "img9" }],
    logos: { c1: { mime: "image/png", data: "x" } },
  });

  const r = await call(app, "post", "/suppliers/catalogo/c1");

  assert.equal(r.status, 201);
  assert.equal(r.body._id, "f9");
  // UM id de logo pedido, e não os cento e dezoito.
  assert.deepEqual(gravado.logos, [["c1"]]);
  assert.deepEqual(gravado.importados, [["Enel"]]);
});

test("um id que o catálogo não conhece é 404, e não um cadastro vazio", async () => {
  const { app } = comCatalogo({ conhecido: null });
  const r = await call(app, "post", "/suppliers/catalogo/naoexiste");

  assert.equal(r.status, 404);
});

test("o botão que despejava o catálogo inteiro NÃO existe mais", async () => {
  // Ele trazia os cento e dezoito de uma vez, e demorava: cada logo é uma
  // gravação. A rota saiu junto com o botão — deixá-la de pé seria manter viva
  // a única forma de repetir o problema.
  // O arnês estoura em rota que ninguém registrou, e é isso que se quer: a
  // ausência é a afirmação.
  const { app } = comCatalogo({});

  await assert.rejects(
    () => call(app, "post", "/suppliers/importar"),
    /rota não registrada/
  );
});

test("o id da logo é normalizado — texto e ObjectId acham a mesma imagem", async () => {
  // A importação em lote passava os `_id` crus e funcionava; a criação de UM
  // passou `String(id)`, e o `$in` com texto não casa com um `_id` que é
  // ObjectId. O efeito não era um erro: era a logo vindo VAZIA, calada, num
  // fornecedor que parecia cadastrado direito.
  const { ObjectId } = require("mongodb");
  const Center = require("../../model/Center_model.js");

  let procurado = null;
  const modelo = Object.create(Center.prototype);
  modelo.app = {
    mongodb: {
      async centralDb() {
        return {
          collection: () => ({
            find(filtro) {
              procurado = filtro._id.$in;
              return { async toArray() { return []; } };
            },
          }),
        };
      },
    },
  };

  const id = "6aaece75fadd6511e3e36f49";
  await modelo.logosDeConhecidos([id]);

  assert.ok(procurado[0] instanceof ObjectId, "o texto tinha de virar ObjectId");
  assert.equal(String(procurado[0]), id);
});

test("a aba PAGINA; o seletor do formulário não", async () => {
  // *"bote search, paginação, ordenação de coluna"* (24/09/2026), na aba de
  // fornecedores. O seletor do formulário precisa de todos os nomes de uma vez
  // — ele abre a cada lançamento de conta, e uma página de quinze esconderia o
  // fornecedor que se quer escolher.
  const { app, gravado } = monta();

  const daAba = await call(app, "get", "/suppliers", {
    query: { todos: "1", q: "luz", sort: "contas", dir: "desc", page: "2" },
  });

  assert.equal(daAba.body.total, 2);
  assert.equal(daAba.body.rows[0].contas, 12);
  // Busca, ordem e corte vão ao BANCO: ordenar as quinze que chegaram daria a
  // ordem DAS QUINZE.
  assert.equal(gravado.paginou.busca, "luz");
  assert.equal(gravado.paginou.ordem, "contas");
  assert.equal(gravado.paginou.direcao, "desc");
  assert.equal(gravado.paginou.pagina, "2");

  const doSeletor = await call(app, "get", "/suppliers");
  assert.equal(doSeletor.body.total, undefined);
  assert.equal(doSeletor.body.rows.length, 1);
});

test("`nameSort` nasce junto do nome — a busca procura por ele", async () => {
  // Eu escrevi a busca da aba contra este campo ANTES de ele existir
  // (24/09/2026). O resultado não foi um erro: era `q=enel` devolvendo zero,
  // calado, com a Enel bem ali na tela. Um campo que não existe não casa com
  // nada, e o `$regex` não reclama disso.
  const { app, gravado } = monta();

  await call(app, "post", "/suppliers", { body: { name: "Águas de Niterói" } });
  assert.equal(gravado.criados[0].nameSort, undefined, "quem grava é o MODELO, não o controlador");

  // E no modelo, que é onde a regra mora:
  const Supplier = require("../../model/Supplier_model.js");
  const modelo = Object.create(Supplier.prototype);

  let gravou = null;
  modelo.collection = async () => ({
    async insertOne(doc) {
      gravou = doc;
      return { insertedId: "f1" };
    },
  });
  modelo.recolherFotos = async () => {};

  await modelo.insert({ name: "Águas de Niterói" });
  assert.equal(gravou.nameSort, "aguas de niteroi");
});

test("renomear reescreve o `nameSort` — senão a busca acha pelo nome velho", async () => {
  const Supplier = require("../../model/Supplier_model.js");
  const modelo = Object.create(Supplier.prototype);

  let mudou = null;
  modelo.collection = async () => ({
    async updateOne(_, operacao) {
      mudou = operacao.$set;
      return { matchedCount: 1 };
    },
    async findOne() {
      return { photo: null };
    },
  });
  modelo.recolherFotos = async () => {};

  await modelo.update("6512f1c0c0c0c0c0c0c0c0c1", { name: "Enel São Paulo" });
  assert.equal(mudou.nameSort, "enel sao paulo");

  // Mexer em outro campo NÃO reescreve o nome: `limparParcial` só toca no que
  // veio.
  await modelo.update("6512f1c0c0c0c0c0c0c0c0c1", { phone: "1199999" });
  assert.equal(mudou.nameSort, undefined);
});
