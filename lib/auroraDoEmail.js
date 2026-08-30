const { codificar } = require("./pngSimples.js");
const theme = require("./theme.js");

// A FAIXA DO TOPO DOS E-MAILS — a mesma aurora da entrada do app.
//
// O e-mail abria com uma tarja chapada na cor da marca. Funcionava, e era
// exatamente isso: uma tarja. A entrada do app ganhou fundo escuro com brilhos
// em 29/08/2026 e o Marlon pediu o mesmo aqui — "coloque esse fundo lá em cima
// na logo".
//
// ── Por que uma IMAGEM, e não um degradê de CSS ───────────────────────────
//
// `radial-gradient` não existe no Outlook e o Gmail descarta `background-image`
// com frequência. O fallback seria a tarja de novo, e o pedido era justamente
// tirá-la. Imagem sempre desenha.
//
// ── E por que ela é GERADA, e não um arquivo pronto ───────────────────────
//
// Porque a faixa carrega a cor de QUEM ENVIA. É a decisão que já valia no botão
// do e-mail e continua valendo: cada casa tem a sua marca, e uma mensagem que
// chega com a cor de outra pessoa denuncia que o sistema é alugado. Um PNG
// commitado seria o azul do GoFitNow na mensagem da Bruna.
//
// ── O laranja não é da casa, e é de propósito ─────────────────────────────
//
// O segundo brilho é sempre quente. Ele é o eco do símbolo da logo — o mesmo
// papel que ele faz na entrada do app — e não a cor de ninguém: se ele seguisse
// a marca, um cliente de marca laranja teria dois brilhos iguais e a faixa
// perderia a profundidade que ela existe para ter.
const LARGURA = 520;
const ALTURA = 80;

// Os últimos pontos da faixa são marinho PURO, custe o que custar — ver o
// comentário do desvanecer, em `desenhar`.
const DESVANECER = 40;

// O mesmo marinho da entrada do app (`entrada`, em gofitnow-expo/lib/theme.js).
const FUNDO = [8, 16, 37];
const QUENTE = [255, 138, 61];

// As cinco paradas da queda, iguais às do `components/Aurora.jsx` do app. Elas
// não são um degradê linear de propósito: luz cai rápido perto do centro e
// devagar na borda, e uma reta entrega um disco com aro visível.
const PARADAS = [
  [0.0, 1],
  [0.35, 0.6],
  [0.6, 0.25],
  [0.8, 0.08],
  [1.0, 0],
];

function forcaEm(t) {
  for (let i = 0; i < PARADAS.length - 1; i++) {
    const [a, fa] = PARADAS[i];
    const [b, fb] = PARADAS[i + 1];
    if (t >= a && t <= b) return fa + ((fb - fa) * (t - a)) / (b - a || 1);
  }
  return 0;
}

function canaisDe(hex) {
  const limpo = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(limpo)) return null;
  return [0, 2, 4].map((i) => parseInt(limpo.slice(i, i + 2), 16));
}

// ── A BORDA DE BAIXO TEM DE SER MARINHO PURO ──────────────────────────────
//
// A faixa termina e a linha da logo começa, e a segunda é um `bgcolor` sólido.
// Um brilho que chegue vivo ao pé da imagem cria uma emenda horizontal exatamente
// na junção — e emenda em e-mail não parece desenho, parece imagem quebrada.
//
// A primeira tentativa foi empurrar os centros para fora (`cy` negativo) e
// contar com a queda natural. Não bastou: numa faixa de menos de cem pontos, o
// que se vê de um brilho de raio 300 é uma fatia fina, que lê como degradê
// linear E ainda chega colorida embaixo. A emenda apareceu na primeira
// composição.
//
// O DESVANECER resolve as duas coisas de uma vez: a força de cada luz é
// multiplicada por uma rampa que zera nos últimos pontos. Assim os brilhos podem
// ser grandes e macios em cima — parecendo brilho — e o pé é marinho por
// construção, não por sorte de parâmetro.
//
// ── E são ELIPSES, não círculos ───────────────────────────────────────────
//
// A faixa é cinco vezes mais larga que alta. Um brilho circular nela ou vira
// bolha pequena no meio, ou é tão grande que só se vê uma fatia reta. Achatado
// (o `achatamento` divide a distância vertical), ele acompanha a forma da faixa.
function desenhar(marca) {
  // Os números saíram de quatro composições olhadas lado a lado, não de conta.
  // O que a comparação mostrou: com o brilho da marca à ESQUERDA a faixa fica
  // torta e a metade direita morre; empurrado para o meio (cx 260, metade da
  // largura) ele preenche, e o quente encosta na borda direita fundindo com ele
  // em vez de virar uma mancha separada.
  const luzes = [
    { cor: marca, raioX: 300, achatamento: 1.7, cx: 260, cy: -6, forca: 0.8 },
    { cor: QUENTE, raioX: 190, achatamento: 1.7, cx: LARGURA + 10, cy: 0, forca: 0.5 },
  ];

  const pixels = Buffer.alloc(LARGURA * ALTURA * 3);

  for (let y = 0; y < ALTURA; y++) {
    // 1 no corpo da faixa, caindo a 0 no último ponto.
    const desvanecer = y > ALTURA - DESVANECER ? (ALTURA - 1 - y) / (DESVANECER - 1) : 1;

    for (let x = 0; x < LARGURA; x++) {
      const cor = [...FUNDO];

      for (const luz of luzes) {
        const d = Math.hypot(x - luz.cx, (y - luz.cy) * luz.achatamento);
        if (d > luz.raioX) continue;

        const a = luz.forca * forcaEm(d / luz.raioX) * desvanecer;
        for (let c = 0; c < 3; c++) cor[c] += (luz.cor[c] - cor[c]) * a;
      }

      const p = (y * LARGURA + x) * 3;
      pixels[p] = cor[0];
      pixels[p + 1] = cor[1];
      pixels[p + 2] = cor[2];
    }
  }

  return codificar({ largura: LARGURA, altura: ALTURA, pixels });
}

