const test = require("node:test");
const assert = require("node:assert/strict");

const retencao = require("../../lib/retencaoDeLogs.js");
const schema = require("../../database/schema.js");

// A RETENÇÃO DO HISTÓRICO, agora configurável no painel.
//
// *"cadastre em Configuração mais uma rota chamada retenção de logs, para a
// gente definir quantos dias vamos reter esses logs; por enquanto só teremos
// esse padrão, 6 meses"* (25/09/2026).
//
// ── O QUE QUEBRA CALADO, e por isso está aqui ────────────────────────────
//
// `createIndex` com as mesmas chaves e outro `expireAfterSeconds` NÃO muda o
// prazo — o Mongo recusa com IndexOptionsConflict. Quem muda um TTL vivo é o
// `collMod`. Sem estes casos, a tela diria "aplicado" e a poda continuaria no
// prazo antigo por meses, sem nada no caminho reclamando.
function fakeDb(indices = []) {
  const feito = { comandos: [], criados: [], derrubados: [] };

  const db = {
    databaseName: "teste",
    command: async (c) => {
      feito.comandos.push(c);
      return { ok: 1 };
    },
    collection: () => ({
      indexes: async () => indices,
      createIndex: async (chaves, opcoes) => feito.criados.push({ chaves, opcoes }),
      dropIndex: async (nome) => feito.derrubados.push(nome),
    }),
  };

  return { db, feito };
}

test("sem índice nenhum, CRIA com o prazo pedido", async () => {
  const { db, feito } = fakeDb([]);

  await schema.garantirPodaDoHistorico(db, 90);

  assert.equal(feito.criados.length, 1);
  assert.equal(feito.criados[0].opcoes.expireAfterSeconds, 90 * 86400);
  // O nome NÃO carrega o número: `poda_180d` viraria mentira no primeiro ajuste.
  assert.equal(feito.criados[0].opcoes.name, "poda_historico");
});

test("índice existente com outro prazo é AJUSTADO por collMod, não recriado", async () => {
  const { db, feito } = fakeDb([{ name: "poda_historico", expireAfterSeconds: 180 * 86400 }]);

  await schema.garantirPodaDoHistorico(db, 365);

  assert.equal(feito.criados.length, 0);
  assert.equal(feito.comandos.length, 1);
  assert.equal(feito.comandos[0].collMod, "user_action_history");
  assert.equal(feito.comandos[0].index.expireAfterSeconds, 365 * 86400);
});

test("prazo igual não mexe em nada", async () => {
  const { db, feito } = fakeDb([{ name: "poda_historico", expireAfterSeconds: 180 * 86400 }]);

  const r = await schema.garantirPodaDoHistorico(db, 180);

  assert.equal(r.intocado, true);
  assert.equal(feito.comandos.length, 0);
  assert.equal(feito.criados.length, 0);
});

test("o índice velho, com o número no nome, é aposentado", async () => {
  // Dois TTL sobre a mesma data fariam o MENOR mandar — e mexer no novo não
  // mudaria nada. O defeito se apresentaria como "mudei a retenção e não
  // aconteceu".
  const { db, feito } = fakeDb([{ name: "poda_180d", expireAfterSeconds: 180 * 86400 }]);

  await schema.garantirPodaDoHistorico(db, 90);

  assert.ok(feito.derrubados.includes("poda_180d"));
});

test("valor absurdo gravado à mão no banco não vira TTL absurdo", async () => {
  // Última linha de defesa: a faixa da tela do painel é a primeira.
  const { db, feito } = fakeDb([]);

  await schema.garantirPodaDoHistorico(db, 0);

  assert.equal(feito.criados[0].opcoes.expireAfterSeconds, retencao.PADRAO * 86400);
});

test("a régua: padrão de seis meses, e fora da faixa cai nele", () => {
  assert.equal(retencao.PADRAO, 180);
  assert.equal(retencao.normalizar(90), 90);
  assert.equal(retencao.normalizar("90"), 90);
  assert.equal(retencao.normalizar(2), retencao.PADRAO);
  assert.equal(retencao.normalizar(99999), retencao.PADRAO);
  assert.equal(retencao.normalizar(30.5), retencao.PADRAO);
  assert.equal(retencao.normalizar(null), retencao.PADRAO);
});

test("painel fora do ar não derruba o boot — cai no padrão", async () => {
  const central = {
    collection: () => ({
      findOne: async () => {
        throw new Error("mongo fora");
      },
    }),
  };

  assert.equal(await retencao.lerDoCentral(central), retencao.PADRAO);
});

test("chave ausente no painel é o padrão, e não zero", async () => {
  const central = { collection: () => ({ findOne: async () => null }) };

  assert.equal(await retencao.lerDoCentral(central), retencao.PADRAO);
});

test("o painel manda, quando o valor é sadio", async () => {
  const central = { collection: () => ({ findOne: async () => ({ value: 365 }) }) };

  assert.equal(await retencao.lerDoCentral(central), 365);
});
