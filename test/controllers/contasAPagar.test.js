const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const PayableController = require("../../controllers/Payable.js");

// CONTAS A PAGAR — o outro lado do caixa.
//
// *"crie mais um módulo chamado de contas a pagar para lançar conta de luz,
// telefone etc… por unidade também"*.
//
// O que estes casos guardam é o que separa este módulo do financeiro dos
// alunos: a UNIDADE é da conta (e não de uma pessoa), "da casa toda" é um
// recorte de verdade, e sem descrição não existe conta.
function monta({ permissoes = ["finance.view", "finance.manage"], conta = null } = {}) {
  const pedidas = [];
  const gravado = { criadas: [], mudancas: [], apagadas: [], filtros: [] };

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
      payable: {
        async listar(filtros) {
          gravado.filtros.push(filtros);
          return {
            rows: [],
            total: 0,
            pagina: 1,
            limite: 25,
            resumo: { pago: 0, aPagar: 0, atrasado: 0 },
            porCategoria: [{ categoria: "energia", total: 45000, quantas: 2 }],
          };
        },
        async data(id) {
          if (String(id) === "sumiu") return undefined;
          return conta || { _id: String(id), description: "Conta de luz", amount: 45000 };
        },
        async insert(obj, quem, moeda) {
          gravado.criadas.push({ obj, quem: String(quem), moeda });
          return obj.description ? "cta1" : null;
        },
        async update(id, obj) {
          gravado.mudancas.push({ id: String(id), obj });
          return obj.description === "" ? false : true;
        },
        async remove(id) {
          gravado.apagadas.push(String(id));
          return true;
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL"] };
        },
        async timezoneOfInstance() {
          return "America/Sao_Paulo";
        },
      },
    },
  });

  PayableController(app);
  return { app, pedidas, gravado };
}

test("LER pede finance.view; MEXER pede finance.manage", async () => {
  const { app, pedidas } = monta();

  await call(app, "get", "/payables");
  await call(app, "post", "/payables", { body: { description: "Luz" } });

  assert.equal(pedidas[0], "finance.view");
  assert.equal(pedidas[1], "finance.manage");
});

test("quem só LÊ não lança conta", async () => {
  const { app, gravado } = monta({ permissoes: ["finance.view"] });

  const r = await call(app, "post", "/payables", { body: { description: "Luz" } });

  assert.equal(r.status, 403);
  assert.deepEqual(gravado.criadas, []);
});

test("sem descrição é 400 — a linha não diria o que é", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/payables", { body: { amount: 450 } });

  assert.equal(r.status, 400);
});

test("a conta nasce com a MOEDA da casa", async () => {
  // "1200" em real e "1200" em dólar são despesas diferentes, e um relatório
  // que as soma mente.
  const { app, gravado } = monta();
  await call(app, "post", "/payables", { body: { description: "Aluguel", amount: 250000 } });

  assert.equal(gravado.criadas[0].moeda, "BRL");
  assert.equal(gravado.criadas[0].quem, "u1");
});

test('"da casa toda" é um recorte, e não a ausência de filtro', async () => {
  // O contador e o software não pertencem a unidade nenhuma. Quem fecha o custo
  // de Paraty precisa poder olhar os dois separados.
  const { app, gravado } = monta();

  await call(app, "get", "/payables", { query: { semUnidade: "1" } });
  assert.equal(gravado.filtros[0].semUnidade, true);

  await call(app, "get", "/payables", { query: { unit: "68c9f6b1a2b3c4d5e6f70011" } });
  assert.equal(gravado.filtros[1].semUnidade, false);
  assert.equal(gravado.filtros[1].unit, "68c9f6b1a2b3c4d5e6f70011");
});

test("o relatório por categoria vem na MESMA resposta", async () => {
  // É a mesma janela: pedi-lo à parte seria varrer o mês duas vezes para
  // desenhar uma tela.
  const { app } = monta();
  const r = await call(app, "get", "/payables");

  assert.equal(r.body.porCategoria[0].categoria, "energia");
  assert.ok(Array.isArray(r.body.categorias));
  assert.ok(r.body.categorias.some((c) => c.id === "energia"));
});

