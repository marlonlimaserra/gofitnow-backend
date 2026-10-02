const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const LeadController = require("../../controllers/Lead.js");
const funil = require("../../lib/funilDeLeads.js");

// OS LEADS — quem procurou e ainda não é ninguém no sistema.
//
// *"crie uma nova rota chamada 'lead'. Esses leads vão ser os dados de pessoas
// que não pagam nada e nem são alunos"* (01/10/2026).
//
// O que estes testes protegem não é o CRUD, que é igual ao de qualquer
// cadastro. É o que tem decisão atrás:
//
//   • a chave de permissão PRÓPRIA (e não a de pessoas)
//   • a lista abrir só com as etapas ABERTAS, e `todas` existir para ver o resto
//   • a cerca de unidade chegar ao modelo
function monta({ permissoes = ["leads.view", "leads.manage", "people.create"], units = [], converteu = "p1" } = {}) {
  const pedidas = [];
  const gravado = { criados: [], mudancas: [], apagados: [] };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidas.push(permissao);
          if (!permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon", units };
        },
      },
    },
    api: {
      lead: {
        async pagina(filtros) {
          gravado.paginou = filtros;
          return {
            rows: [{ _id: "l1", name: "Ana", etapa: "novo", unit: null }],
            total: 1,
            porEtapa: { novo: 1 },
            pagina: 1,
            porPagina: 15,
          };
        },
        async data(id) {
          return String(id) === "sumiu" ? undefined : { _id: String(id), name: "Ana" };
        },
        async insert(obj) {
          gravado.criados.push(obj);
          return obj.name ? "l1" : null;
        },
        async update(id, obj) {
          gravado.mudancas.push({ id: String(id), obj });
          return String(id) !== "sumiu";
        },
        async remove(id) {
          gravado.apagados.push(String(id));
          return String(id) !== "sumiu";
        },
        async converter(id, trainerId) {
          gravado.converteu = { id: String(id), trainerId: String(trainerId) };
          return converteu;
        },
        paraTela(l) {
          return l;
        },
      },
    },
  });

  LeadController(app);
  return { app, pedidas, gravado };
}

test("a lista pede `leads.view`, e não a permissão de pessoas", async () => {
  const { app, pedidas } = monta();
  await call(app, "get", "/leads");
  assert.deepEqual(pedidas, ["leads.view"]);
});

test("quem não tem a chave leva 403", async () => {
  const { app } = monta({ permissoes: [] });
  const r = await call(app, "get", "/leads");
  assert.equal(r.status, 403);
});

test("sem filtro, a lista abre só com as etapas abertas", async () => {
  const { app, gravado } = monta();
  await call(app, "get", "/leads");

  // Uma fila de trabalho não começa com os perdidos de três meses atrás.
  assert.equal(gravado.paginou.etapas, funil.ETAPAS_ABERTAS.join(","));
  assert.ok(!gravado.paginou.etapas.includes("perdido"));
});

test("`etapas=todas` abre o resto — senão um perdido por engano fica preso", async () => {
  const { app, gravado } = monta();
  await call(app, "get", "/leads", { query: { etapas: "todas" } });

  // A lista INTEIRA, e não vazio: é pedir "convertido" que faz o modelo
  // alcançar quem já virou aluno, cujo tipo mudou.
  assert.equal(gravado.paginou.etapas, funil.IDS_DE_ETAPA.join(","));
  assert.ok(gravado.paginou.etapas.includes("convertido"));
});

test("a etapa pedida pela tela chega ao modelo", async () => {
  const { app, gravado } = monta();
  await call(app, "get", "/leads", { query: { etapas: "perdido" } });
  assert.equal(gravado.paginou.etapas, "perdido");
});

test("a cerca de unidade de quem é restrito chega ao modelo", async () => {
  const { app, gravado } = monta({ units: ["64b000000000000000000001"] });
  await call(app, "get", "/leads");

  // Ela não pediu unidade nenhuma: o servidor devolve as DELA, e não a casa
  // inteira. Ver `lib/lenteDeUnidade.js`.
  assert.deepEqual(gravado.paginou.units, ["64b000000000000000000001"]);
});

test("a lista traz o catálogo junto — etapa nova entra sem tocar no frontend", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/leads");

  assert.equal(r.body.etapas.length, funil.ETAPAS.length);
  assert.equal(r.body.origens.length, funil.ORIGENS.length);
  assert.deepEqual(r.body.porEtapa, { novo: 1 });
});

test("criar pede `leads.manage`", async () => {
  const { app, pedidas } = monta();
  await call(app, "post", "/leads", { body: { name: "Ana" } });
  assert.deepEqual(pedidas, ["leads.manage"]);
});

test("lead sem nome é recusado — a lista mostraria uma linha em branco", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/leads", { body: { name: "" } });
  assert.equal(r.status, 400);
});

test("apagar o que não existe é 404, e não um 200 mentiroso", async () => {
  const { app } = monta();
  const r = await call(app, "delete", "/leads/sumiu");
  assert.equal(r.status, 404);
});

test("editar devolve o lead já salvo", async () => {
  const { app, gravado } = monta();
  const r = await call(app, "put", "/leads/l1", { body: { etapa: "contato" } });

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.mudancas, [{ id: "l1", obj: { etapa: "contato" } }]);
});


// ── CONVERTER ────────────────────────────────────────────────────────────
//
// *"a ideia é converter o lead para aluno"* (01/10/2026).
test("converter exige as DUAS chaves: mexer no funil e cadastrar gente", async () => {
  const { app, pedidas } = monta();
  await call(app, "post", "/leads/l1/converter");

  // Só `leads.manage` deixaria quem não pode cadastrar ninguém cadastrar por
  // esta porta.
  assert.deepEqual(pedidas, ["leads.manage", "people.create"]);
});

test("quem não pode criar pessoa não converte", async () => {
  const { app } = monta({ permissoes: ["leads.manage"] });
  const r = await call(app, "post", "/leads/l1/converter");
  assert.equal(r.status, 403);
});

test("converter devolve o id da PESSOA, para a tela abrir a ficha na hora", async () => {
  const { app, gravado } = monta();
  const r = await call(app, "post", "/leads/l1/converter");

  assert.equal(r.status, 200);
  assert.equal(r.body.personId, "p1");
  assert.deepEqual(gravado.converteu, { id: "l1", trainerId: "u1" });
});

test("converter o que não existe é 404", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/leads/sumiu/converter");
  assert.equal(r.status, 404);
});

test("dois cliques no botão: o segundo é 409, e não 500", async () => {
  // Não houve erro, houve atraso — e o código da resposta precisa dizer isso.
  const { app } = monta({ converteu: null });
  const r = await call(app, "post", "/leads/l1/converter");
  assert.equal(r.status, 409);
});
