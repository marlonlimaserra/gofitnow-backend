const { test, describe } = require("node:test");
const assert = require("node:assert");

const { passwordReset, anamnesisInvite } = require("../../lib/emailTemplates.js");

// OS E-MAILS DO SISTEMA.
//
// Eles saem da nossa casa e chegam na de outra pessoa: não há tela para conferir
// depois, não há F5, e um defeito só aparece quando alguém não consegue voltar
// para a própria conta.
//
// Dois relatos do Marlon deram origem a este arquivo: *"o e-mail chegou super
// feio"* e *"está indo para app.gofitnow.fit"* — o link levava ao portal em vez
// da casa de onde ele pediu.

const BASE = {
  lang: "pt-BR",
  name: "Marlon Silva",
  url: "https://marlon.gofitnow.fit/reset-password?token=abc123",
  minutes: 30,
};

describe("a marca da casa", () => {
  test("o botão sai na cor da CASA, e não numa cor de fábrica", () => {
    // Cada cliente escolhe a sua. Um e-mail com a cor de outra pessoa denuncia
    // que o sistema é alugado — que é o oposto do que o produto vende.
    const roxo = passwordReset({ ...BASE, tema: { brand: "#7c3aed" } }).html;
    const verde = passwordReset({ ...BASE, tema: { brand: "#16a34a" } }).html;

    assert.notStrictEqual(roxo, verde);
  });

  test("sem tema, cai no padrão — e NÃO quebra", () => {
    // `dataOfInstance` pode voltar sem `theme` numa casa recém-criada.
    for (const tema of [undefined, null, {}, { brand: "" }]) {
      const html = passwordReset({ ...BASE, tema }).html;
      assert.match(html, /Criar nova senha|<a href/);
      assert.doesNotMatch(html, /undefined|NaN/);
    }
  });

  test("NADA de lima nem grafite — eram as cores do ShapeApp", () => {
    // A marca foi ShapeApp por um dia em 24/08/2026 e voltou. As cores ficaram
    // aqui porque e-mail não tem variável de CSS: cada cor é escrita à mão, e
    // escrever é esquecer.
    const html = passwordReset({ ...BASE, tema: { brand: "#0ea5e9" } }).html;

    assert.doesNotMatch(html, /b5e01f/i);
    assert.doesNotMatch(html, /16200c/i);
  });

  test("a logo da CASA vence a padrão", () => {
    const daCasa = passwordReset({
      ...BASE,
      tema: { brand: "#0ea5e9", logo: "https://exemplo.com/minha-logo.png" },
    }).html;

    assert.match(daCasa, /exemplo\.com\/minha-logo\.png/);
    assert.doesNotMatch(daCasa, /gofitnow\.fit\/logo\.png/);
  });

  test("sem logo da casa, entra a nossa — e por URL, não embutida", () => {
    // Cliente de e-mail bloqueia imagem embutida com mais frequência que
    // hospedada, e um `data:` de 260 kB engorda toda mensagem.
    const html = passwordReset({ ...BASE, tema: { brand: "#0ea5e9" } }).html;

    assert.match(html, /<img src="https:\/\/gofitnow\.fit\/logo\.png"/);
    assert.doesNotMatch(html, /src="data:/);
  });
});

describe("o que cliente de e-mail exige", () => {
  const html = passwordReset({ ...BASE, tema: { brand: "#0ea5e9" } }).html;

  test("nenhum bloco <style> — o cliente apaga", () => {
    assert.doesNotMatch(html, /<style/i);
  });

  test("nem flex nem grid — o Outlook não implementa nenhum dos dois", () => {
    // Sairia com tudo empilhado à esquerda.
    assert.doesNotMatch(html, /display:\s*flex/i);
    assert.doesNotMatch(html, /display:\s*grid/i);
  });

  test("a logo leva `height` como ATRIBUTO, e não só no estilo", () => {
    // O Outlook ignora `style` em <img> e desenha no tamanho original — 1214 px
    // de largura estourando a caixa.
    assert.match(html, /<img[^>]*height="\d+"/);
  });

  test("o layout é de TABELA", () => {
    assert.match(html, /<table role="presentation"/);
  });
});

describe("o link", () => {
  test("é o endereço que quem chama passou, e não um fixo", () => {
    // O defeito: `APP_URL` cravado mandava todo mundo para app.gofitnow.fit, o
    // portal — que não é a casa de ninguém. Quem pede a senha em
    // marlon.gofitnow.fit tem de voltar para lá.
    const html = passwordReset({ ...BASE, tema: {} }).html;

    assert.match(html, /https:\/\/marlon\.gofitnow\.fit\/reset-password/);
    assert.doesNotMatch(html, /app\.gofitnow\.fit/);
  });

  test("aparece DUAS vezes: no botão e como texto para copiar", () => {
    // Cliente que engole o botão deixaria a pessoa sem saída.
    const html = passwordReset({ ...BASE, tema: {} }).html;
    const vezes = html.split(BASE.url).length - 1;

    assert.ok(vezes >= 2, `apareceu ${vezes} vez(es)`);
  });
});

describe("o convite de anamnese usa o mesmo desenho", () => {
  test("leva a marca da casa e o nome de QUEM está pedindo", () => {
    // Um e-mail pedindo histórico de saúde tem de dizer quem pede, senão é
    // indistinguível de golpe — e a pessoa certa é a que não vai clicar.
    const html = anamnesisInvite({
      lang: "pt-BR",
      name: "Bruna",
      professional: "Dra. Ana Souza",
      url: "https://marlon.gofitnow.fit/anamnese/tok",
      days: 7,
      tema: { brand: "#0ea5e9" },
    }).html;

    assert.match(html, /Ana Souza/);
    assert.match(html, /<img src="https:\/\/gofitnow\.fit\/logo\.png"/);
  });
});