test("os catálogos vêm TRADUZIDOS, com o ícone", async () => {
  // O mesmo caminho do resto do financeiro: uma categoria nova aparece sem
  // ninguém mexer no frontend.
  const { app } = monta();
  const r = await call(app, "get", "/payables");

  const energia = r.body.categorias.find((c) => c.id === "energia");
  assert.ok(energia.label);
  assert.equal(energia.icone, "Zap");
  assert.ok(r.body.status.some((s) => s.id === "late"));
});

test("editar id que não existe é 404, e nada é gravado", async () => {
  const { app, gravado } = monta();
  const r = await call(app, "put", "/payables/sumiu", { body: { description: "X" } });

  assert.equal(r.status, 404);
  assert.deepEqual(gravado.mudancas, []);
});

test("apagar diz o que apagou, e registra no histórico", async () => {
  const { app, gravado } = monta();
  const r = await call(app, "delete", "/payables/cta1");

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.apagadas, ["cta1"]);
});

// ── O COMPROVANTE ─────────────────────────────────────────────────────────
//
// *"faltou poder anexar comprovante"*. O boleto, o print do Pix, a nota.
function comComprovante({ permissoes = ["finance.view", "finance.manage"], anexo = null } = {}) {
  const gravado = { salvos: [], apagados: [] };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          if (!permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon" };
        },
      },
    },
    api: {
      payable: {
        async listar() {
          return { rows: [], total: 0, pagina: 1, limite: 25, resumo: {}, porCategoria: [] };
        },
        async data(id) {
          return String(id) === "sumiu" ? undefined : { _id: String(id), description: "Luz" };
        },
        async insert(obj) {
          return obj.description ? "cta1" : null;
        },
        async update() {
          return true;
        },
        async remove() {
          return true;
        },
        // O dobro recusa o que não for `dataUri`, como o de verdade.
        parseReceipt: (arq) =>
          arq?.dataUri === "bom"
            ? { mime: "application/pdf", buffer: Buffer.from("x"), ficha: { name: "boleto.pdf" } }
            : undefined,
        async saveReceipt(id, a) {
          gravado.salvos.push({ id: String(id), nome: a.ficha.name });
        },
        async removeReceipt(id) {
          gravado.apagados.push(String(id));
          return true;
        },
        async receiptOf() {
          return anexo;
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL"] };
        },
        async timezoneOfInstance() {
          return "America/Sao_Paulo";
        },
      },
    },
  });

  PayableController(app);
  return { app, gravado };
}

test("o comprovante é lido ANTES de gravar", async () => {
  // Um arquivo recusado tem de virar 400 com o motivo certo, e não uma conta
  // salva sem o anexo que a pessoa achou que tinha mandado.
  const { app, gravado } = comComprovante();

  const r = await call(app, "post", "/payables", {
    body: { description: "Luz", receipt: { dataUri: "ruim" } },
  });

  assert.equal(r.status, 400);
  assert.deepEqual(gravado.salvos, []);
});

test("com anexo válido, a conta nasce com ele", async () => {
  const { app, gravado } = comComprovante();

  const r = await call(app, "post", "/payables", {
    body: { description: "Luz", receipt: { dataUri: "bom" } },
  });

  assert.equal(r.status, 201);
  assert.deepEqual(gravado.salvos, [{ id: "cta1", nome: "boleto.pdf" }]);
});

test("`receipt: null` numa edição TIRA o anexo; não mandar o campo não mexe", async () => {
  // A diferença entre "tirei" e "não mexi" é a mesma de todo campo parcial
  // deste projeto — e aqui ela decide se um arquivo some.
  const { app, gravado } = comComprovante();

  await call(app, "put", "/payables/cta1", { body: { receipt: null } });
  assert.deepEqual(gravado.apagados, ["cta1"]);

  await call(app, "put", "/payables/cta1", { body: { amount: 100 } });
  assert.deepEqual(gravado.apagados, ["cta1"]);
});

test("o comprovante exige SESSÃO — é a nota fiscal da casa", async () => {
  // Um endereço aberto seria o boleto de alguém circulando em link.
  const { app } = comComprovante({ permissoes: [] });
  const r = await call(app, "get", "/payables/cta1/receipt");

  assert.equal(r.status, 403);
});

test("conta sem comprovante é 404 no download", async () => {
  const { app } = comComprovante({ anexo: null });
  const r = await call(app, "get", "/payables/cta1/receipt");

  assert.equal(r.status, 404);
});
