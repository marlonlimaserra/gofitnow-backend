const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const PlanController = require("../../controllers/Plan.js");
const Center = require("../../model/Center_model.js");

// ── ASSINAR UM PLANO (15/09/2026) ─────────────────────────────────────────
//
// A rota que abre a tela de pagamento. O que ela NÃO faz é metade do desenho:
// ela não aplica plano nenhum. Quem aplica é o webhook, no painel, quando a
// Stripe confirma que o dinheiro entrou — porque voltar da tela de pagamento
// não prova pagamento, basta digitar a URL de sucesso.
//
// Então o que se testa aqui são as RECUSAS. O caminho feliz é uma chamada de
// rede e um redirecionamento; os caminhos infelizes são onde mora o dinheiro.
const USER = { _id: "u1", name: "Marlon", email: "marlon@exemplo.com" };

const PRO = {
  key: "pro",
  name: "Profissional",
  priceCents: 5000,
  currency: "BRL",
  interval: "month",
  active: true,
  stripePriceId: "price_abc",
};

const GRATIS = { key: "free", name: "Grátis", priceCents: 0, free: true, active: true };

function monta({
  planos = [PRO, GRATIS],
  daInstancia = null,
  cobranca = { ligada: true, secretKey: "sk_test_x", successUrl: "", trialDays: 0 },
  registro = { instance: "marlon", hosts: ["marlon.vafit.app"] },
  checkout = async () => ({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" }),
} = {}) {
  const center = new Center({
    mongodb: {
      async centralDb() {
        return {
          collection: () => ({
            async findOne(q) {
              return planos.find((p) => p.key === q.key) || null;
            },
            find() {
              return { sort: () => ({ toArray: async () => planos }), toArray: async () => [] };
            },
          }),
        };
      },
    },
  });

  center.byInstance = async () => (registro ? { ...registro, plan: daInstancia } : undefined);
  center.cobranca = async () => cobranca;

  const pedidos = [];
  const permissao = permiteTudo(USER);

  const app = fakeApp({
    ...permissao,
    api: { center },
    stripe: {
      async criarCheckout(args) {
        pedidos.push(args);
        return checkout(args);
      },
    },
  });

  PlanController(app);
  Center.prototype.forget.call(center, null);

  return { app, pedidos, pedidas: permissao.pedidas };
}

test("o caminho feliz devolve a URL da Stripe, e SÓ ela", async () => {
  // A chave secreta passa por dentro desta rota. O que não pode é ela sair no
  // corpo da resposta junto com a URL — e um `res.send(cobranca)` por
  // conveniência faria exatamente isso.
  const { app, pedidos } = monta();
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["url"]);
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_1");

  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].priceId, "price_abc");
  assert.equal(pedidos[0].secretKey, "sk_test_x");
});

test("a INSTÂNCIA e o PLANO vão amarrados no pedido", async () => {
  // É o que o webhook vai ler para saber de quem é o pagamento. Sem isto, o
  // dinheiro entra e ninguém sabe a quem dar o plano.
  const { app, pedidos } = monta();
  await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(pedidos[0].instancia, "marlon");
  assert.equal(pedidos[0].planoKey, "pro");
});

test("a volta é para a CASA DO CLIENTE, do registro central", async () => {
  // E não do cabeçalho `X-Instance-Host`, que vem do navegador: quem o forjasse
  // faria o retorno do pagamento apontar para um domínio dele. Mesmo cuidado do
  // link de recuperação de senha.
  const { app, pedidos } = monta({ registro: { instance: "marlon", hosts: ["academia-x.com.br"] } });
  await call(app, "post", "/me/checkout", {
    body: { plan: "pro" },
    headers: { "x-instance-host": "atacante.example" },
  });

  assert.equal(pedidos[0].successUrl, "https://academia-x.com.br/planos?assinatura=ok");
  assert.equal(pedidos[0].cancelUrl, "https://academia-x.com.br/planos?assinatura=cancelada");
});

test("a rota é fechada por permissão, e a chave é a que o menu usa", async () => {
  // Esconder o botão não é proteção. Se esta linha cair, uma recepcionista passa
  // a poder assinar um plano de R$ 500 em nome da conta.
  const { app, pedidas } = monta();
  await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.deepEqual(pedidas, ["users.manage"]);
});

