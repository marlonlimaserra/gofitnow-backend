const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert");

const { verificar } = require("../../lib/captcha.js");
const tentativas = require("../../lib/tentativasDeLogin.js");

// O DESAFIO ANTI-ROBÔ.
//
// Duas coisas se testam aqui, e as duas são decisões de segurança que não dão
// erro quando estão erradas — elas simplesmente deixam passar.

describe("a contagem de senha errada", () => {
  beforeEach(() => tentativas.reset());

  test("conta por e-mail E por ip — basta uma estourar", async () => {
    // Um atacante varrendo MUITAS contas do mesmo lugar não faz a contagem de
    // e-mail nenhum subir. Sem a chave de IP, ele passaria batido.
    for (let i = 0; i < 5; i++) {
      tentativas.registrarFalha(tentativas.chavesDe(`vitima${i}@x.com`, "9.9.9.9"));
    }

    // Nenhum e-mail tem mais de uma falha…
    assert.strictEqual(await tentativas.contarFalhas(tentativas.chavesDe("vitima0@x.com", null)), 1);
    // …mas o IP tem cinco.
    assert.strictEqual(await tentativas.contarFalhas(tentativas.chavesDe(null, "9.9.9.9")), 5);
  });

  test("o e-mail é normalizado — trocar a caixa não zera o contador", async () => {
    tentativas.registrarFalha(tentativas.chavesDe("Alguem@Exemplo.com", null));
    tentativas.registrarFalha(tentativas.chavesDe("  alguem@exemplo.com  ", null));

    assert.strictEqual(await tentativas.contarFalhas(tentativas.chavesDe("ALGUEM@EXEMPLO.COM", null)), 2);
  });

  test("entrar zera a contagem", async () => {
    const chaves = tentativas.chavesDe("a@b.com", "1.1.1.1");
    tentativas.registrarFalha(chaves);
    tentativas.registrarFalha(chaves);
    assert.strictEqual(await tentativas.contarFalhas(chaves), 2);

    tentativas.limparFalhas(chaves);
    assert.strictEqual(await tentativas.contarFalhas(chaves), 0);
  });

  test("a falha de uma conta não faz a outra pedir desafio", async () => {
    tentativas.registrarFalha(tentativas.chavesDe("a@b.com", null));
    tentativas.registrarFalha(tentativas.chavesDe("a@b.com", null));
    tentativas.registrarFalha(tentativas.chavesDe("a@b.com", null));

    assert.strictEqual(await tentativas.contarFalhas(tentativas.chavesDe("outro@b.com", null)), 0);
  });

  test("sem e-mail e sem ip não há chave — e a contagem é zero, não NaN", async () => {
    assert.deepStrictEqual(tentativas.chavesDe("", null), []);
    assert.strictEqual(await tentativas.contarFalhas([]), 0);
  });
});

describe("a verificação do token", () => {
  const OK = async () => ({ json: async () => ({ success: true }) });

  test("sem chave secreta, recusa sem chamar a Cloudflare", async () => {
    let chamou = false;
    const r = await verificar({ secretKey: "", token: "t" }, async () => { chamou = true; });

    assert.deepStrictEqual(r, { ok: false, erro: "sem_chave" });
    assert.strictEqual(chamou, false);
  });

  test("sem token, recusa com código próprio — é a primeira vez, não um erro", async () => {
    // A tela reage a `sem_token` mostrando o widget. Confundi-lo com token
    // inválido faria a tela dizer "verificação falhou" para quem nunca viu o
    // desafio.
    const r = await verificar({ secretKey: "s", token: "" }, OK);
    assert.strictEqual(r.erro, "sem_token");
  });

  test("o segredo vai no CORPO, e o token junto", async () => {
    let corpo = null;
    await verificar({ secretKey: "seg-redo", token: "tok", ip: "1.2.3.4" }, async (u, o) => {
      corpo = new URLSearchParams(o.body);
      return { json: async () => ({ success: true }) };
    });

    assert.strictEqual(corpo.get("secret"), "seg-redo");
    assert.strictEqual(corpo.get("response"), "tok");
    assert.strictEqual(corpo.get("remoteip"), "1.2.3.4");
  });

  test("sem ip conhecido, o campo não é enviado — ip errado é pior que nenhum", async () => {
    let corpo = null;
    await verificar({ secretKey: "s", token: "t" }, async (u, o) => {
      corpo = new URLSearchParams(o.body);
      return { json: async () => ({ success: true }) };
    });

    assert.strictEqual(corpo.has("remoteip"), false);
  });

  test("success verdadeiro passa", async () => {
    assert.deepStrictEqual(await verificar({ secretKey: "s", token: "t" }, OK), { ok: true });
  });

  test("success falso recusa, com os códigos da Cloudflare no motivo", async () => {
    const r = await verificar({ secretKey: "s", token: "t" }, async () => ({
      json: async () => ({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    }));

    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /timeout-or-duplicate/);
  });

  test("Cloudflare fora do ar FECHA a porta, e não abre", async () => {
    // O oposto do contador de tentativas, e de propósito. Chegou-se aqui porque
    // a senha já errou várias vezes; deixar passar por indisponibilidade dela
    // transformaria a queda da Cloudflare na porta aberta que o desafio fecha.
    const r = await verificar({ secretKey: "s", token: "t" }, async () => {
      throw new Error("network down");
    });

    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /indisponivel/);
  });

  test("resposta sem JSON não vira exceção", async () => {
    const r = await verificar({ secretKey: "s", token: "t" }, async () => ({
      json: async () => {
        throw new Error("não é json");
      },
    }));

    assert.strictEqual(r.ok, false);
  });
});
