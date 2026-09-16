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
    // A lista é FECHADA de propósito, e cresce só por decisão:
    //
    //   recommended             15/09/2026 — a vitrine precisa da bandeirinha.
    //   display                 16/09/2026 — cartão na grade ou faixa de
    //                           largura inteira. "Sua marca" e "Seu app" não se
    //                           compram comparando, e lado a lado com os outros
    //                           faziam o cliente comparar o que não compete.
    //   tagline, highlights     16/09/2026 — a cópia que vende. O site tinha
    //                           essa frase e esses itens CRAVADOS no código, e
    //                           os preços também: ele anunciava Essencial
    //                           R$ 79 enquanto a central vendia Recém formado
    //                           R$ 10. Passando pelo plano, as três vitrines
    //                           (site, tela de planos, dialog do teto) leem a
    //                           mesma cópia de um lugar só.
    //
    // Um campo que aparecer aqui sem passar por este caso é campo que vazou do
    // documento cru — que é o que este teste existe para pegar. `notes`
    // continua de fora, e é o ponto: anotação interna do painel não vira texto
    // de venda.
    [
      "currency",
      "display",
      "free",
      "highlights",
      "interval",
      "key",
      "limits",
      "name",
      "priceCents",
      "recommended",
      "tagline",
    ]
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

// ── A CHAVE DE LIMITE APOSENTADA (15/09/2026) ─────────────────────────────
//
// O catálogo de limites vive no painel e valida na ESCRITA. Validar na escrita
// não alcança o que já está gravado: uma chave aposentada some do catálogo e
// continua no documento de todo plano salvo antes da aposentadoria.
//
// `brandImages` virou `appearance` + `whitelabel`. O plano Grátis não foi
// editado desde então, então a chave morta atravessou a leitura e apareceu na
// vitrine — em inglês, em camelCase, no meio de uma lista em português, na tela
// em que o cliente decide se paga.
//
// A defesa está na LEITURA, e não na tela, porque a tela não sabe distinguir
// "chave nova ainda sem tradução" (que TEM de aparecer) de "chave aposentada"
// (que não pode). Quem sabe isso é o catálogo, e o navegador não o tem.
test("chave de limite fora do catálogo NÃO atravessa a leitura", async () => {
  const app = monta({
    planos: [
      {
        key: "gratis",
        name: "Grátis",
        priceCents: 0,
        free: true,
        limits: { people: 5, brandImages: true },
      },
    ],
  });

  const r = await call(app, "get", "/me/plans");

  const gratis = r.body.rows.find((p) => p.key === "gratis");
  assert.equal("brandImages" in gratis.limits, false, "a chave morta vazou para a tela");
  // E a metade que importa do filtro: ele não pode esvaziar os limites.
  assert.equal(gratis.limits.people, 5);
});

test("chave que o catálogo conhece atravessa, mesmo sem tradução na tela", async () => {
  // O caso oposto, e a razão de o filtro ser por CATÁLOGO e não por tradução:
  // um limite recém-criado no painel precisa chegar na vitrine antes de alguém
  // escrever o rótulo dele. `planos.test.jsx`, no frontend, prova o outro lado
  // — ele vira "3 webhooks" em vez de desaparecer.
  const app = monta({
    planos: [{ key: "pro", name: "Pro", priceCents: 3900, limits: { photoSides: 4 } }],
  });

  const r = await call(app, "get", "/me/plans");
  assert.equal(r.body.rows[0].limits.photoSides, 4);
});

// ── O QUE A VITRINE ESCONDE DO CLIENTE (15/09/2026) ───────────────────────
//
// "tem coisa que ele não precisa ver." Séries por exercício e alimentos por
// refeição são teto interno; cada linha que ocupam empurra para baixo o que de
// fato vende.
//
// Quem escolhe é o painel, e a escolha vale para TODOS os planos — a vitrine é
// uma comparação, e as colunas só se comparam com as mesmas linhas.
function comEscondidos(lista, planos) {
  const app = monta({ planos });
  // O único ponto que muda: a leitura da configuração no banco do painel.
  app.api.center.limitesEscondidos = async () => lista;
  Center.prototype.forget.call(app.api.center, null);
  return app;
}

