const test = require("node:test");
const assert = require("node:assert");

const { enviarPelaResend, remetente } = require("../../lib/resend.js");

// O ENVIO PELA RESEND.
//
// Testado com um `fetch` de mentira, injetado. É o que permite conferir o que sai
// pela rede — que é a única coisa que importa aqui — sem chave, sem rede e sem
// mandar e-mail para ninguém.
function fetchFalso(resposta, registro = {}) {
  return async (url, opcoes) => {
    registro.url = url;
    registro.opcoes = opcoes;
    registro.corpo = JSON.parse(opcoes.body);
    return {
      ok: resposta.ok !== false,
      status: resposta.status || 200,
      json: async () => resposta.json ?? { id: "re_123" },
    };
  };
}

const BASE = { apiKey: "re_teste", from: "nao-responda@gofitnow.fit", to: "pessoa@exemplo.com", subject: "Oi" };

test("o remetente vai como 'Nome <endereço>', e só o endereço quando não há nome", () => {
  assert.strictEqual(remetente("a@b.c", "GoFitNow"), "GoFitNow <a@b.c>");
  assert.strictEqual(remetente("a@b.c", ""), "a@b.c");
  assert.strictEqual(remetente("a@b.c", "  "), "a@b.c");
});

test("sem remetente configurado, recusa ANTES de chamar a rede", async () => {
  let chamou = false;
  await assert.rejects(
    () => enviarPelaResend({ ...BASE, from: "" }, async () => { chamou = true; }),
    /remetente/
  );
  // Importa que nem tente: uma chamada sem `from` gasta cota e volta com um erro
  // que não explica que o problema era configuração nossa.
  assert.strictEqual(chamou, false);
});

test("a chave vai no cabeçalho, nunca no corpo", async () => {
  const reg = {};
  await enviarPelaResend({ ...BASE, html: "<p>oi</p>" }, fetchFalso({}, reg));

  assert.strictEqual(reg.opcoes.headers.Authorization, "Bearer re_teste");
  assert.ok(!JSON.stringify(reg.corpo).includes("re_teste"));
});

test("o destinatário vai sempre como lista — a API não aceita texto solto", async () => {
  const reg = {};
  await enviarPelaResend({ ...BASE, html: "x" }, fetchFalso({}, reg));
  assert.deepStrictEqual(reg.corpo.to, ["pessoa@exemplo.com"]);

  await enviarPelaResend({ ...BASE, to: ["a@b.c", "d@e.f"], html: "x" }, fetchFalso({}, reg));
  assert.deepStrictEqual(reg.corpo.to, ["a@b.c", "d@e.f"]);
});

test("o anexo em Buffer vira base64 — JSON não carrega byte cru", async () => {
  const reg = {};
  const pdf = Buffer.from("%PDF-1.4 fingido");

  await enviarPelaResend(
    { ...BASE, html: "x", attachments: [{ filename: "avaliacao.pdf", content: pdf }] },
    fetchFalso({}, reg)
  );

  const anexo = reg.corpo.attachments[0];
  assert.strictEqual(anexo.filename, "avaliacao.pdf");
  // E volta a ser exatamente o mesmo byte a byte: um anexo corrompido não dá
  // erro nenhum, chega como arquivo que não abre.
  assert.strictEqual(Buffer.from(anexo.content, "base64").toString(), "%PDF-1.4 fingido");
});

test("campo vazio não é enviado — html sem texto não manda `text: undefined`", async () => {
  const reg = {};
  await enviarPelaResend({ ...BASE, html: "<p>oi</p>" }, fetchFalso({}, reg));

  assert.ok("html" in reg.corpo);
  assert.ok(!("text" in reg.corpo));
  assert.ok(!("attachments" in reg.corpo));
});

test("erro da API sobe com a MENSAGEM deles, não com um genérico", async () => {
  // O caso real mais comum: domínio não verificado. A resposta explica, e é essa
  // explicação que precisa chegar a quem configurou.
  const resposta = {
    ok: false,
    status: 403,
    json: { message: "The gofitnow.fit domain is not verified", name: "validation_error" },
  };

  await assert.rejects(
    () => enviarPelaResend({ ...BASE, html: "x" }, fetchFalso(resposta)),
    (erro) => {
      assert.match(erro.message, /domain is not verified/);
      assert.strictEqual(erro.status, 403);
      return true;
    }
  );
});

test("resposta ruim sem JSON não vira 'não consigo ler a resposta'", async () => {
  const quebrado = async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new Error("Unexpected token < in JSON");
    },
  });

  await assert.rejects(() => enviarPelaResend({ ...BASE, html: "x" }, quebrado), /HTTP 502/);
});

test("o id devolvido pela API volta como messageId", async () => {
  const r = await enviarPelaResend({ ...BASE, html: "x" }, fetchFalso({ json: { id: "re_abc" } }));
  assert.strictEqual(r.messageId, "re_abc");
});

// ── A IMAGEM NO CORPO DO E-MAIL (29/08/2026) ──────────────────────────────
//
// Relato do Marlon: *"o PDF chegou perfeito, mas as imagens no próprio e-mail,
// não"*. É o Gmail: ele DESCARTA `<img src="data:…">`. Não é defeito nosso, é
// política dele, e nenhum ajuste de HTML contorna.
//
// O que funciona é o anexo EMBUTIDO: a foto viaja como anexo com um
// `Content-ID`, e o corpo a referencia por `cid:`. Isso cumpre os dois papéis de
// uma vez — ela aparece no corpo E na lista de anexos.
test("o `cid` vira `content_id` — é o nome que a Resend usa", async () => {
  const reg = {};
  await enviarPelaResend(
    {
      ...BASE,
      html: '<img src="cid:foto-front">',
      attachments: [
        { filename: "front.jpg", content: Buffer.from("bytes"), cid: "foto-front", contentType: "image/jpeg" },
      ],
    },
    fetchFalso({}, reg)
  );

  const anexo = reg.corpo.attachments[0];
  assert.strictEqual(anexo.content_id, "foto-front");
  assert.strictEqual(anexo.content_type, "image/jpeg");
});

test("anexo SEM cid não ganha content_id — o PDF é anexo comum", async () => {
  const reg = {};
  await enviarPelaResend(
    { ...BASE, html: "x", attachments: [{ filename: "a.pdf", content: Buffer.from("%PDF") }] },
    fetchFalso({}, reg)
  );

  assert.ok(!("content_id" in reg.corpo.attachments[0]));
});

test("o corpo referencia a MESMA chave que o anexo declara", async () => {
  // Se as duas divergirem, o e-mail chega com um quadrado quebrado no lugar da
  // foto — e nada avisa, porque o envio dá certo.
  const reg = {};
  await enviarPelaResend(
    {
      ...BASE,
      html: '<img src="cid:foto-back">',
      attachments: [{ filename: "back.jpg", content: Buffer.from("x"), cid: "foto-back" }],
    },
    fetchFalso({}, reg)
  );

  const usadas = [...reg.corpo.html.matchAll(/cid:([\w-]+)/g)].map((m) => m[1]);
  const declaradas = reg.corpo.attachments.map((a) => a.content_id).filter(Boolean);

  for (const u of usadas) assert.ok(declaradas.includes(u), `o corpo usa ${u}, que ninguém declarou`);
});
