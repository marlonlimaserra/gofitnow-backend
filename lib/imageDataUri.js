// Leitura de "data:<mime>;base64,AAAA…" → { mime, buffer }, ou undefined.
//
// Num lugar só porque quatro coisas sobem arquivo — avatar, marca, foto de
// evolução e anexo de conversa — e a parte que importa aqui é a que RECUSA.
// Duas cópias da lista de tipos aceitos viram, com o tempo, duas listas
// diferentes, e a que ficar para trás é uma porta aberta.
//
// O que muda entre elas é o teto de tamanho e QUAIS tipos passam: um avatar de
// 512 px e um áudio de dois minutos não têm por que caber na mesma regra.

// O que o navegador exibe sem plugin. SVG fica de fora: é um documento
// executável, não uma imagem, e serviria script na nossa origem.
const MIMES = ["image/jpeg", "image/png", "image/webp"];

// A leitura do cabeçalho do data URI.
//
// O mime pode vir com PARÂMETRO — o gravador de áudio do navegador produz
// `audio/webm;codecs=opus`. Uma expressão que exigisse só letras e barra não
// casaria com ele, e o áudio seria recusado por um motivo que não é o
// verdadeiro. Aqui o cabeçalho é cortado no `;base64,` e o que sobra tem os
// parâmetros descartados.
function parseDataUri(dataUri, { maxBytes, mimes }) {
  const texto = String(dataUri || "").trim();

  const marca = ";base64,";
  const corte = texto.indexOf(marca);
  if (corte < 0 || !texto.startsWith("data:")) return undefined;

  const cabecalho = texto.slice("data:".length, corte);
  const mime = cabecalho.split(";")[0].trim().toLowerCase();
  if (!mime) return undefined;

  // ── SEM LISTA, QUALQUER TIPO PASSA ──────────────────────────────────────
  //
  // *"quero poder pôr qualquer arquivo, tentei colocar mp3 e não consegui"*.
  //
  // Quem chama sem `mimes` está dizendo que aceita tudo — hoje só os anexos de
  // funcionário. A proteção deles não é na ENTRADA: nenhum arquivo é perigoso
  // guardado, e sim servido. Quem serve decide o que sai `inline` e o que vira
  // download (ver `controllers/Employee.js`).
  //
  // Antes isto estourava com "mimes is not iterable" em vez de aceitar — um
  // parâmetro obrigatório disfarçado de opcional.
  if (mimes && !mimes.includes(mime)) return undefined;

  const buffer = Buffer.from(texto.slice(corte + marca.length), "base64");
  if (buffer.length === 0 || buffer.length > maxBytes) return undefined;

  return { mime, buffer };
}

function parseImageDataUri(dataUri, maxBytes) {
  return parseDataUri(dataUri, { maxBytes, mimes: MIMES });
}

module.exports = { MIMES, parseDataUri, parseImageDataUri };
