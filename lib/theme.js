// A aparência que cada profissional escolhe para o próprio domínio.
//
// O que entra aqui vira CSS na tela de quem abre o domínio, então tudo é
// validado com desconfiança: `brand` acaba dentro de uma custom property, e um
// valor não checado seria injeção de estilo — ou pior, de URL.
//
// A regra é sempre a mesma: o que não reconheço vira o padrão, em vez de passar.
//
// COMPOSIÇÃO e FUNDO são coisas separadas, e essa separação é o desenho:
//
//   `layout`     — onde ficam o cartão e a marca. Muda a estrutura da página.
//   `background` — o que aparece atrás. Não muda estrutura nenhuma.
//
// Antes eram um campo só, e por isso "foto" e "degradê" eram alternativas
// excludentes — não dava para ter o modelo dividido com fundo de foto. Agora
// qualquer composição aceita qualquer fundo, e a conta de combinações sai de
// quatro para doze sem escrever um componente a mais.
const LAYOUTS = ["centered", "split", "side"];
const BACKGROUNDS = ["gradient", "solid", "image", "slider"];

// Como uma foto entra no lugar da outra no fundo alternando.
const EFFECTS = ["fade", "slide", "zoom", "none"];

// Em segundos. O piso não é gosto: abaixo de 2s a troca vira estroboscópio em
// cima do campo de senha.
const MIN_SPEED = 2;
const MAX_SPEED = 60;

const LOGO_SIZES = ["sm", "md", "lg", "xl"];
const MAX_PHOTOS = 6;

const PADRAO = {
  brand: "#16a34a",
  layout: "centered",
  background: "gradient",
  photo: "",
  photos: [],
  sliderSpeed: 6,
  sliderEffect: "fade",
  // A trama de pontos sobre o degradê. Nasce ligada porque é o que já estava
  // na tela antes de virar escolha — desligá-la para todo mundo mudaria a tela
  // de quem nunca pediu nada.
  dots: true,
  title: "",
  subtitle: "",
  logo: "",
  logoSize: "md",
};

// Temas prontos: quem não quer escolher cor tem seis caminhos decentes. Só cor
// — a composição e o fundo são escolha à parte, e um preset que mexesse neles
// desfaria em silêncio o que a pessoa montou.
const PRESETS = [
  { key: "green", brand: "#16a34a" },
  { key: "blue", brand: "#2563eb" },
  { key: "purple", brand: "#7c3aed" },
  { key: "orange", brand: "#ea580c" },
  { key: "slate", brand: "#334155" },
  { key: "pink", brand: "#db2777" },
];

// Os temas guardados antes de composição e fundo se separarem. O campo `layout`
// carregava os dois, então cada valor antigo vira um par.
//
// Isto não é migração de banco de uma vez: roda no sanitize, ou seja, na
// leitura. Um tema antigo sai daqui já traduzido, e é regravado na próxima vez
// que a pessoa salvar — sem script, sem janela em que a tela quebra.
const LAYOUTS_ANTIGOS = {
  gradient: { layout: "centered", background: "gradient" },
  solid: { layout: "centered", background: "solid" },
  // "photo" desenhava o cartão encostado na esquerda; é o `side` de hoje.
  photo: { layout: "side", background: "image" },
  slider: { layout: "centered", background: "slider" },
};

function defaults() {
  return { ...PADRAO, photos: [] };
}

// Aceita "#rgb", "#rrggbb" e sem o "#". Qualquer outra coisa é recusada — é o
// que impede "red; background: url(...)" de chegar à folha de estilo.
function parseHex(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim().replace(/^#/, "").toLowerCase();

  if (/^[0-9a-f]{3}$/.test(limpo)) {
    return "#" + limpo.split("").map((c) => c + c).join("");
  }
  if (/^[0-9a-f]{6}$/.test(limpo)) return "#" + limpo;
  return null;
}

// Só http(s), e só string. Sem isto um "javascript:" ou um "data:text/html"
// entraria como fundo da tela de login — que é pública.
function parseUrl(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(limpo)) return null;
  if (limpo.length > 500) return null;
  return limpo;
}

