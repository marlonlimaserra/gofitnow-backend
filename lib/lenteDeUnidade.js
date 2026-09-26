const { ObjectId } = require("mongodb");

// A UNIDADE DEIXOU DE SER LENTE E VIROU CERCA.
//
// *"ok, faça isso"* (26/09/2026), depois de eu explicar o buraco.
//
// ── O QUE ERA, E POR QUE ERA UM BURACO ───────────────────────────────────
//
// O seletor no alto do menu mandava `?unit=` e o servidor obedecia. Ele nunca
// conferia se aquela pessoa PODE ver a unidade pedida — nem o que fazer quando
// o pedido chegava sem filtro nenhum.
//
// Então a recepcionista atribuída a Niterói via só Niterói na tela dela, e
// via a casa inteira em qualquer pedido que não mandasse o filtro: um `curl`
// com a sessão dela, uma chave de API, ou simplesmente um app que não mande o
// parâmetro. A tela escondia; o servidor não.
//
// ── A REGRA ──────────────────────────────────────────────────────────────
//
// `user.units` vazio = alcança TODAS. É o estado de toda conta que existe hoje,
// e a leitura que não estraga nada: ninguém acorda amanhã sem ver ninguém.
//
// Com a lista preenchida, o servidor decide:
//
//   pediu uma das dela   → filtra por essa (a lente continua funcionando)
//   pediu outra          → IGNORA o pedido e devolve as dela. Não é 403: um
//                          seletor com um id velho, ou um link mandado por
//                          alguém que alcança mais, não é ataque — e uma tela
//                          de erro no lugar da lista seria pior que a lista
//                          certa.
//   não pediu nada       → as dela, todas
//
// ── O QUE NÃO TEM UNIDADE CONTINUA APARECENDO ────────────────────────────
//
// Um registro sem unidade (`unit: null`) é da CASA, não de outra unidade: a
// conta de luz do escritório, o funcionário que atende nas duas. Esconder isso
// de quem está restrito faria a tela dela parecer quebrada — e não protegeria
// nada, porque não é dado de unidade alheia.
function permitidas(user) {
  const lista = Array.isArray(user?.units) ? user.units : [];

  return lista
    .map((u) => String(u || "").trim())
    .filter((u) => ObjectId.isValid(u));
}

// O recorte que os modelos entendem. Devolve SEMPRE os dois campos, para o
// chamador poder espalhar sem pensar:
//
//   unit   — uma unidade só (a lente escolhida), como era antes
//   units  — a cerca: a lista que esta pessoa alcança, quando ela é restrita e
//            não escolheu uma das dela
function recorte(user, pedida) {
  const minhas = permitidas(user);
  const escolhida = String(pedida || "").trim();

  // Sem restrição: tudo como antes. A lente é do usuário, e ele alcança todas.
  if (!minhas.length) return { unit: escolhida, units: null };

  if (escolhida && minhas.includes(escolhida)) return { unit: escolhida, units: null };

  return { unit: "", units: minhas };
}

// Para o `$match` dos modelos: a lista de ids MAIS o que não tem unidade.
//
// Fica aqui, e não repetido em oito modelos, porque é a parte fácil de
// escrever diferente — e escrever diferente em um lugar só é o suficiente para
// a cerca ter um furo.
function filtroDeUnidades(units) {
  if (!Array.isArray(units) || !units.length) return null;

  return {
    $or: [{ unit: { $in: units.map((u) => new ObjectId(String(u))) } }, { unit: null }],
  };
}

module.exports = { permitidas, recorte, filtroDeUnidades };
