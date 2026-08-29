const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert");

const { logoDaCasa, nossaLogo, limparCache, TAMANHO_MAXIMO } = require("../../lib/logoDaCasa.js");

// A LOGO DO DOCUMENTO.
//
// Pedido do Marlon: *"coloca a nossa logo também, no e-mail, no PDF etc… se a
// instância personalizar a logo, aí envia a logo da instância"*.
//
// Ela precisa ser EMBUTIDA: o conversor de PDF bloqueia toda requisição de rede,
// de propósito, então uma logo por endereço remoto sairia como quadrado vazio.

const original = global.fetch;

function fetchFalso(resposta) {
  return async () => resposta;
}

function respostaDeImagem(bytes, tipo = "image/png") {
  return {
    ok: true,
    headers: { get: (k) => (k === "content-type" ? tipo : null) },
    arrayBuffer: async () => bytes,
  };
}

beforeEach(() => {
  limparCache();
  global.fetch = original;
});

describe("a nossa logo", () => {
  test("é lida do disco, sem rede", () => {
    // Ela é parte do deploy: um documento não pode depender de o site estar no
    // ar para ter cabeçalho.
    const l = nossaLogo();

    assert.match(l, /^data:image\/png;base64,/);
    assert.ok(l.length > 1000);
  });

  test("entra quando a casa não tem logo", async () => {
    for (const tema of [undefined, null, {}, { logo: "" }, { logo: "   " }]) {
      assert.strictEqual(await logoDaCasa(tema), nossaLogo());
    }
  });
});

describe("a logo da casa", () => {
  test("vence a nossa", async () => {
    // Quem paga por marca própria não quer a nossa no papel que entrega ao
    // cliente dele.
    global.fetch = fetchFalso(respostaDeImagem(Buffer.from("PNGFALSO")));

    const l = await logoDaCasa({ logo: "https://cliente.com/logo.png" });

    assert.match(l, /^data:image\/png;base64,/);
    assert.notStrictEqual(l, nossaLogo());
  });

  test("endereço que não é http(s) é IGNORADO", async () => {
    // `file:///etc/passwd` e `data:` não podem virar um pedido desta máquina.
    let chamou = false;
    global.fetch = async () => {
      chamou = true;
    };

    for (const url of ["file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "ftp://x/y"]) {
      assert.strictEqual(await logoDaCasa({ logo: url }), nossaLogo());
    }
    assert.strictEqual(chamou, false);
  });

  test("resposta que NÃO é imagem cai na nossa", async () => {
    // Um endereço que responde JSON produziria um `<img>` quebrado no cabeçalho.
    global.fetch = fetchFalso({
      ok: true,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => Buffer.from("{}"),
    });

    assert.strictEqual(await logoDaCasa({ logo: "https://cliente.com/nao-e-imagem" }), nossaLogo());
  });

  test("imagem grande demais cai na nossa", async () => {
    // Sem teto, uma logo de 40 MB entraria em todo PDF e em todo e-mail.
    global.fetch = fetchFalso(respostaDeImagem(Buffer.alloc(TAMANHO_MAXIMO + 1)));

    assert.strictEqual(await logoDaCasa({ logo: "https://cliente.com/enorme.png" }), nossaLogo());
  });

  test("erro de rede cai na nossa, e não derruba o documento", async () => {
    global.fetch = async () => {
      throw new Error("timeout");
    };

    assert.strictEqual(await logoDaCasa({ logo: "https://cliente.com/logo.png" }), nossaLogo());
  });

  test("404 cai na nossa", async () => {
    global.fetch = fetchFalso({ ok: false, headers: { get: () => null } });

    assert.strictEqual(await logoDaCasa({ logo: "https://cliente.com/sumiu.png" }), nossaLogo());
  });

  test("é buscada UMA vez por endereço", async () => {
    // Ela entra em todo documento gerado. Sem cache, cada PDF custaria uma ida à
    // rede para buscar a mesma imagem.
    let vezes = 0;
    global.fetch = async () => {
      vezes++;
      return respostaDeImagem(Buffer.from("PNGFALSO"));
    };

    await logoDaCasa({ logo: "https://cliente.com/logo.png" });
    await logoDaCasa({ logo: "https://cliente.com/logo.png" });
    await logoDaCasa({ logo: "https://cliente.com/logo.png" });

    assert.strictEqual(vezes, 1);
  });
});
