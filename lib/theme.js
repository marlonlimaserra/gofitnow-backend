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
const LAYOUTS = ["centered", "split", "card", "side"];
const BACKGROUNDS = ["gradient", "solid", "image", "slider"];

// Como uma foto entra no lugar da outra no fundo alternando.
const EFFECTS = ["fade", "slide", "zoom", "none"];

// Em segundos. O piso não é gosto: abaixo de 2s a troca vira estroboscópio em
// cima do campo de senha.
const MIN_SPEED = 2;
const MAX_SPEED = 60;

// Como o degradê se mexe. Nenhum deles muda cor: mexem posição e tamanho das
// manchas, que é o que se pode animar sem a marca virar outra cor.
const MOTIONS = ["none", "drift", "pulse", "aurora"];

// Quanto escurece o fundo, de 0 a 100.
//
// A camada escura existe para o texto branco continuar legível — sem ela, uma
// foto clara ou um degradê claro engolem a marca. Mas ela também era o que
// impedia "branco + branco" de ficar branco, então virou escolha.
const MIN_OVERLAY = 0;
const MAX_OVERLAY = 100;

// Segundos por ciclo do movimento do degradê.
const MIN_MOTION_SPEED = 2;
const MAX_MOTION_SPEED = 120;

// A altura da logo, em pixels. Passou a ser número porque quatro degraus não
// dão conta de logo larga e baixa junto com logo quadrada.
//
// O PISO é o que importa: abaixo de 16 a logo não se lê, e uma marca ilegível é
// pior que nenhuma.
//
// O TETO era 160, pelo argumento de que acima disso a logo empurra o formulário
// para fora da dobra num notebook. O argumento continua verdadeiro e deixou de ser
// motivo para proibir: nos modelos dividido e lateral a marca tem uma coluna só
// para ela, e ali 160 px é pequeno. Quem exagerar vê o exagero na prévia e
// corrige — a tela mostra o resultado enquanto se digita.
//
// 2000 é o teto de sanidade, não de gosto: acima disso não é escolha de desenho,
// é número digitado errado.
const MIN_LOGO = 16;
const MAX_LOGO = 2000;

// Os degraus que existiam antes de o tamanho virar número.
const LOGO_SIZES_ANTIGOS = { sm: 32, md: 44, lg: 56, xl: 80 };

// A largura da logo do menu pode ser 0 = "automática", que é o que preserva a
// proporção do arquivo. A altura tem piso, senão a logo some.
// A do MENU tem teto próprio e menor de propósito: ela divide a barra com os itens
// de navegação, e uma logo de 2000 px ali empurraria o menu inteiro para fora da
// tela. Aqui o limite é estrutural, não de gosto.
const MIN_MENU_LOGO = 12;
const MAX_MENU_LOGO = 400;

const MAX_PHOTOS = 6;

