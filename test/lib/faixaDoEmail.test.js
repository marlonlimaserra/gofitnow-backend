const test = require("node:test");
const assert = require("node:assert/strict");

const { faixaDoTopo, desenhar, ALTURA, LARGURA, FUNDO } = require("../../lib/auroraDoEmail.js");
const { codificar } = require("../../lib/pngSimples.js");
const { passwordReset, anamnesisInvite } = require("../../lib/emailTemplates.js");

// A FAIXA DO TOPO DO E-MAIL — o fundo escuro com brilhos, igual ao da entrada
// do app.
//
// Ela é DESENHADA aqui dentro, por dois motivos que os testes seguram:
//
//   1. um PNG pronto no repositório seria a cor do GoFitNow na mensagem da
//      Bruna, e a decisão de que cada casa manda na própria marca já valia no
//      botão;
//   2. `radial-gradient` não existe no Outlook e o Gmail descarta
//      `background-image` — e o fallback seria a tarja chapada que ela veio
//      substituir.

// Os bytes de um PNG começam sempre pelos mesmos oito.
const ASSINATURA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("o que sai é um PNG de verdade", () => {
  const f = faixaDoTopo({ brand: "#0ea5e9" });

  assert.ok(Buffer.isBuffer(f.conteudo));
  assert.deepEqual(f.conteudo.subarray(0, 8), ASSINATURA);
  // IHDR é sempre o primeiro pedaço, e as medidas moram nele.
  assert.equal(f.conteudo.readUInt32BE(16), LARGURA);
  assert.equal(f.conteudo.readUInt32BE(20), ALTURA);
});

test("A ÚLTIMA LINHA é marinho puro — é ela que esconde a emenda", () => {
  // A faixa é uma imagem e a linha da logo, logo abaixo, é um `bgcolor` sólido.
  // Um brilho que chegue vivo ao pé cria um risco horizontal na junção, e risco
  // em e-mail não parece desenho: parece imagem quebrada. Eu vi isso na primeira
  // composição, antes de existir o desvanecer.
  //
  // Redesenhado com o mesmo caminho, e conferido no buffer CRU (antes do PNG).
  const cru = pixelsCrus([14, 165, 233]);

  for (let x = 0; x < LARGURA; x++) {
    const p = ((ALTURA - 1) * LARGURA + x) * 3;
    assert.deepEqual(
      [cru[p], cru[p + 1], cru[p + 2]],
      FUNDO,
      `a última linha vazou cor em x=${x}`
    );
  }
});

test("e o TOPO não é marinho — senão não há brilho nenhum", () => {
  // O contrário do teste acima: o desvanecer poderia zerar tudo e passar.
  const cru = pixelsCrus([14, 165, 233]);
  const meio = (0 * LARGURA + Math.floor(LARGURA / 2)) * 3;

  assert.notDeepEqual([cru[meio], cru[meio + 1], cru[meio + 2]], FUNDO);
});

// Redesenha e devolve os pixels crus, sem passar pelo PNG. Espelha `desenhar`
// pelo resultado: se ele mudar de forma, este helper quebra junto — que é o que
// se quer.
function pixelsCrus(marca) {
  const png = desenhar(marca);
  assert.ok(png.length > 0);
  // O buffer cru não sai de `desenhar`, então o teste refaz a conta pelo mesmo
  // caminho público que o módulo expõe: comparar o PNG de duas cores.
  return require("node:zlib")
    .inflateSync(pedacoIDAT(png))
    .filter((_, i) => i % (LARGURA * 3 + 1) !== 0);
}

// Extrai os dados de IDAT, pulando os cabeçalhos de pedaço.
function pedacoIDAT(png) {
  let i = 8;
  const partes = [];
  while (i < png.length) {
    const tamanho = png.readUInt32BE(i);
    const nome = png.toString("ascii", i + 4, i + 8);
    if (nome === "IDAT") partes.push(png.subarray(i + 8, i + 8 + tamanho));
    if (nome === "IEND") break;
    i += 12 + tamanho;
  }
  return Buffer.concat(partes);
}

test("a cor da faixa segue a MARCA de quem envia", () => {
  // O ponto inteiro de ela ser gerada. Duas casas, duas faixas.
  const azul = faixaDoTopo({ brand: "#0ea5e9" }).conteudo;
  const verde = faixaDoTopo({ brand: "#1ebd59" }).conteudo;

  assert.notEqual(azul.toString("base64"), verde.toString("base64"));
});

test("a mesma cor sai da memória, e não é redesenhada", () => {
  const a = faixaDoTopo({ brand: "#0ea5e9" }).conteudo;
  const b = faixaDoTopo({ brand: "#0ea5e9" }).conteudo;

  // Mesmo objeto: é o `Map` respondendo.
  assert.equal(a, b);
});

test("marca inválida não derruba o e-mail", () => {
  // Tema corrompido no banco não pode virar 500 num pedido de senha nova.
  for (const ruim of [{}, { brand: "" }, { brand: "não é cor" }, null, undefined]) {
    const f = faixaDoTopo(ruim);
    assert.ok(Buffer.isBuffer(f.conteudo), `quebrou com ${JSON.stringify(ruim)}`);
  }
});

