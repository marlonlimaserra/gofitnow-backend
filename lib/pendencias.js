// O QUE FALTA UM ALUNO ENTREGAR.
//
// *"sempre que um aluno se matricula, é obrigatório ele preencher alguns desses
// documentos"* — e depois: *"só cadastra como pendência, não precisa travar até
// o login dele no app"*.
//
// ── ELA NÃO TRANCA NADA, e isso foi uma decisão ─────────────────────────
//
// A primeira versão barrava o login de quem tivesse documento faltando. O
// Marlon cortou isso, e o corte é o certo: o propósito da pendência é fazer
// alguém ser PARADO NO BALCÃO — e para isso basta ela aparecer na cara de quem
// atende. Trancar o app é punir a pessoa por algo que se resolve em dez
// segundos na recepção, e é a parte do recurso que gera telefonema.
//
// O que sobrou é mais simples e faz o mesmo trabalho: um aviso na ficha.
//
// ── UM LUGAR SÓ, porque várias telas fazem a mesma pergunta ─────────────
//
// A aba Pendências, o selo da aba e um dia a lista de alunos. Se cada uma
// calculasse por conta própria, o dia em que a regra mudasse — um modelo
// desativado deixa de contar, uma dispensa passa a valer — deixaria uma delas
// para trás.
//
// ── O QUE CONTA COMO PENDÊNCIA ──────────────────────────────────────────
//
// Um modelo ATIVO, marcado como obrigatório, que a pessoa não cumpriu — nem
// com arquivo, nem com dispensa.
//
// Modelo desativado NÃO gera pendência, e isto é o freio de emergência: a casa
// que trancou a base inteira sem querer desativa o modelo e todo mundo volta,
// sem precisar mexer em aluno nenhum.
async function pendenciasDe(app, personId) {
  const [modelos, cumpridos, manuais] = await Promise.all([
    app.api.documentTemplate.listar({ somenteAtivos: true }),
    app.api.personDocument.modelosCumpridos(personId),
    // As escritas à mão — a camisa, a carteirinha, o que for. Elas já vêm
    // prontas do modelo, com a mesma forma das derivadas.
    app.api.pendency.listar(personId),
  ]);

  const feitos = new Set(cumpridos);

  const deDocumento = modelos
    .filter((m) => m.obrigatorio && !feitos.has(m.id))
    .map((m) => ({
      id: m.id,
      origem: "documento",
      titulo: m.name,
      categoria: "documento",
      // O documento obrigatório é sempre coisa que o ALUNO entrega.
      quem: "aluno",
      note: m.descricao || "",
    }));

  // As MANUAIS primeiro: alguém as escreveu agora, para alguém ser parado hoje.
  // As de documento são as de sempre, e podem esperar o fim da lista.
  return [...manuais, ...deDocumento];
}

module.exports = { pendenciasDe };
