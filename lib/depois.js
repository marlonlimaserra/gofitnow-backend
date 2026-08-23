// TRABALHO QUE ACONTECE DEPOIS DA RESPOSTA.
//
// Nasceu do cadastro de um espaço novo, que levava 4 segundos: criar 29 coleções
// e 85 índices (~900 ms) e ESPERAR o SMTP (~2 s) antes de responder. Quem se
// inscreveu ficava olhando uma tela parada enquanto o servidor fazia coisas que
// não mudam nada do que ele vai ver no primeiro minuto.
//
// Duas regras, e as duas custaram para aprender em outros lugares:
//
//   NUNCA derruba a requisição. Já respondemos — não há mais para quem contar o
//   erro. Falha aqui é linha de log, e a próxima passada conserta (tudo o que
//   entra aqui é idempotente de propósito).
//
//   `setImmediate` e não `await`: o retorno da rota tem de chegar ao navegador
//   antes de a tarefa começar, senão a espera continua existindo, só mudou de
//   nome.
function depois(rotulo, tarefa) {
  setImmediate(() => {
    Promise.resolve()
      .then(tarefa)
      .catch((erro) => {
        console.error(`[depois] ${rotulo}:`, erro?.message || erro);
      });
  });
}

module.exports = depois;