// ── GUARDADA POR COR ──────────────────────────────────────────────────────
//
// São 37 mil pontos com duas raízes quadradas cada: ~15 ms. Nada por e-mail, e
// desperdício se for a cada e-mail — as cores são poucas e não mudam.
//
// Sem teto no tamanho de propósito: a chave é uma cor de marca, e o número de
// cores distintas é o número de clientes. Um `Map` com mil entradas de 6 kB é
// menos memória que uma foto.
const guardadas = new Map();

// Recebe o tema da casa (o mesmo objeto que o resto do e-mail usa) e devolve
// `{ conteudo, cid, filename, contentType }` — pronto para virar anexo embutido.
function faixaDoTopo(tema) {
  const t = theme.sanitize(tema);
  // O 500 da escala, e não o `brand` cru: é o tom que a marca tem quando ela
  // vira LUZ. O cru pode ser escuro demais para brilhar sobre o marinho.
  const escala = theme.scale(t.brand);
  const hex = escala[500] || t.brand;

  const canais = canaisDe(hex) || canaisDe("#0eaaf1");

  const chave = canais.join(",");
  if (!guardadas.has(chave)) guardadas.set(chave, desenhar(canais));

  return {
    conteudo: guardadas.get(chave),
    // O `cid` é fixo porque há uma faixa por mensagem. Ele não colide com as
    // fotos do documento, que usam `foto-<id>`.
    cid: "faixa-do-topo",
    filename: "topo.png",
    contentType: "image/png",
  };
}

// ── A TIRA DE MARINHO, e por que ela é uma IMAGEM ─────────────────────────
//
// A linha da logo fica logo abaixo da faixa, e o fundo dela era um `bgcolor`.
// No MODO ESCURO isso quebrou feio: o cliente de e-mail inverte as cores que o
// HTML declara — o marinho virou quase branco — mas NÃO inverte imagens. A faixa
// continuou escura e a linha da logo ficou clara colada nela, com um degrau no
// meio do cabeçalho.
//
// O `<meta name="color-scheme">` que entrou junto pede ao cliente que não
// inverta nada, e resolve no Apple Mail e no Outlook.com. O aplicativo do Gmail
// inverte assim mesmo, e para ele a única defesa é esta: o fundo da linha vira
// uma imagem de um pixel de altura, ladrilhada.
//
// Ladrilhar aqui é o caso em que ladrilhar é PERFEITO — a tira é uma cor sólida,
// então repeti-la em qualquer tamanho dá a mesma cor sólida. É o oposto da faixa
// de cima, que é justamente por ladrilhar que não pode ir como `background`.
//
// O `bgcolor` continua no HTML por baixo: com as imagens bloqueadas, é ele que
// mantém o topo escuro.
const TIRA = (() => {
  const pixels = Buffer.alloc(LARGURA * 3);
  for (let x = 0; x < LARGURA; x++) {
    pixels[x * 3] = FUNDO[0];
    pixels[x * 3 + 1] = FUNDO[1];
    pixels[x * 3 + 2] = FUNDO[2];
  }
  return codificar({ largura: LARGURA, altura: 1, pixels });
})();

function tiraDoFundo() {
  return {
    conteudo: TIRA,
    cid: "tira-do-fundo",
    filename: "fundo.png",
    contentType: "image/png",
  };
}

module.exports = { faixaDoTopo, tiraDoFundo, LARGURA, ALTURA, FUNDO, QUENTE, desenhar };
