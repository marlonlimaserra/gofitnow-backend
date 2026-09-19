const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Payable_model = require("../../model/Payable_model.js");

// A CONSULTA DAS CONTAS A PAGAR.
//
// Mesma forma da carteira: um `$facet` com a página, a contagem e o resumo.
// O que se mede aqui é a FORMA DO PIPELINE — as decisões que não quebram teste
// nenhum quando alguém as desfaz, e só passam a mostrar um número errado.
function fakeModel({ rows = [], total = 0, resumo = null } = {}) {
  const chamadas = [];

  const model = new Payable_model({});
  model.collection = async () => ({
    aggregate(pipeline) {
      chamadas.push({ pipeline });
      return {
        async toArray() {
          return [
            {
              rows,
              total: total ? [{ n: total }] : [],
              resumo: resumo ? [resumo] : [],
              porCategoria: [],
            },
          ];
        },
      };
    },
  });

  return { model, chamadas };
}

const ramo = (pipeline, nome) => pipeline.find((e) => e.$facet).$facet[nome];
const estagio = (estagios, chave) => estagios.find((e) => chave in e);
const texto = (x) => JSON.stringify(x);

test("a janela é sobre o VENCIMENTO", async () => {
  // O relatório do mês é o do que vence no mês — a mesma regra da carteira.
  const { model, chamadas } = fakeModel();
  await model.listar({ de: "2026-09-01", ate: "2026-09-30" });

  assert.ok(chamadas[0].pipeline[0].$match.dueDate);
});

test("VENCIDA é calculada, e não gravada", async () => {
  // Gravá-la exigiria alguém passar todo dia à meia-noite mudando linhas.
  // Calculada, ela está certa no instante em que se olha.
  const { model, chamadas } = fakeModel();
  await model.listar({});

  const derivados = chamadas[0].pipeline.find((e) => e.$addFields);
  assert.ok(derivados.$addFields.atrasada);
  assert.ok(derivados.$addFields.diasDeAtraso);
});