const PADRAO = {
  brand: "#16a34a",
  // A SOMBRA dos botões primários.
  //
  // Vazio é "como está": nenhuma regra é escrita, e cada botão fica com o que
  // sua própria classe diz. É o único valor que não muda a tela de ninguém, e
  // por isso é o padrão — os outros três valem para TODOS os botões primários,
  // inclusive os que hoje não têm sombra nenhuma.
  buttonShadow: "",

  // O que o botão faz ao receber o MOUSE e ao ser CLICADO.
  //
  // Vazio de novo é "como está": o botão já escurece no hover, por classe. Os
  // outros valores ACRESCENTAM a isso — não substituem.
  buttonHover: "",
  buttonPress: "",

  // A SEGUNDA cor dos botões.
  //
  // Vazia é o normal: botão de cor sólida, a marca. Preenchida, os botões
  // primários viram um degradê que vai da marca até ela.
  //
  // Só a segunda ponta é guardada, e não o degradê inteiro: a primeira é
  // sempre a marca. Guardar as duas deixaria o botão parar de acompanhar a
  // marca no dia em que ela mudasse — que é a única razão de a marca existir
  // como campo.
  brandTo: "",
  layout: "centered",
  background: "gradient",
  // As cores do fundo. VAZIO quer dizer "tira da marca", e é diferente de uma
  // cor igual à da marca: quem deixou vazio continua acompanhando a marca
  // quando ela mudar; quem escolheu a mesma cor, não.
  bgColor: "",
  gradientFrom: "",
  gradientVia: "",
  gradientTo: "",
  gradientMotion: "none",
  motionSpeed: 20,
  overlay: 55,
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
  // Cor vazia = automática, tirada da luminância do fundo. `hide*` é guardado
  // no NEGATIVO para casar com a caixa da tela ("sem frase"): marcada esconde.
  // Um `showSubtitle` daria uma dupla negação na leitura do componente.
  titleColor: "",
  subtitleColor: "",
  hideTitle: false,
  hideSubtitle: false,
  // O seletor de idioma do rodapé. Guardado no NEGATIVO como os outros dois,
  // para casar com a caixa da tela: marcada esconde.
  //
  // Quem atende só numa língua tem um seletor que só atrapalha; quem atende
  // turista não pode escondê-lo. Por isso é escolha, e por isso o padrão é
  // MOSTRAR: esconder por conta própria tiraria de quem já depende dele.
  hideLangPicker: false,
  logo: "",
  logoSize: 44,
  // ── O menu principal, que é aparência de DEPOIS de entrar ────────────────
  //
  // Mesma regra das cores do fundo: vazio quer dizer "usa o padrão", e não
  // "sem cor". A cor do texto vazia é derivada do fundo pela tela — claro
  // sobre escuro, escuro sobre claro — para o modelo branco funcionar sem a
  // pessoa ter de escolher duas cores.
  // As cores do PAINEL do modelo cartão. Separadas das do fundo de propósito:
  // no cartão o fundo é moldura e o painel é a marca, e amarrar os dois
  // obrigaria a escolher uma cor que serve para os dois papéis.
  cardFrom: "",
  cardTo: "",
  // Onde o menu principal fica: na lateral (o de sempre) ou numa faixa no
  // topo. No celular é sempre gaveta — um menu horizontal com dez itens não
  // cabe em 360 px, e virar rolagem lateral seria pior que a gaveta.
  menuLayout: "side",
  menuBg: "",
  menuText: "",
  menuLogo: "",
  // 0 = automática, preservando a proporção do arquivo.
  menuLogoWidth: 0,
  menuLogoHeight: 28,

  // ── O fundo de DEPOIS de entrar ──────────────────────────────────────────
  //
  // A área de conteúdo, atrás das telas do dia a dia. Vazio é o cinza-claro de
  // sempre: é onde se trabalha, e um fundo carregado atrás de uma tabela cansa
  // em dez minutos. Por isso o padrão é não ter nenhum, e por isso existe o
  // escurecer.
  //
  // `appBg` é a imagem de quem tem a sua; `appBgPattern` é um dos desenhos
  // prontos. A imagem VENCE o desenho quando as duas existem — quem subiu um
  // arquivo escolheu de forma mais explícita.
  appBg: "",
  appBgPattern: "",
  // A cor do desenho. VAZIO acompanha a marca, como em todo o resto do tema:
  // quem não escolhe cor nenhuma vê o fundo mudar junto quando a marca muda.
  appBgColor: "",
  // Quanto escurecer, em porcentagem. Vale para os dois.
  appBgDim: 0,

  // Quanto APAGAR o fundo, em porcentagem.
  //
  // Irmão do escurecer, e o contrário dele: um puxa para o preto, este puxa
  // para o branco da página. Não é opacidade de verdade — o fundo divide o
  // elemento com o conteúdo, e uma opacidade ali apagaria o texto junto. É um
  // véu branco por cima, que dá o mesmo resultado sem tocar em nada por cima.
  appBgFade: 0,

  // O fundo se MEXE?
  //
  // Vazio é parado, e é o padrão — atrás de uma tela de trabalho, movimento é
  // uma coisa a mais competindo com o que a pessoa está lendo.
  //
  // Os nomes não são os mesmos da tela de entrada de propósito: lá o fundo tem
  // uma camada só para ele e pode mudar de cor; aqui ele divide o elemento com
  // o conteúdo, e só o que NÃO mexe com os filhos é possível — a posição e o
  // tamanho do desenho.
  appBgMotion: "",
  appBgSpeed: 40,

  // ── A barra do navegador ─────────────────────────────────────────────────
  //
  // O ícone da aba e o título dela. É o que aparece quando o cliente está com
  // quinze abas abertas e nenhuma cabe o nome inteiro — por isso o modo padrão
  // é o NOME FIXO: uma aba que diz "Pessoas" não diz de quem.
  // A fonte do app inteiro. Vazio é a do sistema — a que o app sempre usou, e
  // a única que não custa download nenhum.
  font: "",

  favicon: "",
  tabName: "",
  tabTitle: "fixed",

  // ── O LINK COMPARTILHADO ─────────────────────────────────────────────────
  //
  // O cartão que WhatsApp, LinkedIn, Facebook e Google montam quando alguém
  // cola o endereço. Eles NÃO executam JavaScript: leem o HTML cru. Por isso
  // estes campos não servem para a tela — servem para a função de borda que
  // reescreve o HTML antes de ele sair da Cloudflare.
  //
  // Tudo vazio é o padrão do GoFitNow, que é o que sempre foi.
  metaTitle: "",
  metaDescription: "",
  // Precisa ser endereço ABSOLUTO: o robô do WhatsApp não sabe resolver "/x.png"
  // — ele nem carregou a página, só leu a tag.
  metaImage: "",
  metaSiteName: "",
  // O formato do cartão: imagem grande ou miniatura ao lado do texto.
  metaCard: "summary_large_image",
  // A cor da barra do navegador no celular. Vazio acompanha a marca.
  metaThemeColor: "",
  // Aparecer no Google? Vazio não escreve tag nenhuma — é o que o app faz hoje.
  metaRobots: "",
};

