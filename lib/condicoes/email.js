module.exports = {
  chave: "email",
  categoria: "contato",
  icone: "Mail",
  tipo: "texto",
  campo: "email",
  // *"'tem e-mail' e 'e-mail', mais fácil deixar só e-mail, e por padrão já
  // vem a opção 'Está preenchido'"* (10/10/2026). Eram duas entradas para o
  // mesmo campo: uma perguntava se existe, a outra o que está escrito. É a
  // MESMA pergunta com operadores diferentes, e duas linhas obrigavam a
  // adivinhar qual delas abre a que se quer.
  padrao: "preenchido",
};
