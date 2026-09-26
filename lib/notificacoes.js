// O QUE A PESSOA QUER RECEBER.
//
// *"nas preferências do usuário ele pode [escolher] quais notificações ele quer
// ou não receber; por padrão vem tudo ativado. Aí vários e-mails que vamos
// enviar vai verificar essas notificações"*.
//
// ── UMA CHAVE POR ASSUNTO, e não por canal ────────────────────────────────
//
// "Treino novo" é um assunto; que ele chegue por push hoje e por e-mail amanhã
// é decisão nossa, não dela. Duas listas (uma de e-mail, outra de push) seriam
// duas perguntas sobre a mesma coisa — e o dia em que um assunto ganhasse o
// segundo canal, ele passaria despercebido pela escolha que ela já tinha feito.
//
// ── O QUE NÃO ENTRA NESTA LISTA ───────────────────────────────────────────
//
// Recuperar senha, confirmar a criação da conta e confirmar a exclusão dela.
// Não é esquecimento: são cartas que a pessoa PEDIU, uma a uma, e desligá-las
// tranca alguém para fora do próprio sistema. Uma preferência que pode
// trancar a porta não é preferência, é armadilha.
//
// ── O PADRÃO É RECEBER ────────────────────────────────────────────────────
//
// `querReceber` só diz não quando há um `false` gravado. Assim quem nunca abriu
// esta tela — que é todo mundo hoje — continua recebendo exatamente o que
// recebia, e uma chave nova nasce ligada para quem já existia.
const CHAVES = [
  // Os quatro do dia a dia de quem treina.
  "workout",
  "diet",
  "assessment",
  "message",
  // Quem ATENDE: marcaram um horário na agenda dele.
  "booking",
  // A pessoa foi inscrita num aulão.
  "aulao",
  // A resposta de um chamado de suporte.
  "ticket",
  // Um documento (avaliação, plano, extrato, termo) enviado por e-mail.
  "documento",
  // O convite para responder a anamnese.
  "anamnese",
];

function existe(chave) {
  return CHAVES.includes(String(chave || ""));
}

// `user` é o documento de quem RECEBE. Sem ele — e acontece, o destinatário
// pode ter sido apagado entre o evento e o envio — a resposta é sim: perder um
// aviso por causa de um documento que sumiu é pior que um aviso a mais.
function querReceber(user, chave) {
  if (!existe(chave)) return true;
  return user?.preferences?.notify?.[chave] !== false;
}

// O que a tela grava. Só as chaves conhecidas, e só booleanos: o corpo vem do
// navegador, e `preferences` é um campo livre — sem esta peneira, qualquer
// coisa entraria no documento do usuário por esta porta.
function limpar(corpo) {
  const saida = {};
  for (const chave of CHAVES) {
    if (corpo && chave in corpo) saida[chave] = corpo[chave] !== false;
  }
  return saida;
}

// A lista para a tela, já com o estado de cada uma.
function paraTela(user) {
  return CHAVES.map((chave) => ({ chave, ligada: querReceber(user, chave) }));
}

module.exports = { CHAVES, existe, querReceber, limpar, paraTela };
