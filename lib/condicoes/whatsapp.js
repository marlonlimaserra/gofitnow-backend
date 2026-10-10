// ── O NÚMERO É GUARDADO COMO FOI DIGITADO ────────────────────────────────
//
// *"faltou o campo whatsapp"* (10/10/2026). WhatsApp aqui É o `phone` — é dele
// que sai o link verde da lista.
//
// E `phone` entra no banco como a pessoa escreveu: `(21) 97168-5171` e
// `21971685171` convivem. Um `contém` cru acharia um e não o outro, e quem
// procurasse pelo número copiado do telefone não acharia a ficha que está bem
// ali — o pior resultado possível numa busca.
//
// Então a busca é por DÍGITOS, tolerante a formatação dos dois lados: "21971"
// vira `2\D*1\D*9\D*7\D*1`, que casa com as duas formas. Os dígitos do usuário
// são escapados pelo próprio `\d` — não há como injetar expressão por aí.
module.exports = {
  chave: "whatsapp",
  categoria: "contato",
  icone: "MessageCircle",
  tipo: "texto",
  campo: "phone",
  // "Tem telefone" morava à parte e era esta mesma condição com o operador
  // "está preenchido" — que agora é o padrão dela.
  padrao: "preenchido",
  montar: (v, op) => {
    const d = String(v).replace(/\D+/g, "");
    // Busca sem dígito nenhum não é busca de telefone. Devolver `null`
    // descarta a condição, e o contador do botão não a conta — a tela e o
    // resultado continuam dizendo a mesma coisa.
    if (!d) return null;

    const padrao = d.split("").join("\\D*");
    if (op === "nao_contem") return { phone: { $not: new RegExp(padrao) } };
    // "é" num telefone é "termina com": ninguém guarda o número exatamente
    // igual em todo lugar, e exigir igualdade literal nunca acha nada.
    if (op === "e") return { phone: { $regex: padrao + "$" } };
    return { phone: { $regex: padrao } };
  },
};
