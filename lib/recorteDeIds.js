const { ObjectId } = require("mongodb");

// AS LINHAS MARCADAS, vindas da tela.
//
// *"então veja no web TUDO que fizemos de checkbox e faça no app também"*
// (23/09/2026). A exportação do que está marcado manda `?ids=a,b,c`, e toda
// lista que aceita isso precisa interpretar a lista do mesmo jeito.
//
// ── NENHUM ID VÁLIDO É NENHUMA LINHA ──────────────────────────────────────
//
// Devolver `null` quando a lista chega vazia parece defensivo e é o contrário:
// `null` quer dizer "não há recorte", e o chamador então traz TUDO. Mandar uma
// lista de marcados que o servidor não entende e receber a base inteira é o
// pior resultado possível — o arquivo sai plausível, com gente que ninguém
// escolheu, e quem o recebe não tem como desconfiar.
//
// Por isso: parâmetro AUSENTE devolve `null` (sem recorte); parâmetro PRESENTE
// devolve sempre um array, ainda que vazio — e um `$in: []` não casa com nada.
function recorteDeIds(ids) {
  if (ids === undefined || ids === null || ids === "") return null;

  const bruto = Array.isArray(ids) ? ids : String(ids).split(",");

  return bruto
    .map((x) => String(x).trim())
    .filter((x) => ObjectId.isValid(x))
    .map((x) => new ObjectId(x));
}

// A mesma pergunta para uma lista que já está na memória — o catálogo de
// equipamentos, o estoque, o histórico montado das duas pontas. Ali não há
// pipeline onde encaixar um `$match`, e ir ao banco de novo só para recortar
// trinta linhas seria uma consulta paga por nada.
function somenteEscolhidos(linhas, ids, chaveDe = (l) => String(l._id || l.id)) {
  if (ids === undefined || ids === null || ids === "") return linhas;

  const querido = new Set(
    (Array.isArray(ids) ? ids : String(ids).split(",")).map((x) => String(x).trim()).filter(Boolean)
  );

  return linhas.filter((l) => querido.has(chaveDe(l)));
}

module.exports = { recorteDeIds, somenteEscolhidos };
