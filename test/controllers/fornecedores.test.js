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

// ── USAR OS DO VAFIT ──────────────────────────────────────────────────────
//
// *"coloque um botão 'usar os do vafit', aí puxa da central todos os
// fornecedores"*.
//
// O que entra é CÓPIA: o cliente edita à vontade, e uma correção nossa no
// catálogo não sobrescreve o que ele ajustou.
function comCatalogo({ conhecidos = [], jaTem = [], logos = {} } = {}) {
  const gravado = { importados: [], logos: [] };

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
        async fornecedoresConhecidos() {
          return conhecidos;
        },
        // A LOGO VIAJA JUNTO: os bytes são copiados para a base da casa na
        // importação. Uma consulta só para os cento e dezoito — uma por
        // fornecedor seriam cento e dezoito idas ao banco do painel dentro de um
        // clique.
        async logosDeConhecidos(ids) {
          gravado.logos.push(ids);
          return logos;
        },
      },
      supplier: {
        async importarConhecidos(lista, comQuaisLogos) {
          gravado.importados.push(lista.map((c) => c.name));
          gravado.recebeuLogos = comQuaisLogos;
          const novos = lista.filter((c) => !jaTem.includes(c.name));
          return { criados: novos.length, jaExistiam: lista.length - novos.length };
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

const CATALOGO = [
  { name: "Enel", categoria: "energia", ufs: ["SP", "RJ"] },
  { name: "Copel", categoria: "energia", ufs: ["PR"] },
  { name: "Vivo", categoria: "internet", ufs: [] },
];

test("sem UF, traz o catálogo inteiro", async () => {
  // Uma lista com dez distribuidoras é melhor que uma sem a que ele usa.
  const { app, gravado } = comCatalogo({ conhecidos: CATALOGO });
  const r = await call(app, "post", "/suppliers/importar");

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.importados[0], ["Enel", "Copel", "Vivo"]);
});

test("com UF, traz os DELA e os nacionais", async () => {
  // Distribuidora é regional: a Enel não atende o Paraná. Mas a Vivo atende
  // todo mundo, e deixá-la de fora seria pior que trazer a Copel a mais.
  const { app, gravado } = comCatalogo({ conhecidos: CATALOGO });
  await call(app, "post", "/suppliers/importar", { query: { uf: "sp" } });

  assert.deepEqual(gravado.importados[0], ["Enel", "Vivo"]);
});

test("diz quantos criou e quantos já existiam", async () => {
  // É o que faz o botão poder ser clicado duas vezes sem medo — que é
  // exatamente o que acontece quando alguém não lembra se já clicou.
  const { app } = comCatalogo({ conhecidos: CATALOGO, jaTem: ["Enel"] });
  const r = await call(app, "post", "/suppliers/importar");

  assert.equal(r.body.criados, 2);
  assert.equal(r.body.jaExistiam, 1);
});

test("as logos do recorte são pedidas EM BLOCO, e chegam na importação", async () => {
  // *"cadê o botão de poder escolher foto?"* — a logo cadastrada no painel entra
  // na base do cliente junto com o fornecedor. Uma consulta, não cento e dezoito.
  const logos = { a: { mime: "image/png", data: Buffer.from("x") } };
  const catalogo = CATALOGO.map((c, i) => ({ ...c, _id: String(i) }));

  const { app, gravado } = comCatalogo({ conhecidos: catalogo, logos });
  await call(app, "post", "/suppliers/importar", { query: { uf: "sp" } });

  // Só os do recorte: pedir a logo da Copel para quem está em São Paulo seria
  // trazer bytes que ninguém vai ver.
  assert.deepEqual(gravado.logos, [["0", "2"]]);
  assert.deepEqual(gravado.recebeuLogos, logos);
});

test("central fora do ar não derruba o clique", async () => {
  // `fornecedoresConhecidos` devolve lista vazia quando o painel não responde —
  // ver o modelo. A tela diz "nada para importar", e o produto segue.
  const { app } = comCatalogo({ conhecidos: [] });
  const r = await call(app, "post", "/suppliers/importar");

  assert.equal(r.status, 200);
  assert.equal(r.body.criados, 0);
});