test("chave de API não compra", async () => {
  // Assinar é decisão de quem está na tela com o cartão na mão. Uma integração
  // não escolhe plano pago, do mesmo jeito que não escolhe domínio.
  const { app, pedidos } = monta();
  const rota = app._rotas.find((r) => r.caminho === "/me/checkout");

  const res = { status: () => res, send: (b) => ((res.corpo = b), res) };
  await rota.handler(
    { body: { plan: "pro" }, _viaApiKey: true, instance: "marlon", t: (k) => k, headers: {} },
    res
  );

  assert.equal(res.corpo.code, "api_key_cannot_manage");
  assert.equal(pedidos.length, 0, "não pode nem ter falado com a Stripe");
});

test("cobrança DESLIGADA recusa antes de tocar na Stripe", async () => {
  const { app, pedidos } = monta({ cobranca: { ligada: false, secretKey: "sk_test_x" } });
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 503);
  assert.equal(r.body.code, "billing_off");
  assert.equal(pedidos.length, 0);
});

test("cobrança ligada SEM chave também recusa", async () => {
  // O interruptor ligado e a chave em branco é o estado de quem começou a
  // configurar e não terminou. Sem esta trava, a chamada sairia com chave vazia
  // e a Stripe devolveria um 401 que vira "não consegui abrir" na tela — que
  // não diz o que fazer.
  const { app } = monta({ cobranca: { ligada: true, secretKey: "" } });
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 503);
  assert.equal(r.body.code, "billing_off");
});

test("plano que não existe é 404, e cada recusa tem código próprio", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/me/checkout", { body: { plan: "inventado" } });

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "plan_not_found");
});

test("plano DESATIVADO no painel não pode ser comprado", async () => {
  // Ele some da vitrine, mas o endereço continua alcançável — e quem tiver a
  // tela velha aberta clicaria nele.
  const { app } = monta({ planos: [{ ...PRO, active: false }] });
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "plan_inactive");
});

test("plano GRATUITO não abre checkout", async () => {
  // Não há o que cobrar. Descer para o gratuito é CANCELAR, que é outra coisa.
  const { app } = monta();
  const r = await call(app, "post", "/me/checkout", { body: { plan: "free" } });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "plan_is_free");
});

test("plano SEM preço na Stripe recusa — e não cobra o valor errado", async () => {
  // O plano existe no painel e a sincronização falhou. O pior desfecho aqui não
  // é o erro: é seguir em frente com um `price` vazio.
  const { app, pedidos } = monta({ planos: [{ ...PRO, stripePriceId: null }] });
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 503);
  assert.equal(r.body.code, "plan_not_synced");
  assert.equal(pedidos.length, 0);
});

test("quem JÁ ESTÁ no plano não abre uma segunda assinatura", async () => {
  // Duas assinaturas do mesmo plano em paralelo são duas cobranças por mês. A
  // tela não mostra o botão, mas a rota não pode depender disso.
  const { app, pedidos } = monta({ daInstancia: "pro" });
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "already_on_plan");
  assert.equal(pedidos.length, 0);
});

test("trocar DE plano continua valendo", async () => {
  // A trava acima é sobre o MESMO plano. Subir de plano é o caso normal, e
  // barrá-lo por engano fecharia a venda.
  const { app } = monta({
    daInstancia: "free",
    planos: [PRO, GRATIS],
  });
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 200);
});

test("a Stripe recusando vira 502, e o detalhe dela NÃO vai para a tela", async () => {
  // A mensagem da Stripe fala de `price_...` e de conta. Quem só quer pagar não
  // tem o que fazer com isso, e é informação de dentro.
  const { app } = monta({
    checkout: async () => ({ erro: "stripe", detalhe: "No such price: price_abc" }),
  });
  const r = await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(r.status, 502);
  assert.equal(r.body.detalhe, undefined);
  assert.ok(!String(r.body.msg).includes("price_abc"));
});

test("o CLIENTE da Stripe é reaproveitado quando a conta já tem um", async () => {
  // Sem isto, quem troca de plano vira dois clientes na Stripe — e o histórico
  // de faturas fica partido em dois.
  const { app, pedidos } = monta({
    registro: { instance: "marlon", hosts: ["marlon.vafit.app"], stripeCustomerId: "cus_123" },
  });
  await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(pedidos[0].clienteId, "cus_123");
});

test("conta ainda sem cliente na Stripe manda o e-mail", async () => {
  // Sem e-mail, a Stripe pede um na tela dela e a pessoa digita outro — e a
  // fatura do mês seguinte chega num endereço que ninguém lê.
  const { app, pedidos } = monta();
  await call(app, "post", "/me/checkout", { body: { plan: "pro" } });

  assert.equal(pedidos[0].clienteId, null);
  assert.equal(pedidos[0].email, "marlon@exemplo.com");
});

