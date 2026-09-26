const { test, describe } = require("node:test");
const assert = require("node:assert");

const notificacoes = require("../../lib/notificacoes.js");

// O QUE A PESSOA QUER RECEBER.
//
// Este arquivo é curto de propósito: o módulo é curto. O que ele segura é a
// regra que, errada, ou cala um aviso que alguém esperava ou manda um que
// alguém desligou — e as duas só aparecem em produção.

describe("o padrão é receber", () => {
  test("quem nunca abriu a tela recebe tudo", () => {
    // É todo mundo que já existe hoje. Se o padrão fosse não receber, o dia
    // em que isto subir seria o dia em que o sistema emudeceu.
    for (const chave of notificacoes.CHAVES) {
      assert.strictEqual(notificacoes.querReceber({}, chave), true, chave);
      assert.strictEqual(notificacoes.querReceber({ preferences: {} }, chave), true, chave);
    }
  });

  test("uma chave nova nasce ligada para quem já escolheu as outras", () => {
    const pessoa = { preferences: { notify: { workout: false } } };

    assert.strictEqual(notificacoes.querReceber(pessoa, "workout"), false);
    assert.strictEqual(notificacoes.querReceber(pessoa, "diet"), true);
  });

  test("destinatário que sumiu recebe — na dúvida, avisa", () => {
    // O documento pode ter sido apagado entre o evento e o envio. Perder um
    // aviso por causa disso é pior que um aviso a mais.
    assert.strictEqual(notificacoes.querReceber(null, "message"), true);
    assert.strictEqual(notificacoes.querReceber(undefined, "message"), true);
  });

  test("só um `false` gravado bloqueia", () => {
    const casos = [undefined, null, true, 1, "false", 0, ""];
    for (const valor of casos) {
      const pessoa = { preferences: { notify: { diet: valor } } };
      assert.strictEqual(notificacoes.querReceber(pessoa, "diet"), valor !== false, String(valor));
    }
  });

  test("assunto fora da lista sempre passa", () => {
    // Recuperar senha, criar conta e excluir conta não têm chave aqui, e é
    // por isso que ninguém consegue se trancar do lado de fora.
    const desligado = { preferences: { notify: { passwordReset: false } } };
    assert.strictEqual(notificacoes.querReceber(desligado, "passwordReset"), true);
  });
});

describe("a peneira do que a tela grava", () => {
  test("chave desconhecida não entra no documento do usuário", () => {
    // `preferences` é campo livre; sem esta peneira o navegador escreveria o
    // que quisesse dentro do usuário por esta porta.
    const limpo = notificacoes.limpar({ workout: false, admin: true, __proto__: {} });

    assert.deepStrictEqual(limpo, { workout: false });
  });

  test("tudo vira booleano", () => {
    const limpo = notificacoes.limpar({ diet: "não", message: 0, ticket: false });

    assert.deepStrictEqual(limpo, { diet: true, message: true, ticket: false });
  });

  test("corpo vazio não grava nada", () => {
    assert.deepStrictEqual(notificacoes.limpar({}), {});
    assert.deepStrictEqual(notificacoes.limpar(null), {});
  });
});

describe("a lista da tela", () => {
  test("vem na ordem do catálogo, com o estado de cada uma", () => {
    const pessoa = { preferences: { notify: { assessment: false } } };
    const linhas = notificacoes.paraTela(pessoa);

    assert.deepStrictEqual(
      linhas.map((l) => l.chave),
      notificacoes.CHAVES
    );
    assert.strictEqual(linhas.find((l) => l.chave === "assessment").ligada, false);
    assert.strictEqual(linhas.find((l) => l.chave === "workout").ligada, true);
  });

  test("os assuntos que o push dispara têm chave aqui", () => {
    // Um evento de push sem chave nesta lista é um aviso que a tela promete
    // poder desligar e não desliga.
    const { EVENTOS } = require("../../lib/avisar.js");
    for (const evento of Object.keys(EVENTOS)) {
      assert.ok(notificacoes.existe(evento), `falta a chave "${evento}"`);
    }
  });
});
