const zlib = require("node:zlib");

// UM CODIFICADOR DE PNG, do tamanho do problema.
//
// ── Por que escrever isto em vez de instalar `sharp` ──────────────────────
//
// O que este servidor precisa desenhar é UMA coisa: a faixa de fundo do topo dos
// e-mails, que é um retângulo escuro com dois brilhos radiais. Sem foto, sem
// recorte, sem redimensionar, sem texto.
//
// `sharp` custa ~30 MB de binário nativo por plataforma e é a dependência que
// mais quebra em atualização de Node — e ela existiria aqui para preencher
// pixels que este arquivo preenche em quarenta linhas. O `zlib` que o PNG pede
// já vem no Node.
//
// ── O formato, em três parágrafos ─────────────────────────────────────────
//
// Um PNG é uma assinatura de 8 bytes seguida de PEDAÇOS. Cada pedaço é
// [tamanho][nome de 4 letras][dados][CRC-32 do nome+dados]. Só três importam
// aqui: IHDR (as medidas), IDAT (os bytes) e IEND (acabou).
//
// Os bytes de IDAT são as linhas da imagem, cada uma precedida por um byte de
// FILTRO. Filtro 0 é "sem filtro" — os outros quatro existem para o compressor
// achar padrão em foto, e num degradê liso o `deflate` já resolve sozinho.
//
// Tudo em big-endian, que é o do formato, e não o da máquina.

const ASSINATURA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A tabela do CRC-32, montada uma vez. `zlib.crc32` só existe a partir do Node
// 20.15, e este arquivo não vale uma exigência de versão.
const TABELA_CRC = (() => {
  const tabela = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c;
  }
  return tabela;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pedaco(nome, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length, 0);

  const corpo = Buffer.concat([Buffer.from(nome, "ascii"), dados]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);

  return Buffer.concat([tamanho, corpo, crc]);
}

// `pixels` é RGB cru: três bytes por ponto, linha por linha, sem separador.
// Devolve o PNG inteiro em Buffer.
function codificar({ largura, altura, pixels }) {
  const esperado = largura * altura * 3;
  if (!Buffer.isBuffer(pixels) || pixels.length !== esperado) {
    throw new Error(`pngSimples: esperava ${esperado} bytes de RGB, recebi ${pixels?.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // cor verdadeira (RGB), sem canal alfa
  ihdr[10] = 0; // compressão: deflate, a única que o formato tem
  ihdr[11] = 0; // filtro: o conjunto padrão
  ihdr[12] = 0; // sem entrelaçamento

  // As linhas com o byte de filtro na frente de cada uma.
  const comFiltro = Buffer.alloc(altura * (largura * 3 + 1));
  for (let y = 0; y < altura; y++) {
    const destino = y * (largura * 3 + 1);
    comFiltro[destino] = 0;
    pixels.copy(comFiltro, destino + 1, y * largura * 3, (y + 1) * largura * 3);
  }

  return Buffer.concat([
    ASSINATURA,
    pedaco("IHDR", ihdr),
    // Nível 9: a imagem é gerada uma vez e guardada em memória, então o tempo de
    // compressão é pago uma vez e o tamanho é pago em toda mensagem enviada.
    pedaco("IDAT", zlib.deflateSync(comFiltro, { level: 9 })),
    pedaco("IEND", Buffer.alloc(0)),
  ]);
}

module.exports = { codificar, crc32 };
