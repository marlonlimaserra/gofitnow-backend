const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const PlanController = require("../../controllers/Plan.js");
const Center = require("../../model/Center_model.js");

const USER = { _id: "u1", name: "Marlon" };

// O plano é do PAINEL: ele cria, ordena e desativa. Aqui é só leitura, e o que
// se prova é o que atravessa essa fronteira — e o que NÃO atravessa.
function monta({ planos = [], daInstancia = null } = {}) {
  const center = new Center({
    mongodb: {
      async centralDb() {
        return {
          collection: () => ({
            async findOne(q) {
              return planos.find((p) => p.key === q.key) || null;
            },
            find(q) {
              // O mesmo filtro da rota: `active` ausente é ATIVO.
              const vivos = planos.filter((p) => !(q.active && p.active === false));
              return {
                sort: () => ({ toArray: async () => vivos }),
              };
            },
          }),
        };
      },
    },
  });

  // `byInstance` vai à collection do painel por outro caminho; aqui ele diz
  // direto qual plano este cliente assinou.
  center.byInstance = async () => (daInstancia ? { instance: "marlon", plan: daInstancia } : null);

  const app = fakeApp({ ...permiteTudo(USER), api: { center } });
  PlanController(app);
  Center.prototype.forget.call(center, null);
  return app;
}

const PRO = { key: "pro", name: "Pro", priceCents: 9900, currency: "BRL", interval: "month", active: true, order: 1, limits: { people: 200 }, notes: "cortesia do fulano até dezembro" };
const FREE = { key: "free", name: "Grátis", priceCents: 0, currency: "BRL", interval: "month", active: true, order: 0, free: true, limits: { people: 5 } };

test("/me/plan diz em que plano o cliente está, com a marca de gratuito", async () => {
  const app = monta({ planos: [FREE, PRO], daInstancia: "free" });
  const r = await call(app, "get", "/me/plan");

  assert.equal(r.status, 200);
  assert.equal(r.body.plan.key, "free");
  assert.equal(r.body.plan.free, true);
});

test("cliente SEM plano devolve null, e não um plano gratuito", async () => {
  // São coisas diferentes: "não sei em que plano você está" não vira selo
  // nenhum, e "você está no de entrada" vira.
  const app = monta({ planos: [FREE], daInstancia: null });
  const r = await call(app, "get", "/me/plan");

  assert.equal(r.body.plan, null);
});

test("plano pago NÃO vem marcado como gratuito", async () => {
  const app = monta({ planos: [FREE, PRO], daInstancia: "pro" });
  const r = await call(app, "get", "/me/plan");

  assert.equal(r.body.plan.free, false);
});

test("as OBSERVAÇÕES do painel não atravessam para o app", async () => {
  // "cortesia do fulano até dezembro" é anotação interna. O que vai para o app
  // de todo mundo é uma lista fechada de campos, não o documento cru.
  const app = monta({ planos: [PRO], daInstancia: "pro" });
  const r = await call(app, "get", "/me/plan");

  assert.equal(r.body.plan.notes, undefined);
  assert.deepEqual(
    Object.keys(r.body.plan).sort(),
    ["currency", "free", "interval", "key", "limits", "name", "priceCents"]
  );
});

test("a vitrine respeita a ORDEM do painel", async () => {
  const app = monta({ planos: [FREE, PRO], daInstancia: "free" });
  const r = await call(app, "get", "/me/plans");

  assert.deepEqual(r.body.rows.map((p) => p.key), ["free", "pro"]);
  assert.equal(r.body.current, "free");
});

test("plano OCULTO some da vitrine", async () => {
  const app = monta({ planos: [FREE, { ...PRO, active: false }], daInstancia: "free" });
  const r = await call(app, "get", "/me/plans");

  assert.deepEqual(r.body.rows.map((p) => p.key), ["free"]);
});

test("mas quem ESTÁ num plano oculto continua vendo o dele", async () => {
  // Um plano desativado continua valendo para quem já assinou. Sem isto a tela
  // diria "escolha um plano" a quem já tem um, sem mostrar qual.
  const app = monta({ planos: [FREE, { ...PRO, active: false }], daInstancia: "pro" });
  const r = await call(app, "get", "/me/plans");

  assert.deepEqual(r.body.rows.map((p) => p.key), ["free", "pro"]);
  assert.equal(r.body.current, "pro");
  assert.equal(r.body.rows.find((p) => p.key === "pro").foraDoCatalogo, true);
});

test("cliente sem plano vê a vitrine e nenhum atual", async () => {
  const app = monta({ planos: [FREE, PRO], daInstancia: null });
  const r = await call(app, "get", "/me/plans");

  assert.equal(r.body.current, null);
  assert.equal(r.body.rows.length, 2);
  assert.ok(!r.body.rows.some((p) => p.foraDoCatalogo));
});

test("as duas rotas exigem sessão", async () => {
  const app = fakeApp({
    helpers: { ReqProtected: { async verify(req, res) { res.status(401).send({}); return false; } } },
    api: { center: {} },
  });
  PlanController(app);

  for (const caminho of ["/me/plan", "/me/plans"]) {
    const r = await call(app, "get", caminho);
    assert.equal(r.status, 401, caminho);
  }
});
