// ── AS OPÇÕES VÊM DE UMA LISTA VIVA ──────────────────────────────────────
//
// *"unidade deveria vir as que eu tenho acesso se tiver mais de uma, ou as
// unidades cadastradas"* (10/10/2026). Era um campo de texto, pedindo que
// alguém digitasse um ObjectId.
//
// `fonte` diz à tela ONDE buscar; o catálogo não as embute. Elas mudam por
// conta (uma academia cadastra Paraty hoje) e, principalmente, mudam por
// PESSOA: quem só alcança Niterói não pode filtrar por Paraty, e mandar a
// lista inteira daqui entregaria o nome de unidades que essa pessoa não
// deveria nem saber que existem.
//
// Quem já sabe quais ela alcança é a lente da unidade, no alto da tela.
module.exports = {
  chave: "unidade",
  categoria: "contato",
  icone: "MapPin",
  tipo: "pessoa",
  campo: "unit",
  fonte: "unidades",
};