// Os campos do tema que guardam ENDEREÇO DE IMAGEM.
//
// Existe porque quem grava o tema também recolhe o lixo: as imagens que o tema
// não referencia mais são apagadas. Uma lista escrita à mão no controller ficou
// para trás quando a logo do menu nasceu, e o efeito foi mudo e destrutivo — a
// imagem era apagada na gravação seguinte e a logo virava 404 sozinha.
//
// Aqui, ao lado do saneamento, é o lugar onde alguém que acrescenta um campo de
// imagem tropeça nela.
const IMAGE_FIELDS = ["logo", "menuLogo", "photo", "appBg", "favicon", "metaImage"];
const IMAGE_LIST_FIELDS = ["photos"];

// Todas as URLs de imagem de um tema, numa lista só.
function imageUrls(theme) {
  const urls = IMAGE_FIELDS.map((f) => theme?.[f]).filter(Boolean);

  for (const f of IMAGE_LIST_FIELDS) {
    if (Array.isArray(theme?.[f])) urls.push(...theme[f].filter(Boolean));
  }

  return urls;
}

// Os desenhos prontos para o fundo de navegação. Vazio é sem fundo.
//
// São DESENHOS, não fotos: cada um é feito de gradiente, então vale qualquer
// tamanho de tela sem pesar um byte de download. Um JPEG de 4K de fundo custaria
// mais que a tela inteira que ele decora.
//
// Duas famílias na mesma lista, e de propósito: para quem escolhe, é tudo
// "fundo". O prefixo `img-` é o que separa as duas no código — desenho de
// gradiente contra imagem servida junto com o app.
//
// A cor só vale para os desenhos: uma foto já vem com as cores dela.
const APP_BG_PATTERNS = [
  "",
  "waves",
  "arcs",
  "cross",
  "silk",
  "img-curvas",
  "img-arcos",
  "img-losango",
  "img-fitas",
];

