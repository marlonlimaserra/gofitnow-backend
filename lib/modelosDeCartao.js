// MODELOS DE COR PARA O CARTÃO DE UM PLANO.
//
// Pedido do Marlon em 18/09/2026, com a aba de aparência aberta: *"monte um
// modelo de cores, igual você fez em aparência"*.
//
// ── Por que um modelo e não cinco seletores ─────────────────────────────
//
// Cinco cores escolhidas uma a uma dão 5 decisões e um cartão ilegível na
// primeira tentativa — fundo escuro com texto escuro, botão que some no fundo.
// Um modelo é UMA decisão, e cada um deles já nasce com o contraste resolvido.
//
// Os seletores continuam lá: o modelo é o ponto de partida, não a cerca.
//
// ── Por que no servidor, como as cadências e os status ──────────────────
//
// Mesmo motivo dos outros catálogos desta casa: o nome viaja traduzido e
// acrescentar um modelo é mexer num arquivo só. Uma lista escrita na tela
// precisaria dos quatro idiomas repetidos lá dentro.
//
// ── O CONTRASTE É A REGRA, e não uma sugestão ───────────────────────────
//
// Em todo modelo: o texto contra o fundo, o texto do botão contra o botão, e
// o botão e o selo contra o fundo. Um modelo bonito que deixa "Quero este
// plano" ilegível é pior que nenhum, porque ele parece aprovado. O teste de
// contraste cobra cada uma dessas quatro leituras — e já reprovou um selo.
//
// O TEXTO DO SELO não está aqui de propósito: ele é DERIVADO da cor do selo
// no cartão (preto ou branco, o que for legível), e não um sexto campo. Um
// selo verde-limão com texto branco é ilegível, e não dá para pedir que quem
// escolhe uma cor bonita lembre disso.
const MODELOS = [
  // O PRIMEIRO é o vazio, de propósito: quem mexeu demais precisa de um
  // caminho de um clique de volta ao que acompanha a marca. Cores vazias não
  // são "branco" — são "sem escolha", e é isso que faz o cartão mudar junto
  // quando a marca mudar.
  {
    id: "marca",
    rotulo: "memberships.model.brand",
    cores: { corFundo: "", corTexto: "", corDestaque: "", corBotao: "", corBotaoTexto: "" },
  },
  {
    id: "claro",
    rotulo: "memberships.model.light",
    cores: {
      corFundo: "#ffffff",
      corTexto: "#0f172a",
      corDestaque: "#0f172a",
      corBotao: "#0f172a",
      corBotaoTexto: "#ffffff",
    },
  },
  {
    id: "escuro",
    rotulo: "memberships.model.dark",
    cores: {
      corFundo: "#0f172a",
      corTexto: "#f8fafc",
      corDestaque: "#38bdf8",
      corBotao: "#f8fafc",
      corBotaoTexto: "#0f172a",
    },
  },
  {
    id: "energia",
    rotulo: "memberships.model.energy",
    cores: {
      corFundo: "#dc2626",
      corTexto: "#ffffff",
      corDestaque: "#facc15",
      corBotao: "#ffffff",
      corBotaoTexto: "#b91c1c",
    },
  },
  {
    id: "oceano",
    rotulo: "memberships.model.ocean",
    cores: {
      corFundo: "#0e7490",
      corTexto: "#ecfeff",
      // Era `#22d3ee`, e ficou em 2,96:1 contra o fundo — o teste de contraste
      // reprovou por quatro centésimos. Um selo que quase some do cartão é um
      // selo que não destaca.
      corDestaque: "#67e8f9",
      corBotao: "#ecfeff",
      corBotaoTexto: "#155e75",
    },
  },
  {
    id: "neon",
    rotulo: "memberships.model.neon",
    cores: {
      corFundo: "#111827",
      corTexto: "#f9fafb",
      corDestaque: "#a3e635",
      corBotao: "#a3e635",
      corBotaoTexto: "#1a2e05",
    },
  },
  {
    id: "areia",
    rotulo: "memberships.model.sand",
    cores: {
      corFundo: "#fef3c7",
      corTexto: "#78350f",
      corDestaque: "#b45309",
      corBotao: "#78350f",
      corBotaoTexto: "#fffbeb",
    },
  },
];

// Para a tela: o nome traduzido e as cores. A AMOSTRA que a tela desenha sai
// das próprias cores — uma bolinha por modelo pintada com o fundo e o botão
// dele —, então não há um campo "cor da bolinha" para divergir do modelo.
function paraTela(t) {
  return MODELOS.map((m) => ({ id: m.id, label: t(m.rotulo), cores: { ...m.cores } }));
}

module.exports = { MODELOS, paraTela };
