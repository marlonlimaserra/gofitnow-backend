// BUSCAR UM ÍCONE NA ICONIFY, e guardá-lo aqui.
//
// Pedido do Marlon em 18/09/2026: *"parece que os icones estão fixos... tinha
// alguma biblioteca de icones que pesquisava na internet"*. A biblioteca é a
// Iconify: ~200 mil ícones, de 150 conjuntos, com API pública.
//
// ── A BUSCA É NA INTERNET; O DESENHO, NÃO ────────────────────────────────
//
// O caminho óbvio seria o componente da Iconify, que baixa o SVG na hora de
// desenhar. Ele não serve aqui, e o motivo é a VITRINE: ela abre dentro do site
// do cliente, e um ícone que só aparece se um terceiro responder é um buraco no
// cartão de venda dele — quando aquele servidor estiver lento, fora do ar ou
// bloqueado pela rede da empresa que abriu a página.
//
// Então o desenho é nosso: na hora de ESCOLHER, o servidor busca o SVG uma vez e
// guarda. Depois disso, a vitrine não fala com ninguém.
//
// ── E QUEM BUSCA É O SERVIDOR, não o navegador ───────────────────────────
//
// A tela manda só o NOME ("mdi:shower"). Se ela mandasse o SVG, estaríamos
// aceitando markup arbitrário de quem controla o navegador — e esse markup vai
// para dentro de uma página pública, inline. O nome é um dado inerte; o SVG,
// não.
const TEMPO_LIMITE_MS = 6000;
const MAX_BYTES = 64 * 1024;

// "mdi:shower", "material-symbols:pool-rounded". Conjunto e nome, os dois com o
// alfabeto restrito que a própria Iconify usa.
const NOME = /^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/;

// ── O QUE PODE ESTAR DENTRO DE UM ÍCONE ──────────────────────────────────
//
// Lista fechada de tags de DESENHO. Tudo que executa, carrega ou navega fica
// fora: `script` é óbvio, `foreignObject` embute HTML inteiro, `image` e `use`
// carregam de fora, `a` navega, `style` traz CSS que escapa do ícone.
const TAGS = new Set([
  "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "g", "defs", "clipPath", "mask", "linearGradient", "radialGradient", "stop",
]);

// ── RECUSAR, E NÃO LIMPAR ────────────────────────────────────────────────
//
// Um sanitizador tenta adivinhar o que o navegador vai fazer com o que sobrou, e
// erra justamente nos casos que importam. Aqui, o que não bate com a lista é
// RECUSADO inteiro: o ícone não é guardado e a pessoa escolhe outro.
//
// O custo é recusar um ícone exótico de vez em quando. O ganho é que o que entra
// no banco — e depois, inline, numa página pública — só tem forma de desenho.
function seguro(body) {
  const texto = String(body || "");
  if (!texto || texto.length > MAX_BYTES) return false;

  // Nada de manipulador de evento, endereço ou protocolo executável.
  if (/\son[a-z]+\s*=/i.test(texto)) return false;
  if (/(xlink:)?href\s*=/i.test(texto)) return false;
  if (/javascript:|data:text\/html/i.test(texto)) return false;
  if (/<!--|<!\[CDATA\[/.test(texto)) return false;

  // E toda tag aberta tem de estar na lista.
  for (const m of texto.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/g)) {
    if (!TAGS.has(m[1])) return false;
  }

  return true;
}

// Busca o ícone e devolve `{ nome, body, caixa }`, ou `null`.
//
// Nunca estoura: é uma ida a um servidor de terceiro no meio de um "salvar", e
// uma rede lenta não pode impedir alguém de gravar um benefício. Sem o ícone, o
// benefício é gravado sem ele — que é o mesmo estado de quem não escolheu.
async function buscar(nome) {
  const limpo = String(nome || "").trim().toLowerCase();
  if (!NOME.test(limpo)) return null;

  const [conjunto, icone] = limpo.split(":");

  try {
    const resposta = await fetch(
      `https://api.iconify.design/${encodeURIComponent(conjunto)}.json?icons=${encodeURIComponent(icone)}`,
      { signal: AbortSignal.timeout(TEMPO_LIMITE_MS) }
    );
    if (!resposta.ok) return null;

    const dados = await resposta.json();
    const achado = dados?.icons?.[icone];
    if (!achado?.body || !seguro(achado.body)) return null;

    // A CAIXA vem do ícone quando ele a tem, e do conjunto quando não: é a
    // diferença entre um ícone de 24 e um de 16, e sem ela todos saem
    // esticados. O padrão da Iconify é 16 quando ninguém diz.
    const largura = Number(achado.width || dados.width || 16);
    const altura = Number(achado.height || dados.height || 16);

    return {
      nome: limpo,
      body: achado.body,
      caixa: `0 0 ${largura} ${altura}`,
    };
  } catch (erro) {
    console.warn("[iconify]", erro?.message || erro);
    return null;
  }
}

module.exports = { buscar, seguro, NOME, TAGS, MAX_BYTES };
