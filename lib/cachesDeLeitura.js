const sessaoGuardada = require("./sessaoGuardada.js");
const aparenciaGuardada = require("./aparenciaGuardada.js");

// O QUE PRECISA CAIR QUANDO UMA COLLECTION É ESCRITA.
//
// ── Por que este arquivo existe ───────────────────────────────────────────
//
// O cache de sessão guarda o documento do usuário por um minuto. Toda escrita em
// `users` o envelhece — e "lembrar de limpar" falhou três vezes no dia em que ele
// nasceu, cada uma num lugar diferente:
//
//   `savePreferences`        o caso que o Marlon previu de cabeça
//   `revokeStudentAccess`    e este era de segurança
//   `Avatar_model`           que nem chama a collection pelo nome
//
// A terceira é a que decide o desenho: uma busca por `collection("users")` não a
// acha, porque ela pega a collection por outro caminho. Nenhuma varredura de
// TEXTO daria conta, e um teste que varre texto teria dito que estava tudo bem.
//
// ── A cura é estrutural ───────────────────────────────────────────────────
//
// `lib/escopo.js` já embrulha TODA collection de cliente para injetar o
// `instance`. É o único lugar por onde toda escrita passa obrigatoriamente —
// então é ali que a limpeza tem de morar, e não na memória de quem escreve.
//
// Acrescentar um cache novo é acrescentar uma linha AQUI. Acrescentar uma função
// que escreve não exige nada: ela já está coberta no dia em que nasce.
//
// ── O id sai do FILTRO ────────────────────────────────────────────────────
//
// Quase toda escrita mira `{ _id: ... }`, e aí dá para limpar exatamente aquela
// pessoa. Quando não dá — um `updateMany` por outro campo, um `bulkWrite` —, o
// cache do cliente inteiro cai. É desperdício, e é o desperdício certo: o
// contrário é servir dado velho sem saber.
function idsDoFiltro(filtro) {
  const alvo = filtro?._id;
  if (!alvo) return null;

  if (Array.isArray(alvo?.$in)) return alvo.$in.map(String);
  if (typeof alvo === "string" || typeof alvo?.toString === "function") return [String(alvo)];

  return null;
}

// collection → o que fazer quando ela é escrita.
const QUANDO_ESCREVE = {
  // A APARÊNCIA vale seis horas, e é justamente por isso que a limpeza dela não
  // pode depender de ninguém lembrar: "espera expirar" seria a cor antiga até de
  // noite. As duas collections que a compõem entram aqui.
  configurations: (filtro, instancia) => aparenciaGuardada.esquecer(instancia),
  brand_images: (filtro, instancia) => aparenciaGuardada.esquecer(instancia),

  users: async (filtro, instancia) => {
    const ids = idsDoFiltro(filtro);

    if (ids) {
      for (const id of ids) await sessaoGuardada.esquecerUsuario(id, instancia);
      return;
    }

    await sessaoGuardada.esquecerTudo(instancia);
  },
};

// Chamado por `lib/escopo.js` DEPOIS de cada escrita.
//
// Nunca lança e nunca é esperado: a escrita já aconteceu e a resposta já é do
// chamador. Uma falha aqui custa, no pior caso, um minuto de dado velho — nunca
// a operação.
function aoEscrever(colecao, filtro, instancia) {
  const acao = QUANDO_ESCREVE[colecao];
  if (!acao) return;

  Promise.resolve(acao(filtro, instancia)).catch((erro) =>
    console.error(`[cache] não consegui limpar ${colecao}:`, erro?.message)
  );
}

module.exports = { aoEscrever, idsDoFiltro, QUANDO_ESCREVE };
