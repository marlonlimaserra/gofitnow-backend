const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const StructureController = require("../../controllers/Structure.js");

// A JANELA DE TEMPO DA ESTRUTURA.
//
// *"senti falta de filtro de data, para saber tudo que ocorreu em certo
// período"*.
//
// O que estes casos guardam é a borda: `ate` tem de cobrir o DIA INTEIRO, e
// "tudo" tem de ser diferente de "não mandei nada". As duas coisas são
// invisíveis na tela e erradas só num dia do mês, que é o pior jeito de um
// relatório estar errado.
function monta({ permissoes = ["structure.view", "structure.manage"] } = {}) {
  const pedidas = { equipamento: [], insumo: [], manutencoes: [], movimentos: [] };

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
      tenant: { async currencyOfInstance() { return { currency: "BRL" }; } },
      equipment: {
        async listar() { return []; },
        async custoNoPeriodo(j) {
          pedidas.equipamento.push(j);
          return { total: 0, quantas: 0, porMes: [], porTipo: [], porEquipamento: [] };
        },
        async manutencoesNoPeriodo(j) {
          pedidas.manutencoes.push(j);
          return [];
        },
        async sugestoes() { return { marcas: [], modelos: [], locais: [], notas: [] }; },
      },
      supply: {
        async listar() { return []; },
        async gastoNoPeriodo(j) {
          pedidas.insumo.push(j);
          return { total: 0, porCategoria: [] };
        },
        async movimentosNoPeriodo(j) {
          pedidas.movimentos.push(j);
          return [];
        },
      },
    },
  });

  StructureController(app);
  return { app, pedidas };
}

test("`ate` cobre o dia inteiro, e não a meia-noite dele", async () => {
  // Uma data crua é 00:00. Sem esticar até o fim, a manutenção lançada hoje de
  // manhã fica de fora do período que termina hoje — e quem vê isso desconfia
  // do relatório inteiro, com razão.
  const { app, pedidas } = monta();

  await call(app, "get", "/equipments", { query: { de: "2026-05-01", ate: "2026-05-31" } });

  const { ate } = pedidas.equipamento[0];
  assert.equal(ate.getHours(), 23);
  assert.equal(ate.getMinutes(), 59);
  assert.equal(ate.getDate(), 31);
});

test("`de` começa na primeira hora do dia", async () => {
  const { app, pedidas } = monta();

  await call(app, "get", "/equipments", { query: { de: "2026-05-10", ate: "2026-05-31" } });

  const { de } = pedidas.equipamento[0];
  assert.equal(de.getHours(), 0);
  assert.equal(de.getDate(), 10);
});

test("`tudo=1` é a janela VAZIA — e não uma data antiga qualquer", async () => {
  // "Desde sempre" escrito como 1970 mentiria no rótulo, e um dia alguém
  // lançaria uma compra com data velha e ela sumiria do "tudo".
  const { app, pedidas } = monta();

  await call(app, "get", "/equipments", { query: { tudo: "1", de: "2026-05-01" } });

  // `unit` entrou em 22/09/2026 e viaja sempre — sem lente, vazio. O que
  // este caso guarda é a JANELA: nenhuma data inventada.
  assert.deepEqual(pedidas.equipamento[0], { unit: undefined });
});

test("sem período, o equipamento olha doze meses para trás", async () => {
  // Manutenção é esparsa: no mês corrente o número mais comum seria zero, e um
  // relatório que quase sempre mostra zero não é consultado.
  const { app, pedidas } = monta();

  await call(app, "get", "/equipments", {});

  const { de, ate } = pedidas.equipamento[0];
  const meses = (ate.getFullYear() - de.getFullYear()) * 12 + (ate.getMonth() - de.getMonth());
  assert.equal(meses, 11);
  assert.equal(de.getDate(), 1);
});

test("sem período, o estoque olha o MÊS corrente", async () => {
  // O outro lado da mesma moeda: insumo se compra toda semana, e doze meses de
  // desinfetante somados não respondem "quanto gastei este mês".
  const { app, pedidas } = monta();

  await call(app, "get", "/supplies", {});

  const { de } = pedidas.insumo[0];
  assert.equal(de.getDate(), 1);
  assert.equal(de.getMonth(), new Date().getMonth());
});

test("a janela pedida vale para o estoque também", async () => {
  const { app, pedidas } = monta();

  await call(app, "get", "/supplies", { query: { de: "2026-03-01", ate: "2026-03-31" } });

  assert.equal(pedidas.insumo[0].de.getMonth(), 2);
  assert.equal(pedidas.insumo[0].ate.getDate(), 31);
});

test("uma data impossível não derruba a lista — cai no padrão", async () => {
  const { app, pedidas } = monta();

  await call(app, "get", "/equipments", { query: { de: "trinta de maio" } });

  assert.ok(pedidas.equipamento[0].de instanceof Date);
});


// ── A LENTE DA UNIDADE NOS RELATÓRIOS (22/09/2026) ───────────────────────
//
// *"estrutura também não respeita unidades"*.
//
// A LISTA de aparelhos já filtrava; o GASTO e o HISTÓRICO da mesma tela, não.
// A lente em Paraty mostrava zero aparelhos com o gasto de manutenção da casa
// inteira logo abaixo — dois números na mesma tela respondendo perguntas
// diferentes, que é pior que não ter o número.

test("a lente chega no gasto e no histórico de manutenção, não só na lista", async () => {
  const { app, pedidas } = monta();

  await call(app, "get", "/equipments", { query: { unit: "u9" } });

  assert.equal(pedidas.equipamento[0].unit, "u9", "o gasto ficou sem a lente");
  assert.equal(pedidas.manutencoes?.[0]?.unit, "u9", "o histórico ficou sem a lente");
});

test("no estoque, a lente pega o gasto e os movimentos — o catálogo não", async () => {
  // O INSUMO é do estoque da casa e não tem unidade; o MOVIMENTO tem — é ele
  // que diz qual unidade consumiu o galão.
  const { app, pedidas } = monta();

  await call(app, "get", "/supplies", { query: { unit: "u9" } });

  assert.equal(pedidas.insumo?.[0]?.unit, "u9", "o gasto de insumo ficou sem a lente");
  assert.equal(pedidas.movimentos?.[0]?.unit, "u9", "o histórico ficou sem a lente");
});
