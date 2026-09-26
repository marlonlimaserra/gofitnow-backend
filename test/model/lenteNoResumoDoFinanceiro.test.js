const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Finance_model = require("../../model/Finance_model.js");
const Recurrence_model = require("../../model/Recurrence_model.js");

// OS CARTÕES DO TOPO SEGUEM A LENTE.
//
// *"os KPI parece que não respeita unidade: eu troco ali, a planilha muda mas
// os KPI não"* (22/09/2026) — sete lançamentos nos cartões com uma linha na
// lista logo abaixo.
//
// ── A confusão que causou isto ────────────────────────────────────────────
//
// A lente estava no RECORTE, junto da busca e do estado pedido. Agrupá-las
// foi o erro: busca e estado ESTREITAM a lista dentro do mesmo contexto —
// marcar "pendente" para conferir não pode zerar o recebido do mês, e por
// isso eles ficam mesmo fora do resumo. A lente TROCA o contexto: ela mora no
// alto do app e diz "agora estou olhando Niterói". Todo número da tela segue.
//
// Estes casos medem ONDE o `$match` da unidade entra no pipeline, que é a
// razão do defeito — dentro do `$facet` ele chega tarde demais para o resumo.
function pipelineDe(aggregate) {
  return aggregate[0];
}

function fake(Model, collectionProp) {
  const pipelines = [];
  const model = new Model({});

  const col = {
    aggregate(pipeline) {
      pipelines.push(pipeline);
      return { async toArray() { return [{ resumo: [], pagina: [], total: [] }]; } };
    },
    async countDocuments() { return 0; },
  };

  model[collectionProp] = async () => col;
  return { model, pipelines };
}

// Os estágios ANTES do `$facet` — é o que o resumo enxerga.
function antesDoFacet(pipeline) {
  const corte = pipeline.findIndex((e) => e.$facet);
  assert.notEqual(corte, -1, "sem $facet não há resumo");
  return pipeline.slice(0, corte);
}

// Quantos `$match` por `studentUnit` existem numa lista de estágios.
//
// Procurar a PALAVRA no JSON não serve: `studentUnit` também está na
// projeção, e o teste passava sem a correção — foi o que aconteceu na
// primeira versão deste arquivo. O que importa é o ESTÁGIO.
function filtrosDeUnidade(estagios) {
  return estagios.filter((e) => e.$match && e.$match.studentUnit).length;
}

const UNIDADE = new ObjectId();

test("PAGAMENTOS: a lente entra antes do $facet, para o cartão e a lista concordarem", async () => {
  const { model, pipelines } = fake(Finance_model, "payments");
  model.app = { api: {} };

  await model.recebimentos({ unit: String(UNIDADE) }).catch(() => {});

  assert.equal(
    filtrosDeUnidade(antesDoFacet(pipelineDe(pipelines))),
    1,
    "a lente ficou dentro do $facet — o resumo não a vê"
  );
});

test("PAGAMENTOS: sem lente, nada é filtrado por unidade", async () => {
  const { model, pipelines } = fake(Finance_model, "payments");
  model.app = { api: {} };

  await model.recebimentos({}).catch(() => {});

  // O campo existe na PROJEÇÃO; o que não pode existir é um `$match` por ele.
  assert.equal(filtrosDeUnidade(pipelineDe(pipelines)), 0);
});

test("RECORRÊNCIA: idem — a previsão é a da unidade olhada", async () => {
  const { model, pipelines } = fake(Recurrence_model, "collection");
  model.app = { api: {} };

  await model.todas({ unit: String(UNIDADE) }).catch(() => {});

  assert.equal(filtrosDeUnidade(antesDoFacet(pipelineDe(pipelines))), 1);
});
