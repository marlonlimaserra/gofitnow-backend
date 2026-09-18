// OS ESTADOS DE UM PAGAMENTO — a lista, num lugar só.
//
// ── POR QUE ELA VEM DO SERVIDOR ───────────────────────────────────────────
//
// Mesma razão da lista de estados da cobrança, e o pedido foi o mesmo:
// *"coloque esse status, em uma variavel no backend, [{},{}] assim, se agente
// adicionar um status novo, a chamada ja traz, e não precisa mexer em nada do
// frontend."*
//
// Ela estava em DOIS lugares — `STATUS_PAGAMENTO` no modelo e `STATUS` no
// formulário — e o segundo era o que se esqueceria, porque esquecê-lo não
// quebra nada: só deixa de oferecer o estado novo, calado.
//
// ── `canceled` ENTROU EM 18/09/2026 ───────────────────────────────────────
//
// Relato dele: *"é que cancelou, mas o pagamento ficou pago, acho melhor por um
// status cancelado"*. Ele cancelou a cobrança e o pagamento continuou contando
// como recebido.
//
// E `refunded` não servia, porque são coisas diferentes:
//
//   refunded   o dinheiro ENTROU e VOLTOU. Houve duas movimentações, e as duas
//              aconteceram — é o que o extrato do banco mostra.
//   canceled   o lançamento não devia existir. Registro errado, cobrança de
//              teste, aula que não houve. Nada se moveu.
//
// Para o SALDO os dois dão no mesmo (nenhum é receita), e é por isso que seria
// tentador reusar um. Para quem lê o histórico meses depois, não: "reembolsado"
// diz que houve devolução, e devolução que não houve é uma conversa com o
// cliente que ninguém quer ter.
//
// ── `paid` É O ÚNICO QUE É DINHEIRO ───────────────────────────────────────
//
// `entra` é o que o saldo pergunta, e é ele que decide — não o nome. Um estado
// novo que não seja receita nasce com `entra: false` e todas as contas do
// sistema o respeitam sem ninguém procurar os lugares.
const STATUS = [
  { id: "paid", tom: "ok", rotulo: "finance.paymentStatus.paid", entra: true },
  { id: "pending", tom: "aviso", rotulo: "finance.paymentStatus.pending", entra: false },
  { id: "refunded", tom: "neutro", rotulo: "finance.paymentStatus.refunded", entra: false },
  { id: "canceled", tom: "neutro", rotulo: "finance.paymentStatus.canceled", entra: false },
];

const IDS = STATUS.map((s) => s.id);

// ── O PADRÃO É `paid`, e isso é sobre o PASSADO ──────────────────────────
//
// Lançamento anterior a este campo não o tem, e ausente é `paid`: era o único
// significado possível antes de ele existir. Ler ausência como "pendente"
// reescreveria o passado — o saldo de todo mundo que já usava o sistema mudaria
// sozinho, sem ninguém ter tocado em nada.
const PADRAO = "paid";

const ENTRAM = STATUS.filter((s) => s.entra).map((s) => s.id);
const NAO_ENTRAM = STATUS.filter((s) => !s.entra).map((s) => s.id);

// ── O FILTRO DO BANCO É `$nin`, e NÃO `status: "paid"` ───────────────────
//
// Porque pagamento antigo NÃO TEM o campo, e ausente significa pago (ver
// `PADRAO`). Um `{ status: "paid" }` literal não casa com documento sem o
// campo — então ele deixaria de fora justamente os lançamentos mais antigos da
// conta, e o "Recebido" da carteira discordaria do total da ficha da pessoa,
// que soma em JavaScript e trata ausente como pago.
//
// `$nin` casa com o ausente de graça, e ainda fica certo sozinho quando um
// estado novo entrar: basta ele nascer com `entra: false`.
function filtroDeEntrada() {
  return { status: { $nin: NAO_ENTRAM } };
}

function normalizar(id) {
  return IDS.includes(String(id || "")) ? String(id) : PADRAO;
}

// O dinheiro entrou mesmo? É esta pergunta que o saldo faz.
function entrou(pagamento) {
  return ENTRAM.includes(normalizar(pagamento?.status));
}

function paraTela(t) {
  return STATUS.map((s) => ({
    id: s.id,
    label: t ? t(s.rotulo) : s.rotulo,
    tom: s.tom,
    entra: s.entra,
  }));
}

module.exports = { STATUS, IDS, PADRAO, ENTRAM, NAO_ENTRAM, filtroDeEntrada, normalizar, entrou, paraTela };