test("o e-mail leva a faixa como anexo EMBUTIDO, e o HTML aponta para ela", () => {
  // `data:` URI não serve: o Gmail descarta. É a mesma lição das fotos do
  // documento.
  const mail = passwordReset({ lang: "pt-BR", name: "Ana", url: "https://x.fit/a", minutes: 30 });

  // Duas: a faixa do topo e a tira de marinho do fundo da linha da logo.
  assert.equal(mail.attachments.length, 2);

  for (const anexo of mail.attachments) {
    assert.equal(anexo.contentType, "image/png");
    assert.ok(anexo.cid);
    assert.ok(mail.html.includes(`cid:${anexo.cid}`), `${anexo.cid} não é usado no HTML`);
  }
  assert.ok(!mail.html.includes("src=\"data:"));
});

test("o convite de anamnese ganhou a mesma faixa", () => {
  // Os dois passam pelo mesmo `build`. Se um dia só um levar a faixa, é porque
  // alguém duplicou a montagem.
  const mail = anamnesisInvite({ lang: "pt-BR", name: "Ana", professional: "Bruna", url: "https://x.fit/a", days: 7 });

  assert.equal(mail.attachments.length, 2);
  assert.ok(mail.html.includes("cid:"));
});

test("com as imagens bloqueadas, o topo continua ESCURO", () => {
  // É o padrão do Outlook e de muita conta de Gmail. Sem o `bgcolor`, o topo
  // vira um retângulo branco e a mensagem parece quebrada.
  const mail = passwordReset({ lang: "pt-BR", name: "Ana", url: "https://x.fit/a", minutes: 30 });

  // Os COMENTÁRIOS saem antes. O que explica o topo menciona "logo" e "cid", e
  // sem tirá-los o teste passava a conferir o meu texto em vez da marcação —
  // foi o que ele fez na primeira vez que rodou.
  const marcacao = mail.html.replace(/<!--[\s\S]*?-->/g, "");

  const doTopo = marcacao.split("<tr>").filter((l) => l.includes("cid:") || l.includes("<img src=\"https"));
  assert.equal(doTopo.length, 2, "o topo são duas linhas: a faixa e a logo");

  for (const linha of doTopo) {
    assert.ok(linha.includes('bgcolor="#081025"'), "linha do topo sem bgcolor de segurança");
  }
});

test("a mensagem DIZ que cuida das próprias cores", () => {
  // Sem isto o cliente de e-mail assume que a mensagem só sabe viver no claro e
  // inverte tudo sozinho. O estrago aparecia no topo: a faixa é imagem e não se
  // inverte, mas o marinho da linha da logo virava quase branco — um degrau no
  // meio do cabeçalho, que foi o que o Marlon viu.
  const mail = passwordReset({ lang: "pt-BR", name: "Ana", url: "https://x.fit/a", minutes: 30 });

  assert.ok(mail.html.includes('name="color-scheme" content="light dark"'));
  assert.ok(mail.html.includes('name="supported-color-schemes" content="light dark"'));
  // Sem bloco <style>: o projeto não usa nenhum, porque cliente de e-mail os
  // apaga — e há um teste em `emailTemplates.test.js` que reprova o primeiro que
  // aparecer. As metas carregam o mesmo recado.
  assert.doesNotMatch(mail.html, /<style/i);
});

test("o fundo escuro do topo também vai como IMAGEM", () => {
  // O aplicativo do Gmail inverte cor declarada mesmo com o `color-scheme`
  // acima. O que ele NÃO inverte é imagem — daí a tira de um pixel, ladrilhada.
  // O `bgcolor` fica por baixo para quem bloqueia imagem.
  const mail = passwordReset({ lang: "pt-BR", name: "Ana", url: "https://x.fit/a", minutes: 30 });
  const marcacao = mail.html.replace(/<!--[\s\S]*?-->/g, "");

  const doTopo = marcacao
    .split("<tr>")
    .filter((l) => l.includes("faixa-do-topo") || l.includes('<img src="https'));

  assert.equal(doTopo.length, 2);
  for (const linha of doTopo) {
    assert.ok(linha.includes('background="cid:tira-do-fundo"'), "linha do topo sem a tira");
    assert.ok(linha.includes('bgcolor="#081025"'), "e sem o bgcolor por baixo dela");
  }
});

test("a tira é sólida e minúscula — ladrilhar uma cor dá a mesma cor", () => {
  const { tiraDoFundo } = require("../../lib/auroraDoEmail.js");
  const t = tiraDoFundo();

  // Um pixel de altura: é o que faz o ladrilho vertical ser exato em qualquer
  // altura de linha.
  assert.equal(t.conteudo.readUInt32BE(20), 1);
  assert.ok(t.conteudo.length < 500, "a tira engordou; ela é uma cor sólida");
});

test("o PNG recusa buffer do tamanho errado", () => {
  // O codificador é meu, então ele tem de reclamar em vez de escrever um arquivo
  // corrompido que só falha no cliente de e-mail de alguém.
  assert.throws(
    () => codificar({ largura: 2, altura: 2, pixels: Buffer.alloc(3) }),
    /esperava 12 bytes/
  );
});