const MAX_APP_BG_DIM = 80;
const MAX_APP_BG_FADE = 90;

// O formato do cartão nas redes: imagem grande em cima do texto, ou miniatura
// quadrada ao lado dele.
const META_CARDS = ["summary_large_image", "summary"];

// Aparecer nas buscas. Vazio não escreve tag — o robô decide como sempre
// decidiu; `noindex` é para quem não quer a tela de entrada no Google.
const META_ROBOTS = ["", "index", "noindex"];

// Onde o menu principal mora. Sem vazio: ele sempre está em algum lugar.
const MENU_LAYOUTS = ["side", "top"];

// As fontes oferecidas.
//
// Poucas e escolhidas: cada uma é um download que a tela espera, e uma lista de
// trinta faria a escolha virar rolagem. Todas têm acentuação completa — sem
// isso "avaliação" apareceria com o "ç" de outra fonte, e ninguém entenderia o
// que ficou torto.
//
// Vazio é a fonte do SISTEMA: nada para baixar, e é o que o app sempre usou.
const FONTS = ["", "jakarta", "inter", "poppins", "nunito", "manrope", "dm-sans"];

// O que vai no título da aba.
//
//   fixed — só o nome escolhido;
//   both  — o nome e a página atual;
//   page  — só a página atual.
//
// Não há "vazio" aqui: uma aba sempre tem título, e o que se escolhe é o que
// entra nele.
const TAB_TITLES = ["fixed", "both", "page"];

// O movimento do fundo de navegação.
//
// `drift` desliza o desenho, `breathe` o aproxima e afasta, `both` faz os dois.
// São só estes porque o fundo divide o elemento com o conteúdo: mexer na
// posição e no tamanho do DESENHO não toca em nada do que está escrito por
// cima, enquanto um filtro ou uma opacidade repintariam o texto junto.
const APP_BG_MOTIONS = ["", "drift", "breathe", "both"];

// Segundos de uma volta inteira. O piso é ALTO de propósito: isto fica atrás de
// quem está trabalhando, e um fundo que se mexe rápido tira o olho da tela.
const MIN_APP_BG_SPEED = 10;
const MAX_APP_BG_SPEED = 240;

// Cores prontas para o desenho do fundo.
//
// Mais que os seis temas de marca, e por um motivo: aqui a cor não precisa
// servir de identidade — ela aparece diluída, em fio fino sobre branco. Um lilás
// que seria fraco demais para um botão fica bom atrás de uma tabela.
const APP_BG_COLORS = [
  "#64748b",
  "#0ea5e9",
  "#2563eb",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#ec4899",
  "#f43f5e",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
];

// A sombra dos botões. Vazio é "como está" — ver o padrão.
const BUTTON_SHADOWS = ["", "none", "soft", "strong"];

// O efeito ao passar o mouse. A lista veio da Hover.css, com os nomes de lá:
// crescer, flutuar, avançar, sombra, e as combinações com sombra.
//
// Todos são SOMADOS ao escurecer que a classe do botão já faz — por isso aqui
// só há movimento e luz, nunca cor.
//
// "lift", que existiu por uma tarde, virou "float": era a mesma ideia com nome
// inventado. Quem tivesse guardado "lift" cai em "" — "como está" —, que é o
// pior caso aceitável: nada acontece, em vez de acontecer outra coisa.
const BUTTON_HOVERS = [
  "",
  "grow",
  "float",
  "forward",
  "shadow",
  "grow-shadow",
  "float-shadow",
  "glow",
];

// O efeito ao clicar. Os dois dizem a mesma coisa por caminhos diferentes —
// que o botão foi apertado — e por isso não se combinam.
const BUTTON_PRESSES = ["", "sink", "shrink"];

