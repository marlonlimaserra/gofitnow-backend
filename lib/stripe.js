// A STRIPE, do lado de quem VENDE para o cliente da instância.
//
// ── Por que existe um segundo arquivo de Stripe no projeto ────────────────
//
// O painel (`gofitnow-center-backend/lib/stripe.js`) tem o outro: ele CADASTRA
// o catálogo (produto, preço) e CONFERE o aviso que a Stripe manda de volta.
// Aqui é a terceira ponta, e ela não cabe em nenhuma das duas: abrir a tela de
// pagamento para um cliente logado.
//
// Ela não cabe lá porque depende de coisas que só existem deste lado — a sessão
// de quem clicou, a instância dele, o endereço público da casa dele. E não pode
// virar uma chamada HTTP para o painel porque não existe canal autenticado
// deste backend para lá: o que existe é a leitura direta do banco central, que
// é por onde `Center_model` já lê plano e limite.
//
// O que NÃO se repetiu: a conferência de assinatura do webhook. Ela mora só no
// painel, porque é lá que a Stripe bate — um endereço, um segredo, um lugar.
const BASE = "https://api.stripe.com/v1";

// Mesmo teto do painel. Sem ele, uma Stripe lenta segura a requisição até o
// navegador desistir, e a pessoa não sabe se o pagamento começou ou não.
const TIMEOUT_MS = 12000;

async function api(chave, caminho, corpo) {
  const res = await fetch(`${BASE}/${caminho}`, {
    method: corpo ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${chave}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: corpo ? new URLSearchParams(corpo).toString() : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.error?.message || `http_${res.status}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

// ── A TELA DE PAGAMENTO ───────────────────────────────────────────────────
//
// `mode: subscription` porque todo plano aqui é recorrente. O que a Stripe
// devolve é uma URL dela — o cartão nunca passa por este servidor, e é por isso
// que Checkout foi escolhido em vez de montar um formulário: o dado do cartão
// não toca em código nosso, então não existe PCI para carregar.
//
// ── O QUE AMARRA O PAGAMENTO À INSTÂNCIA ──────────────────────────────────
//
// Três campos, e os três de propósito:
//
//   client_reference_id            — a instância, no evento do checkout
//   metadata[instance] / [plan]    — idem, para quem ler a sessão depois
//   subscription_data[metadata]    — a MESMA coisa, na ASSINATURA
//
// O terceiro é o que quase se esquece e é o mais importante. Os eventos de
// depois (`customer.subscription.updated`, `.deleted`, o cancelamento seis
// meses à frente) falam da ASSINATURA, não da sessão de checkout — e a sessão
// já não existe mais. Sem o metadata gravado na assinatura, o webhook receberia
// "a assinatura sub_123 foi cancelada" e não teria como saber de quem ela é sem
// varrer a collection inteira.
//
// ── Por que o e-mail vai preenchido ───────────────────────────────────────
//
// Sem ele a Stripe pede o e-mail na tela dela, e a pessoa digita outro. Aí
// existem dois clientes na Stripe para a mesma conta aqui, e a fatura do mês
// seguinte chega num endereço que ninguém lê.
async function criarCheckout({
  secretKey,
  priceId,
  instancia,
  planoKey,
  email,
  successUrl,
  cancelUrl,
  trialDays,
  clienteId,
}) {
  const chave = String(secretKey || "").trim();
  if (!chave) return { erro: "sem_chave" };
  if (!priceId) return { erro: "sem_preco" };

  const corpo = {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: instancia,
    "metadata[instance]": instancia,
    "metadata[plan]": planoKey,
    "subscription_data[metadata][instance]": instancia,
    "subscription_data[metadata][plan]": planoKey,
    // Cupom de desconto. Ligado porque desligar exige lembrar de ligar no dia
    // da primeira promoção, e nesse dia ninguém lembra que a trava existe.
    allow_promotion_codes: "true",
  };

  // O cliente da Stripe, quando a conta já tem um: é o que faz a segunda
  // assinatura entrar no MESMO cliente, com o histórico de faturas junto. Sem
  // isso, quem troca de plano vira dois clientes na Stripe.
  if (clienteId) corpo.customer = clienteId;
  else if (email) corpo.customer_email = email;

  // Teste grátis. Só quando configurado e só maior que zero — `trial_period_days: 0`
  // a Stripe recusa.
  const dias = Number(trialDays) || 0;
  if (dias > 0) corpo["subscription_data[trial_period_days]"] = String(dias);

  try {
    const sessao = await api(chave, "checkout/sessions", corpo);
    return { ok: true, url: sessao.url, id: sessao.id };
  } catch (erro) {
    return { erro: "stripe", detalhe: erro?.message || String(erro), status: erro?.status };
  }
}

// ── O PORTAL DO CLIENTE ───────────────────────────────────────────────────
//
// A tela hospedada pela Stripe onde o cliente cancela, troca o cartão, muda de
// plano e baixa as faturas.
//
// ── Por que não uma tela nossa ────────────────────────────────────────────
//
// Porque "cancelar" não é um botão. É cancelar valendo no fim do período pago,
// mostrar a data em que o acesso acaba, deixar voltar atrás antes dela, aceitar
// um cartão novo quando o atual vence, e entregar a fatura em PDF para a
// contabilidade. Cada uma dessas é uma tela, e as cinco já existem prontas,
// traduzidas e testadas contra fraude do outro lado.
//
// O que amarra o portal ao produto é o webhook: cancelou lá, a Stripe manda
// `customer.subscription.updated` e depois `.deleted`, e os tratadores do
// painel derrubam o plano. Nada aqui precisa ler a resposta do portal.
//
// ── O CLIENTE TEM DE EXISTIR ──────────────────────────────────────────────
//
// O portal é aberto para um `cus_...`, não para uma assinatura. Quem nunca
// pagou não tem um, e não há portal para abrir — a recusa é do chamador.
async function abrirPortal({ secretKey, clienteId, voltarPara }) {
  const chave = String(secretKey || "").trim();
  if (!chave) return { erro: "sem_chave" };
  if (!clienteId) return { erro: "sem_cliente" };

  try {
    const sessao = await api(chave, "billing_portal/sessions", {
      customer: clienteId,
      // Para onde o botão "voltar" do portal manda. É a casa DELE, tirada do
      // registro central — nunca do cabeçalho do navegador.
      return_url: voltarPara,
    });
    return { ok: true, url: sessao.url };
  } catch (erro) {
    return { erro: "stripe", detalhe: erro?.message || String(erro), status: erro?.status };
  }
}

module.exports = { criarCheckout, abrirPortal };