test('pedir "vencida" filtra pelo campo calculado, e não por um status gravado', async () => {
  const { model, chamadas } = fakeModel();
  await model.listar({ status: "late" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.ok(texto(linhas).includes("atrasada"));
});

test("o recorte por CATEGORIA vira um $in de chaves conhecidas", async () => {
  const { model, chamadas } = fakeModel();
  await model.listar({ categoria: "energia,agua,inventada" });

  const linhas = texto(ramo(chamadas[0].pipeline, "rows"));
  assert.ok(linhas.includes("energia"));
  assert.ok(linhas.includes("agua"));
  // O que não existe no catálogo cai fora: o valor entra num `$in`, e aceitar o
  // que vier é deixar a tela escolher por qual chave o banco filtra.
  assert.ok(!linhas.includes("inventada"));
});

test('"da casa toda" é `unit: null`, e não a ausência de filtro', async () => {
  const { model, chamadas } = fakeModel();
  await model.listar({ semUnidade: true, unit: "68c9f6b1a2b3c4d5e6f70011" });

  const linhas = texto(ramo(chamadas[0].pipeline, "rows"));
  assert.ok(linhas.includes('"unit":null'));
  // E o `unit` pedido é IGNORADO quando os dois vêm: "sem unidade" é mais
  // específico, e atender os dois daria lista sempre vazia.
  assert.ok(!linhas.includes("68c9f6b1a2b3c4d5e6f70011"));
});

test("o RESUMO não enxerga o recorte", async () => {
  // Os cartões falam do PERÍODO. Filtrar por "energia" não pode fazer o total a
  // pagar do mês virar o da energia.
  const { model, chamadas } = fakeModel();
  await model.listar({ categoria: "energia", busca: "cpfl" });

  const resumo = texto(ramo(chamadas[0].pipeline, "resumo"));
  assert.ok(!resumo.includes("energia"));
  assert.ok(!resumo.includes("cpfl"));
});

test("o resumo separa pago, a pagar e atrasado", async () => {
  // Cancelada não é despesa, e em aberto ainda não saiu da conta. Um total só
  // somaria dinheiro que nunca vai sair com dinheiro que já saiu.
  const { model, chamadas } = fakeModel();
  await model.listar({});

  const resumo = texto(ramo(chamadas[0].pipeline, "resumo"));
  for (const chave of ["pago", "aPagar", "atrasado"]) {
    assert.ok(resumo.includes(chave), `faltou ${chave}`);
  }
});

test("o relatório por categoria ignora as CANCELADAS", async () => {
  // Uma conta cancelada não é gasto, e contá-la inflaria a categoria dela para
  // sempre.
  const { model, chamadas } = fakeModel();
  await model.listar({});

  const porCategoria = texto(ramo(chamadas[0].pipeline, "porCategoria"));
  assert.ok(porCategoria.includes("canceled"));
  assert.ok(porCategoria.includes("$ne"));
});

test("a ordem sai de uma lista fechada", async () => {
  const { model, chamadas } = fakeModel();
  await model.listar({ ordem: "'; drop", direcao: "asc" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.deepEqual(estagio(linhas, "$sort").$sort, { dueDate: 1, _id: 1 });
});

test("a busca escapa o que a pessoa digitou", async () => {
  const { model, chamadas } = fakeModel();
  await model.listar({ busca: "a(b" });

  assert.ok(texto(ramo(chamadas[0].pipeline, "rows")).includes("a\\\\(b"));
});

test("limite absurdo é contido antes de virar consulta", async () => {
  const { model } = fakeModel();
  const r = await model.listar({ limite: 100000, pagina: -5 });

  assert.equal(r.limite, 200);
  assert.equal(r.pagina, 1);
});

// ── A GRAVAÇÃO ────────────────────────────────────────────────────────────

test("pagar e despagar andam junto com a DATA", async () => {
  // Marcar paga sem data deixaria "paguei quando?" sem resposta; desmarcar sem
  // limpar deixaria uma data de pagamento numa conta em aberto.
  const gravados = [];
  const model = new Payable_model({});
  model.collection = async () => ({
    async updateOne(filtro, mudanca) {
      gravados.push(mudanca.$set);
      return { matchedCount: 1 };
    },
  });

  await model.update("68c9f6b1a2b3c4d5e6f70011", { status: "paid" });
  assert.ok(gravados[0].paidAt instanceof Date);

  await model.update("68c9f6b1a2b3c4d5e6f70011", { status: "open" });
  assert.equal(gravados[1].paidAt, null);
});

test("editar manda SÓ o que veio", async () => {
  // A tela manda o formulário inteiro; uma integração manda um campo — e
  // sobrescrever o resto com vazio apagaria a conta de alguém.
  const gravados = [];
  const model = new Payable_model({});
  model.collection = async () => ({
    async updateOne(filtro, mudanca) {
      gravados.push(mudanca.$set);
      return { matchedCount: 1 };
    },
  });

  await model.update("68c9f6b1a2b3c4d5e6f70011", { amount: 1500 });

  assert.deepEqual(Object.keys(gravados[0]).sort(), ["amount", "updatedAt"]);
});

test("descrição vazia numa edição é RECUSADA", async () => {
  // Apagar o que identifica a linha não é uma edição legítima; recusar é melhor
  // que gravar, porque a tela mostra o erro e a conta continua inteira.
  const model = new Payable_model({});
  model.collection = async () => ({
    async updateOne() {
      throw new Error("não devia gravar");
    },
  });

  assert.equal(await model.update("68c9f6b1a2b3c4d5e6f70011", { description: "  " }), false);
});

// ── A IMPORTAÇÃO DO CATÁLOGO ──────────────────────────────────────────────
//
// O que entra é CÓPIA, e o que já existe não é tocado: quem cadastrou "Enel" à
// mão, com o contato do gerente dele, não pode receber uma segunda Enel limpa —
// e muito menos ter a dele sobrescrita.
const Supplier_model = require("../../model/Supplier_model.js");

function fakeFornecedores(atuais = []) {
  const inseridos = [];
  const atualizados = [];
  const fotos = [];

  const model = new Supplier_model({
    api: {
      supplierImage: {
        async save(dono, mime, buffer) {
          fotos.push({ dono, mime, bytes: buffer.length });
          return { id: "68c9f6b1a2b3c4d5e6f7aaaa" };
        },
      },
    },
  });

  model.collection = async () => ({
    find: () => ({ async toArray() { return atuais; } }),
    async insertMany(docs) {
      inseridos.push(...docs);
      // Os ids que o driver devolve, indexados pela POSIÇÃO — é por eles que a
      // logo acha o fornecedor que acabou de nascer.
      const insertedIds = {};
      docs.forEach((_, i) => (insertedIds[i] = new ObjectId()));
      return { insertedCount: docs.length, insertedIds };
    },
    async updateOne(filtro, mudanca) {
      atualizados.push({ filtro, set: mudanca.$set });
    },
  });

  return { model, inseridos, atualizados, fotos };
}

test("o que JÁ existe não vira duplicata", async () => {
  const { model, inseridos } = fakeFornecedores([{ name: "Enel" }]);

  const r = await model.importarConhecidos([{ name: "Enel" }, { name: "Vivo" }]);

  assert.equal(r.criados, 1);
  assert.equal(r.jaExistiam, 1);
  assert.deepEqual(inseridos.map((f) => f.name), ["Vivo"]);
});

test("o nome casa SEM acento e sem caixa", async () => {
  // "ENEL", "Enel" e "enel" são o mesmo fornecedor; "Naturgy" e "naturgy"
  // também. Sem isto, clicar duas vezes criaria a segunda.
  const { model } = fakeFornecedores([{ name: "ENEL" }, { name: "Águas do Rio" }]);

  const r = await model.importarConhecidos([{ name: "enel" }, { name: "aguas do rio" }]);

  assert.equal(r.criados, 0);
  assert.equal(r.jaExistiam, 2);
});

test("duas linhas do catálogo com o mesmo nome entram UMA vez", async () => {
  // A chave entra no conjunto na hora; sem isso as duas passariam pelo teste de
  // existência e as duas entrariam.
  const { model, inseridos } = fakeFornecedores([]);

  await model.importarConhecidos([{ name: "Enel" }, { name: "ENEL" }]);

  assert.equal(inseridos.length, 1);
});

test("o importado nasce marcado como vindo do catálogo", async () => {
  // Não muda comportamento nenhum hoje; serve para responder "esta lista é
  // minha ou veio pronta?" quando alguém estranhar um nome.
  const { model, inseridos } = fakeFornecedores([]);

  await model.importarConhecidos([{ name: "Vivo", categoria: "internet" }]);

  assert.equal(inseridos[0].fromCatalog, true);
  assert.equal(inseridos[0].categoria, "internet");
});

// ── A LOGO VEM JUNTO ──────────────────────────────────────────────────────
//
// *"cadê o botão de poder escolher foto?"* Os BYTES são copiados para a base da
// casa: apontar para a imagem do painel faria a logo da Enel sumir da tela dele
// no dia em que alguém a trocasse lá.
test("a logo do catálogo é copiada e vira a foto do fornecedor", async () => {
  const { model, atualizados, fotos } = fakeFornecedores([]);

  const r = await model.importarConhecidos([{ _id: "k1", name: "Enel" }], {
    k1: { mime: "image/png", data: Buffer.from("logo") },
  });

  assert.equal(r.comLogo, 1);
  assert.deepEqual(fotos, [{ dono: fotos[0].dono, mime: "image/png", bytes: 4 }]);
  assert.equal(String(atualizados[0].set.photo), "68c9f6b1a2b3c4d5e6f7aaaa");
});

test("fornecedor sem logo entra igual, e sem escrita a mais", async () => {
  const { model, atualizados, fotos } = fakeFornecedores([]);

  const r = await model.importarConhecidos([{ _id: "k1", name: "Enel" }], {});

  assert.equal(r.criados, 1);
  assert.equal(r.comLogo, 0);
  assert.deepEqual(fotos, []);
  assert.deepEqual(atualizados, []);
});

test("logo que não grava NÃO derruba a importação", async () => {
  // Metade do catálogo dentro e metade fora, e ninguém sabe qual metade, é pior
  // que um fornecedor sem logo.
  const { model, inseridos } = fakeFornecedores([]);
  model.app.api.supplierImage.save = async () => {
    throw new Error("R2 fora do ar");
  };

  const r = await model.importarConhecidos(
    [{ _id: "k1", name: "Enel" }, { _id: "k2", name: "Vivo" }],
    { k1: { mime: "image/png", data: Buffer.from("x") } }
  );

  assert.equal(r.criados, 2);
  assert.equal(r.comLogo, 0);
  assert.equal(inseridos.length, 2);
});

test("o `_origem` NÃO vai para o banco — ele só liga a linha à logo", async () => {
  const { model, inseridos } = fakeFornecedores([]);
  await model.importarConhecidos([{ _id: "k1", name: "Enel" }], {});

  assert.equal("_origem" in inseridos[0], false);
});

test("catálogo vazio não grava nada", async () => {
  const { model, inseridos } = fakeFornecedores([]);
  const r = await model.importarConhecidos([]);

  assert.deepEqual(r, { criados: 0, jaExistiam: 0 });
  assert.equal(inseridos.length, 0);
});