// ── A VITRINE DIZ SE A LOJA ESTÁ ABERTA ───────────────────────────────────
test("/me/plans conta se dá para assinar, sem vazar a chave", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/me/plans");

  assert.equal(r.body.canSubscribe, true);
  assert.equal(JSON.stringify(r.body).includes("sk_test_"), false);
});

test("sem cobrança configurada, a vitrine diz que não dá", async () => {
  // É o que faz o botão nascer apagado com "em breve" em vez de aceso e
  // estourando no clique.
  const { app } = monta({ cobranca: { ligada: false, secretKey: "" } });
  const r = await call(app, "get", "/me/plans");

  assert.equal(r.body.canSubscribe, false);
});

// ── GERENCIAR E CANCELAR (15/09/2026) ─────────────────────────────────────
//
// "e para cancelar como faz?" — pelo portal da Stripe, que é a mesma porta de
// trocar cartão, mudar de plano e baixar fatura. Ver o comentário da rota.
test("o portal abre para o cliente da Stripe desta instância", async () => {
  const chamadas = [];
  const { app } = monta({
    registro: { instance: "marlon", hosts: ["marlon.vafit.app"], stripeCustomerId: "cus_123" },
  });
  app.stripe.abrirPortal = async (args) => {
    chamadas.push(args);
    return { ok: true, url: "https://billing.stripe.com/p/session/x" };
  };

  const r = await call(app, "post", "/me/billing-portal");

  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["url"]);
  assert.equal(chamadas[0].clienteId, "cus_123");
  // A volta é para a casa DELE, do registro central — não do cabeçalho.
  assert.equal(chamadas[0].voltarPara, "https://marlon.vafit.app/planos");
});

test("quem NUNCA pagou não tem portal, e ouve isso em vez de um erro", async () => {
  // Sem `cus_...` não existe portal. "Erro ao abrir" mandaria a pessoa abrir
  // chamado por uma situação que é normal.
  const { app } = monta();
  const r = await call(app, "post", "/me/billing-portal");

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "no_subscription");
});

test("o portal também é fechado por permissão", async () => {
  // Cancelar a assinatura da conta não pode ser de qualquer um que entra.
  const { app, pedidas } = monta({
    registro: { instance: "marlon", hosts: ["marlon.vafit.app"], stripeCustomerId: "cus_1" },
  });
  app.stripe.abrirPortal = async () => ({ ok: true, url: "https://x" });

  await call(app, "post", "/me/billing-portal");
  assert.deepEqual(pedidas, ["users.manage"]);
});

test("chave de API não cancela", async () => {
  const { app } = monta({
    registro: { instance: "marlon", hosts: ["marlon.vafit.app"], stripeCustomerId: "cus_1" },
  });
  const rota = app._rotas.find((r) => r.caminho === "/me/billing-portal");

  const res = { status: () => res, send: (b) => ((res.corpo = b), res) };
  await rota.handler({ body: {}, _viaApiKey: true, instance: "marlon", t: (k) => k, headers: {} }, res);

  assert.equal(res.corpo.code, "api_key_cannot_manage");
});

// ── O ESTADO DA ASSINATURA NA VITRINE ─────────────────────────────────────
test("a vitrine conta o estado da assinatura, sem os IDs da Stripe", async () => {
  // `cus_...` e `sub_...` não têm uso no navegador, e tudo que se faz com eles é
  // feito no servidor.
  const fim = new Date("2026-10-15T00:00:00Z");
  const { app } = monta({
    registro: {
      instance: "marlon",
      hosts: ["marlon.vafit.app"],
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeStatus: "active",
      cancelaNoFim: true,
      periodoFimEm: fim,
    },
  });

  const r = await call(app, "get", "/me/plans");

  assert.equal(r.body.subscription.status, "active");
  assert.equal(r.body.subscription.cancelAtPeriodEnd, true);
  assert.deepEqual(r.body.subscription.currentPeriodEnd, fim);

  const texto = JSON.stringify(r.body);
  assert.equal(texto.includes("cus_1"), false, "o id do cliente vazou");
  assert.equal(texto.includes("sub_1"), false, "o id da assinatura vazou");
});

test("quem nunca pagou não recebe assinatura nenhuma na vitrine", async () => {
  // É o que faz a tela não oferecer "Gerenciar assinatura" — um botão que abre
  // para dizer "você não tem assinatura" é um botão que não devia estar lá.
  const { app } = monta();
  const r = await call(app, "get", "/me/plans");

  assert.equal(r.body.subscription, null);
});
