const test = require("node:test");
const assert = require("node:assert/strict");

const { passwordReset, studentInvite, accessRequest } = require("../../lib/emailTemplates.js");
const { LANGUAGES } = require("../../lib/i18n");

const RESET = { name: "Marlon Lima Serra", url: "https://app.gofitnow.fit/reset?token=abc", minutes: 30 };
const INVITE = { name: "Ana Paula", trainerName: "Marlon", email: "ana@x.com", url: "https://app.gofitnow.fit" };
const REQUEST = {
  name: "Ana Paula",
  professionalName: "Marlon",
  professionalEmail: "marlon@x.com",
  url: "https://app.gofitnow.fit/access-request?token=abc",
  days: 7,
};

const TODOS = [
  ["passwordReset", passwordReset, RESET],
  ["studentInvite", studentInvite, INVITE],
  ["accessRequest", accessRequest, REQUEST],
];

test("cada e-mail sai no idioma pedido", () => {
  assert.match(passwordReset({ ...RESET, lang: "pt-BR" }).subject, /Redefinir sua senha/);
  assert.match(passwordReset({ ...RESET, lang: "en" }).subject, /Reset your GoFitNow password/);
  assert.match(passwordReset({ ...RESET, lang: "fr" }).subject, /Réinitialiser/);
});

test("sem lang, ou com um idioma que não atendemos, sai em pt-BR", () => {
  // Quem nunca escolheu idioma não tem o campo na conta.
  for (const lang of [undefined, null, "", "de", "ja-JP"]) {
    assert.match(passwordReset({ ...RESET, lang }).subject, /Redefinir sua senha/);
  }
});

test("nenhuma marca {{...}} sobra em nenhum e-mail, em nenhum idioma", () => {
  // É o erro que entrega "vale por {{minutes}} minutos" na caixa de entrada.
  for (const lang of LANGUAGES) {
    for (const [nome, fn, args] of TODOS) {
      const m = fn({ ...args, lang });
      for (const parte of ["subject", "html", "text"]) {
        assert.ok(!/{{\w+}}/.test(m[parte]), `${lang} ${nome}.${parte}: sobrou marca`);
      }
    }
  }
});

test("o valor de cada variável aparece de verdade no corpo", () => {
  for (const lang of LANGUAGES) {
    const reset = passwordReset({ ...RESET, lang });
    assert.ok(reset.html.includes("30"), `${lang}: prazo sumiu do html`);
    assert.ok(reset.html.includes(RESET.url), `${lang}: link sumiu do html`);
    assert.ok(reset.text.includes(RESET.url), `${lang}: link sumiu do texto`);

    const pedido = accessRequest({ ...REQUEST, lang });
    assert.ok(pedido.subject.includes("Marlon"), `${lang}: quem pede sumiu do assunto`);
    assert.ok(pedido.html.includes("marlon@x.com"), `${lang}: e-mail de quem pede sumiu`);
    assert.ok(pedido.html.includes("7"), `${lang}: prazo sumiu`);
  }
});

test("usa só o primeiro nome, como quem chama alguém", () => {
  const m = passwordReset({ ...RESET, lang: "pt-BR" });
  assert.ok(m.text.startsWith("Marlon,"));
  assert.ok(!m.text.includes("Lima Serra"));
});

test("sem nome, entra o cumprimento do idioma — a frase não pode começar com vírgula", () => {
  assert.ok(passwordReset({ ...RESET, lang: "pt-BR", name: "" }).text.startsWith("Olá,"));
  assert.ok(passwordReset({ ...RESET, lang: "en", name: null }).text.startsWith("Hello,"));
  assert.ok(passwordReset({ ...RESET, lang: "fr", name: undefined }).text.startsWith("Bonjour,"));
});

test("o <html lang> acompanha o idioma do e-mail", () => {
  for (const lang of LANGUAGES) {
    const html = passwordReset({ ...RESET, lang }).html;
    assert.match(html, new RegExp(`<html lang="${lang}"`), `${lang}: lang do html errado`);
  }
});

test("todo e-mail tem assunto, html e texto, e nenhum vazio", () => {
  for (const lang of LANGUAGES) {
    for (const [nome, fn, args] of TODOS) {
      const m = fn({ ...args, lang });
      for (const parte of ["subject", "html", "text"]) {
        assert.equal(typeof m[parte], "string", `${lang} ${nome}.${parte}`);
        assert.ok(m[parte].trim().length > 0, `${lang} ${nome}.${parte} vazio`);
      }
    }
  }
});

test("o botão e o endereço de reserva aparecem quando há link", () => {
  // Cliente de e-mail que bloqueia o botão precisa do endereço em texto.
  const m = accessRequest({ ...REQUEST, lang: "en" });
  assert.ok(m.html.includes(`href="${REQUEST.url}"`));
  assert.ok(m.html.includes("If the button does not work"));
});

test("a versão em texto não carrega HTML", () => {
  for (const lang of LANGUAGES) {
    for (const [nome, fn, args] of TODOS) {
      const { text } = fn({ ...args, lang });
      assert.ok(!/<[a-z/][^>]*>/i.test(text), `${lang} ${nome}: html vazou no texto`);
    }
  }
});