test("o limite escondido NÃO chega na vitrine", async () => {
  const app = comEscondidos(["setsPerExercise"], [
    { key: "pro", name: "Pro", priceCents: 3900, limits: { people: 200, setsPerExercise: 20 } },
  ]);

  const r = await call(app, "get", "/me/plans");
  const pro = r.body.rows[0];

  assert.equal("setsPerExercise" in pro.limits, false);
  assert.equal(pro.limits.people, 200, "e o que não está escondido continua");
});

test("esconder vale para TODOS os planos, não para um", async () => {
  // A regra que mantém a comparação honesta. Se valesse por plano, o cartão pago
  // anunciaria "Agenda ✓" e o grátis não diria nada — e o cliente leria que o
  // grátis não tem agenda, quando ele tem uma.
  const app = comEscondidos(["schedule"], [
    { key: "free", name: "Grátis", priceCents: 0, free: true, limits: { schedule: 1, people: 5 } },
    { key: "pro", name: "Pro", priceCents: 3900, limits: { schedule: null, people: 200 } },
  ]);

  const r = await call(app, "get", "/me/plans");
  for (const p of r.body.rows) {
    assert.equal("schedule" in p.limits, false, p.key);
  }
});

test("o plano ATUAL passa pelo mesmo filtro", async () => {
  // Ele alimenta o selo do topo e o dialog do teto estourado. Sem isto, a mesma
  // linha apareceria escondida na vitrine e visível no dialog.
  const app = comEscondidos(["setsPerExercise"], [
    { key: "free", name: "Grátis", priceCents: 0, free: true, limits: { people: 5, setsPerExercise: 20 } },
  ]);
  app.api.center.byInstance = async () => ({ instance: "marlon", plan: "free" });
  Center.prototype.forget.call(app.api.center, null);

  const r = await call(app, "get", "/me/plan");
  assert.equal("setsPerExercise" in r.body.plan.limits, false);
});

test("sem nada escondido, a vitrine mostra tudo", async () => {
  const app = comEscondidos([], [
    { key: "pro", name: "Pro", priceCents: 3900, limits: { people: 200, setsPerExercise: 20 } },
  ]);

  const r = await call(app, "get", "/me/plans");
  assert.equal(r.body.rows[0].limits.setsPerExercise, 20);
});

// ── CHAVE DE SIM/NÃO SAI COMO BOOLEANO DE VERDADE (15/09/2026) ────────────
//
// `null` quer dizer coisas OPOSTAS nos dois tipos de limite:
//
//   limite numérico   null = ILIMITADO
//   chave de sim/não  null = LIGADA  (plano antigo não perde o que já usava)
//
// O cartão recebe só o valor, não o tipo, então ele não separa os dois — e
// escreveu "Aparência personalizada · sem limite", que não quer dizer nada.
//
// A regra "ausente é SIM" é do painel; quem a materializa é esta leitura.
test("chave de sim/não ausente sai como `true`, não como null", async () => {
  const app = monta({
    planos: [{ key: "pro", name: "Pro", priceCents: 3900, limits: { appearance: null, people: null } }],
  });

  const r = await call(app, "get", "/me/plans");
  const limites = r.body.rows[0].limits;

  assert.equal(limites.appearance, true, "a chave vira booleano");
  // E o limite NUMÉRICO continua `null`, que é o que significa ilimitado.
  assert.equal(limites.people, null);
});

test("chave desligada continua `false`", async () => {
  const app = monta({
    planos: [{ key: "free", name: "Grátis", priceCents: 0, free: true, limits: { whitelabel: false } }],
  });

  const r = await call(app, "get", "/me/plans");
  assert.equal(r.body.rows[0].limits.whitelabel, false);
});