function texto(valor, max) {
  if (typeof valor !== "string") return "";
  return valor.trim().slice(0, max);
}

// Número dentro de uma faixa. Fora dela, encosta na borda em vez de virar o
// padrão: quem mandou 100 quis "o mais devagar que der", não "o de fábrica".
function numero(valor, min, max, padrao) {
  // `Number(null)` e `Number("")` valem 0 — encostariam no piso em vez de cair
  // no padrão, e "não informado" viraria "o mais rápido possível".
  if (typeof valor !== "number" && typeof valor !== "string") return padrao;
  if (valor === "") return padrao;

  const n = Number(valor);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
}

function umDe(valor, lista, padrao) {
  return lista.includes(valor) ? valor : padrao;
}

function sanitize(entrada) {
  const e = entrada && typeof entrada === "object" ? entrada : {};

  // Tema gravado antes de composição e fundo se separarem: o `layout` antigo
  // valia pelos dois. Traduzido aqui, na leitura.
  const antigo = LAYOUTS_ANTIGOS[e.layout];

  return {
    brand: parseHex(e.brand) || PADRAO.brand,
    layout: antigo ? antigo.layout : umDe(e.layout, LAYOUTS, PADRAO.layout),
    background: antigo
      ? antigo.background
      : umDe(e.background, BACKGROUNDS, PADRAO.background),
    photo: parseUrl(e.photo) || "",
    photos: Array.isArray(e.photos)
      ? e.photos.map(parseUrl).filter(Boolean).slice(0, MAX_PHOTOS)
      : [],
    sliderSpeed: numero(e.sliderSpeed, MIN_SPEED, MAX_SPEED, PADRAO.sliderSpeed),
    sliderEffect: umDe(e.sliderEffect, EFFECTS, PADRAO.sliderEffect),
    // Ausente vira o padrão ligado; qualquer valor presente vale pelo que é.
    // Um `false` explícito tem de sobreviver, e `e.dots ?? true` faria isso —
    // mas "0" e "" vindos de um formulário não fariam.
    dots: e.dots === undefined ? PADRAO.dots : Boolean(e.dots),
    title: texto(e.title, 80),
    subtitle: texto(e.subtitle, 160),
    logo: parseUrl(e.logo) || "",
    logoSize: umDe(e.logoSize, LOGO_SIZES, PADRAO.logoSize),
  };
}

// ── A escala de cor ──────────────────────────────────────────────────────
// Dez tons a partir de uma cor só, do 50 ao 900, como a paleta do Tailwind.
//
// A conta é feita em HSL e mexe só na LUMINOSIDADE, nunca no matiz: um azul
// escolhido pelo profissional tem de continuar azul nos dez tons. A saturação
// baixa um pouco nas pontas, senão o tom 50 fica berrante e o 900 fica sujo.
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h, s, l };
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A luminosidade alvo de cada tom. Os números vêm da paleta do Tailwind, para a
// escala gerada conviver com as cores de sistema (slate, red) sem destoar.
const LUZES = {
  50: 0.96,
  100: 0.9,
  200: 0.82,
  300: 0.71,
  400: 0.6,
  500: 0.5,
  600: 0.43,
  700: 0.35,
  800: 0.28,
  900: 0.22,
};

function scale(hex) {
  const cor = parseHex(hex) || PADRAO.brand;
  const { h, s } = hexToHsl(cor);

  const out = {};
  for (const [tom, l] of Object.entries(LUZES)) {
    // Nas pontas a saturação cede: um 50 com saturação cheia vira néon, e um
    // 900 saturado fica lamacento.
    const distancia = Math.abs(l - 0.5) * 2;
    const sat = Math.max(0.08, s * (1 - distancia * 0.35));
    out[tom] = hslToHex(h, sat, l);
  }
  return out;
}

module.exports = {
  LAYOUTS,
  BACKGROUNDS,
  EFFECTS,
  LOGO_SIZES,
  MIN_SPEED,
  MAX_SPEED,
  MAX_PHOTOS,
  PRESETS,
  defaults,
  sanitize,
  scale,
  parseHex,
  parseUrl,
};