// Degradês prontos: os dois extremos de uma vez.
//
// Cada um traz a MARCA e a segunda cor, e não só a segunda: um degradê é a
// relação entre duas cores, e oferecer só a ponta faria "pôr do sol" ficar
// verde-laranja para quem tem marca verde — um par que ninguém escolheu.
//
// São vizinhos no círculo de cor, nunca opostos: duas cores distantes fazem uma
// faixa suja no meio do botão, que é onde o texto fica.
// O texto dos botões é BRANCO. Toda ponta aqui precisa ser escura o bastante
// para ele ser lido — é a régua que o teste guarda, e o motivo de não haver
// pastel nenhum nesta lista.
const GRADIENTS = [
  { key: "forest", brand: "#16a34a", brandTo: "#0d9488" },
  { key: "lime", brand: "#16a34a", brandTo: "#65a30d" },
  { key: "teal", brand: "#0d9488", brandTo: "#0891b2" },
  { key: "ocean", brand: "#2563eb", brandTo: "#0891b2" },
  { key: "indigo", brand: "#4f46e5", brandTo: "#7c3aed" },
  { key: "violet", brand: "#7c3aed", brandTo: "#c026d3" },
  { key: "tangerine", brand: "#ea580c", brandTo: "#d97706" },
  { key: "fire", brand: "#dc2626", brandTo: "#ea580c" },
  { key: "sunset", brand: "#ea580c", brandTo: "#db2777" },
  { key: "cherry", brand: "#db2777", brandTo: "#e11d48" },
  { key: "midnight", brand: "#334155", brandTo: "#1e3a8a" },
];

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
    brandTo: parseHex(e.brandTo) || "",
    buttonShadow: umDe(e.buttonShadow, BUTTON_SHADOWS, PADRAO.buttonShadow),
    buttonHover: umDe(e.buttonHover, BUTTON_HOVERS, PADRAO.buttonHover),
    buttonPress: umDe(e.buttonPress, BUTTON_PRESSES, PADRAO.buttonPress),
    // Cor inválida vira VAZIO, não o padrão: vazio é "tira da marca", que é
    // exatamente o que fazer quando não se sabe o que a pessoa quis.
    bgColor: parseHex(e.bgColor) || "",
    gradientFrom: parseHex(e.gradientFrom) || "",
    gradientVia: parseHex(e.gradientVia) || "",
    gradientTo: parseHex(e.gradientTo) || "",
    gradientMotion: umDe(e.gradientMotion, MOTIONS, PADRAO.gradientMotion),
    motionSpeed: numero(e.motionSpeed, MIN_MOTION_SPEED, MAX_MOTION_SPEED, PADRAO.motionSpeed),
    // Zero é um valor legítimo aqui — "sem escurecer nada" — e é o que faz o
    // branco ficar branco. Por isso o piso é 0, e não um mínimo de segurança.
    overlay: numero(e.overlay, MIN_OVERLAY, MAX_OVERLAY, PADRAO.overlay),
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
    titleColor: parseHex(e.titleColor) || "",
    subtitleColor: parseHex(e.subtitleColor) || "",
    hideTitle: Boolean(e.hideTitle),
    hideSubtitle: Boolean(e.hideSubtitle),
    hideLangPicker: Boolean(e.hideLangPicker),
    logo: parseUrl(e.logo) || "",
    // Os degraus antigos (sm/md/lg/xl) viram o pixel que eles valiam, para
    // quem já tinha escolhido não ver a logo mudar de tamanho sozinha.
    logoSize: numero(
      LOGO_SIZES_ANTIGOS[e.logoSize] ?? e.logoSize,
      MIN_LOGO,
      MAX_LOGO,
      PADRAO.logoSize
    ),
    cardFrom: parseHex(e.cardFrom) || "",
    cardTo: parseHex(e.cardTo) || "",
    menuLayout: umDe(e.menuLayout, MENU_LAYOUTS, PADRAO.menuLayout),
    menuBg: parseHex(e.menuBg) || "",
    menuText: parseHex(e.menuText) || "",
    menuLogo: parseUrl(e.menuLogo) || "",
    // A largura aceita 0, que é "automática" — por isso o piso dela é 0 e não
    // MIN_MENU_LOGO. Um número entre 1 e 11 seria uma logo invisível, então
    // sobe para o piso.
    menuLogoWidth: numero(e.menuLogoWidth, 0, MAX_MENU_LOGO, PADRAO.menuLogoWidth) === 0
      ? 0
      : numero(e.menuLogoWidth, MIN_MENU_LOGO, MAX_MENU_LOGO, PADRAO.menuLogoWidth),
    menuLogoHeight: numero(e.menuLogoHeight, MIN_MENU_LOGO, MAX_MENU_LOGO, PADRAO.menuLogoHeight),
    appBg: parseUrl(e.appBg) || "",
    appBgPattern: umDe(e.appBgPattern, APP_BG_PATTERNS, PADRAO.appBgPattern),
    appBgColor: parseHex(e.appBgColor) || "",
    appBgMotion: umDe(e.appBgMotion, APP_BG_MOTIONS, PADRAO.appBgMotion),
    appBgSpeed: numero(e.appBgSpeed, MIN_APP_BG_SPEED, MAX_APP_BG_SPEED, PADRAO.appBgSpeed),
    font: umDe(e.font, FONTS, PADRAO.font),
    favicon: parseUrl(e.favicon) || "",
    tabName: texto(e.tabName, 40),
    tabTitle: umDe(e.tabTitle, TAB_TITLES, PADRAO.tabTitle),
    metaTitle: texto(e.metaTitle, 70),
    // 200 é o que os robôs cortam. Guardar mais é guardar o que ninguém lê.
    metaDescription: texto(e.metaDescription, 200),
    metaImage: parseUrl(e.metaImage) || "",
    metaSiteName: texto(e.metaSiteName, 40),
    metaCard: umDe(e.metaCard, META_CARDS, PADRAO.metaCard),
    metaThemeColor: parseHex(e.metaThemeColor) || "",
    metaRobots: umDe(e.metaRobots, META_ROBOTS, PADRAO.metaRobots),
    // Zero é legítimo — "não escurecer" — e é o padrão. O teto é 80: acima
    // disso o conteúdo perde contraste com o próprio fundo.
    appBgDim: numero(e.appBgDim, 0, MAX_APP_BG_DIM, PADRAO.appBgDim),
    // O teto é 90, e não 100: apagar por inteiro é o mesmo que não ter fundo, e
    // aí a escolha certa é "Sem fundo" — que não paga o download da imagem.
    appBgFade: numero(e.appBgFade, 0, MAX_APP_BG_FADE, PADRAO.appBgFade),
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
  MOTIONS,
  MIN_LOGO,
  MAX_LOGO,
  MIN_OVERLAY,
  MAX_OVERLAY,
  MIN_MOTION_SPEED,
  MAX_MOTION_SPEED,
  MIN_MENU_LOGO,
  MAX_MENU_LOGO,
  MIN_SPEED,
  MAX_SPEED,
  MAX_PHOTOS,
  PRESETS,
  GRADIENTS,
  APP_BG_PATTERNS,
  APP_BG_COLORS,
  APP_BG_MOTIONS,
  FONTS,
  MENU_LAYOUTS,
  TAB_TITLES,
  META_CARDS,
  META_ROBOTS,
  MIN_APP_BG_SPEED,
  MAX_APP_BG_SPEED,
  MAX_APP_BG_DIM,
  MAX_APP_BG_FADE,
  IMAGE_FIELDS,
  IMAGE_LIST_FIELDS,
  imageUrls,
  BUTTON_SHADOWS,
  BUTTON_HOVERS,
  BUTTON_PRESSES,
  defaults,
  sanitize,
  scale,
  parseHex,
  parseUrl,
};
