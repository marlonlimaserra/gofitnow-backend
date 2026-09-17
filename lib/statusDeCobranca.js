// OS ESTADOS DE UMA COBRANÇA — a lista, num lugar só.
//
// ── POR QUE ELA VEM DO SERVIDOR ───────────────────────────────────────────
//
// Pedido do Marlon em 17/09/2026: *"coloque esse status, em uma variavel no
// backend, [{},{}] assim, se agente adicionar um status novo, a chamada ja
// traz, e não precisa mexer em nada do frontend."*
//
// Antes a mesma lista existia em três lugares: o filtro do modelo, os chips da
// tela, e o mapa de rótulos ao lado deles. Acrescentar um estado exigia acertar
// os três — e o terceiro era o que se esquecia, porque esquecê-lo não quebra
// nada: só mostra a chave crua no botão.
//
// ── O QUE VIAJA, E O QUE NÃO ──────────────────────────────────────────────
//
// Vai o `id`, o `label` JÁ TRADUZIDO, e um `tom` semântico.
//
// O tom é "aviso", "perigo", "ok", "neutro" — e não uma classe de CSS. Cor é
// decisão da tela: o app, o painel e o papel pintam o mesmo aviso de formas
// diferentes, e um `bg-amber-50` viajando pela API amarraria os três ao
// Tailwind da web. A tela mapeia tom → cor; um estado NOVO que reuse um tom
// existente aparece sozinho, que é o pedido.
//
// ── `late` NÃO É GRAVADO, e está aqui de propósito ────────────────────────
//
// "Atrasada" é uma cobrança ABERTA cuja data passou — calculada na leitura, sem
// existir na collection. Ela mora nesta lista porque, para quem OLHA a tela,
// é um estado como os outros; quem precisa saber a diferença é o `carteira`,
// e ele a sabe pelo `gravado: false`.
const STATUS = [
  { id: "open", tom: "aviso", rotulo: "finance.status.open", gravado: true },
  { id: "late", tom: "perigo", rotulo: "finance.status.late", gravado: false },
  { id: "paid", tom: "ok", rotulo: "finance.status.paid", gravado: true },
  { id: "canceled", tom: "neutro", rotulo: "finance.status.canceled", gravado: true },
];

const IDS = new Set(STATUS.map((s) => s.id));

// Os que existem na collection — o que se pode pôr num `$set` de status.
const GRAVAVEIS = STATUS.filter((s) => s.gravado).map((s) => s.id);

function existe(id) {
  return IDS.has(String(id || ""));
}

// A lista para a tela, com o rótulo no idioma de quem pediu.
//
// Recebe o `t` da requisição em vez de importar o i18n: é o mesmo padrão das
// mensagens de erro, e é o que faz a resposta sair no idioma da PESSOA e não no
// do servidor.
function paraTela(t) {
  return STATUS.map((s) => ({
    id: s.id,
    label: t(s.rotulo),
    tom: s.tom,
  }));
}

// Lê o que a tela mandou — texto único ("open") ou lista ("open,late") — e
// devolve só o que é válido. O que não reconhecer é DESCARTADO, não recusado:
// um valor velho guardado no navegador não pode esvaziar a tela de dinheiro de
// ninguém.
function pedidos(bruto) {
  return new Set(
    String(bruto || "")
      .split(",")
      .map((x) => x.trim())
      .filter(existe)
  );
}

module.exports = { STATUS, IDS, GRAVAVEIS, existe, paraTela, pedidos };
