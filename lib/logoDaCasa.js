const fs = require("node:fs");
const path = require("node:path");

// A LOGO QUE VAI NO DOCUMENTO — a da casa, ou a nossa.
//
// Pedido do Marlon: *"coloca a nossa logo também, no e-mail, no PDF etc… precisamos
// divulgar a marca né, se a instância personalizar a logo, aí envia a logo da
// instância"*.
//
// ── Por que ela precisa ser EMBUTIDA ──────────────────────────────────────
//
// O documento é autossuficiente por construção, e o conversor de PDF
// (`lib/pdf.js`) BLOQUEIA toda requisição de rede — de propósito, para o servidor
// não virar um buscador de URLs a mando do conteúdo da página. Uma logo por
// endereço remoto sairia como quadrado vazio no PDF.
//
// Então tudo vira `data:` URI antes de entrar no HTML.

const NOSSA = path.join(__dirname, "..", "assets", "logo.png");

// Tetos de quem busca coisa de fora.
const TEMPO_LIMITE_MS = 5000;
const TAMANHO_MAXIMO = 512 * 1024;

// A nossa, lida do disco uma vez. Sem rede: ela é parte do deploy, e um
// documento não pode depender do site estar no ar para ter cabeçalho.
let nossaEmCache = null;

function nossaLogo() {
  if (nossaEmCache !== null) return nossaEmCache;

  try {
    nossaEmCache = "data:image/png;base64," + fs.readFileSync(NOSSA).toString("base64");
  } catch (erro) {
    // Deploy sem o arquivo: o documento sai sem cabeçalho de marca, que é feio
    // mas inteiro. Melhor que quebrar a geração.
    console.error("[logo] não achei assets/logo.png:", erro.message);
    nossaEmCache = "";
  }

  return nossaEmCache;
}

// A da casa, buscada e guardada por endereço.
const cacheDaCasa = new Map();

// ── BUSCAR URL QUE O CLIENTE ESCOLHEU É UM PEDIDO DELE AO NOSSO SERVIDOR ──
//
// É pouco, mas é real: quem configura o tema decide um endereço que ESTA máquina
// vai abrir. Por isso o mínimo — só http(s), com prazo e teto de tamanho, e
// qualquer tropeço cai na nossa logo em vez de derrubar o documento.
//
// O que NÃO é problema aqui: a resposta nunca volta para quem pediu o documento
// como texto — ela só vira imagem no cabeçalho. Uma URL interna respondendo JSON
// produz um `<img>` quebrado, não um vazamento.
async function daCasa(url) {
  if (cacheDaCasa.has(url)) return cacheDaCasa.get(url);

  const promessa = (async () => {
    try {
      const resposta = await fetch(url, { signal: AbortSignal.timeout(TEMPO_LIMITE_MS) });
      if (!resposta.ok) return "";

      const tipo = resposta.headers.get("content-type") || "";
      if (!tipo.startsWith("image/")) return "";

      const bytes = Buffer.from(await resposta.arrayBuffer());
      if (bytes.length > TAMANHO_MAXIMO) return "";

      return `data:${tipo.split(";")[0]};base64,${bytes.toString("base64")}`;
    } catch (erro) {
      console.error("[logo] não consegui buscar a da casa:", erro.message);
      return "";
    }
  })();

  cacheDaCasa.set(url, promessa);
  return promessa;
}

// A logo do documento: a da casa quando ela tem uma, a nossa quando não.
//
// A ordem é essa e não a inversa: quem paga por marca própria não quer a nossa
// no papel que entrega ao cliente dele. E quem não personalizou fica com a nossa,
// que é onde a divulgação acontece.
async function logoDaCasa(tema) {
  const url = String(tema?.logo || "").trim();

  if (/^https?:\/\//i.test(url)) {
    const dela = await daCasa(url);
    if (dela) return dela;
  }

  return nossaLogo();
}

function limparCache() {
  cacheDaCasa.clear();
  nossaEmCache = null;
}

module.exports = { logoDaCasa, nossaLogo, limparCache, TAMANHO_MAXIMO };
