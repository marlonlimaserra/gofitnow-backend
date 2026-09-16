const test = require("node:test");
const assert = require("node:assert/strict");

const { bookingReceived } = require("../../lib/emailTemplates.js");
const { EVENTOS } = require("../../lib/avisar.js");

// ── O AVISO DE QUEM MARCOU (16/09/2026) ───────────────────────────────────
//
// "quando alguém fizer agendamento, envie uma notificação pelo app se der, e um
// e-mail bem bonito para o dono ou pessoa do calendário."
//
// A página pública é a única porta em que alguém marca SEM o profissional estar
// na frente. Sem aviso, a primeira notícia de um compromisso das 08:00 é abrir a
// agenda de manhã — ou a pessoa batendo na porta.
//
// O que se prova aqui é o CONTEÚDO e a DIREÇÃO. O disparo em si é "melhor
// esforço" por decisão (ver o comentário no controller), e um teste que exigisse
// o envio testaria o dobro do mailer, não a regra.

test("o evento de push existe e aponta para a AGENDA", async () => {
  // A rota importa: quem toca em "marcaram às 08:00" quer ver o dia, para saber
  // o que tem em volta — não a lista de compromissos soltos.
  assert.equal(EVENTOS.booking.rota, "/agenda");
  assert.equal(EVENTOS.booking.chave, "push.booking");
});

test("o e-mail leva quem, o quê, quando e o contato", async () => {
  // As quatro coisas que decidem o dia de quem atende. Faltando o contato, ele
  // tem de abrir o sistema para responder a quem marcou.
  const m = bookingReceived({
    lang: "pt-BR",
    name: "Marlon Lima",
    person: "Carla Menezes",
    service: "Avaliação Física",
    when: "quinta-feira, 17 de setembro de 2026 às 08:00",
    contact: "carla@exemplo.com",
    url: "https://marlon.vafit.app/agenda",
  });

  for (const pedaco of ["Carla Menezes", "Avaliação Física", "08:00", "carla@exemplo.com"]) {
    assert.ok(m.html.includes(pedaco), "faltou no html: " + pedaco);
  }
  assert.ok(m.subject.includes("Carla Menezes"), "o assunto tem de dizer QUEM marcou");
  assert.ok(m.html.includes("https://marlon.vafit.app/agenda"), "o botão leva para a agenda");
});

test("o PRIMEIRO NOME de quem recebe, como nos outros e-mails", async () => {
  // "Marlon Lima Serra" viraria uma saudação de crachá. O `build` corta, e este
  // caso trava a passagem por ele.
  const m = bookingReceived({
    lang: "pt-BR",
    name: "Marlon Lima Serra",
    person: "Carla",
    service: "Consulta",
    when: "hoje às 09:00",
    contact: "—",
    url: "https://x/agenda",
  });

  assert.ok(m.html.includes("Marlon,"), "esperava só o primeiro nome");
  assert.ok(!m.html.includes("Marlon Lima Serra,"), "o nome completo vazou para a saudação");
});

test("a OBSERVAÇÃO do cliente não entra no e-mail", async () => {
  // Ela pode ter dado de saúde ("tenho hérnia", "estou grávida"), e e-mail não é
  // lugar para isso: ele atravessa servidor de terceiro e fica na caixa para
  // sempre. Fica na ficha, atrás de login.
  //
  // O template não tem o campo — este caso existe para que ACRESCENTÁ-LO passe
  // a exigir uma decisão, em vez de acontecer por conveniência.
  const m = bookingReceived({
    lang: "pt-BR",
    name: "Marlon",
    person: "Carla",
    service: "Consulta",
    when: "hoje às 09:00",
    contact: "carla@exemplo.com",
    url: "https://x/agenda",
    // Mandado de propósito, e tem de ser ignorado.
    notes: "tenho hérnia de disco",
  });

  assert.ok(!m.html.includes("hérnia"), "a observação vazou para o e-mail");
  assert.ok(!m.text.includes("hérnia"));
});

test("sai nos quatro idiomas, com as variáveis trocadas", async () => {
  // Uma variável que não existe no dicionário de um idioma aparece crua na
  // caixa de entrada — e o e-mail é o lugar onde isso não se conserta depois.
  for (const lang of ["pt-BR", "en", "es", "fr"]) {
    const m = bookingReceived({
      lang,
      name: "Marlon",
      person: "Carla",
      service: "Consulta",
      when: "hoje às 09:00",
      contact: "carla@exemplo.com",
      url: "https://x/agenda",
    });

    assert.ok(m.subject.includes("Carla"), lang + ": o assunto perdeu o nome");
    assert.ok(!m.html.includes("{{"), lang + ": sobrou variável crua no html");
    assert.ok(!m.subject.includes("{{"), lang + ": sobrou variável crua no assunto");
    assert.ok(!m.text.includes("{{"), lang + ": sobrou variável crua no texto");
  }
});
