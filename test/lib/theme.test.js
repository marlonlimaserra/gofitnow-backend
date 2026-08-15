const test = require("node:test");
const assert = require("node:assert/strict");

const theme = require("../../lib/theme.js");

test("o tema padrão é válido e tem a marca do GoFitNow", () => {
  const t = theme.defaults();
  assert.match(t.brand, /^#[0-9a-f]{6}$/i);
  assert.ok(theme.LAYOUTS.includes(t.layout));
});

test("sanitize aceita uma cor em hex, com ou sem #", () => {
  assert.equal(theme.sanitize({ brand: "#16a34a" }).brand, "#16a34a");
  assert.equal(theme.sanitize({ brand: "16a34a" }).brand, "#16a34a");
  assert.equal(theme.sanitize({ brand: "#16A34A" }).brand, "#16a34a");
});

test("sanitize aceita hex de 3 dígitos e expande", () => {
  assert.equal(theme.sanitize({ brand: "#0a0" }).brand, "#00aa00");
});

test("cor inválida cai no padrão em vez de entrar no CSS", () => {
  // É o ponto perigoso: `brand` vira valor de custom property. Qualquer texto
  // que passasse daqui seria injetado na folha de estilo.
  for (const ruim of [
    "red; background: url(evil)",
    "javascript:alert(1)",
    "#12345",
    "var(--x)",
    "",
    null,
    undefined,
    123,
    {},
  ]) {
    assert.equal(theme.sanitize({ brand: ruim }).brand, theme.defaults().brand, JSON.stringify(ruim));
  }
});

test("layout desconhecido cai no padrão", () => {
  assert.equal(theme.sanitize({ layout: "inventado" }).layout, theme.defaults().layout);
  for (const l of theme.LAYOUTS) assert.equal(theme.sanitize({ layout: l }).layout, l);
});

// ── Composição e fundo, que antes eram um campo só ──────────────────────────

test("fundo desconhecido cai no padrão", () => {
  assert.equal(theme.sanitize({ background: "inventado" }).background, theme.defaults().background);
  for (const b of theme.BACKGROUNDS) {
    assert.equal(theme.sanitize({ background: b }).background, b);
  }
});

test("qualquer composição aceita qualquer fundo", () => {
  // É o ponto da separação: antes "dividido com foto" não existia, porque o
  // mesmo campo dizia as duas coisas.
  for (const l of theme.LAYOUTS) {
    for (const b of theme.BACKGROUNDS) {
      const t = theme.sanitize({ layout: l, background: b });
      assert.equal(t.layout, l, `${l}/${b}`);
      assert.equal(t.background, b, `${l}/${b}`);
    }
  }
});

test("tema antigo continua abrindo, com o layout traduzido em par", () => {
  // Os temas guardados antes da separação têm `layout` valendo pelos dois. Um
  // deles caindo no padrão apagaria a escolha de quem já tinha configurado.
  const esperado = {
    gradient: ["centered", "gradient"],
    solid: ["centered", "solid"],
    photo: ["side", "image"],
    slider: ["centered", "slider"],
  };

  for (const [antigo, [layout, background]] of Object.entries(esperado)) {
    const t = theme.sanitize({ layout: antigo });
    assert.equal(t.layout, layout, antigo);
    assert.equal(t.background, background, antigo);
  }
});

test("o valor antigo manda mesmo que venha um fundo junto", () => {
  // Um tema antigo não tem `background`; se tiver, veio de fora e o par antigo
  // é a leitura fiel do que estava gravado.
  const t = theme.sanitize({ layout: "photo", background: "gradient" });
  assert.equal(t.layout, "side");
  assert.equal(t.background, "image");
});

test("a velocidade do slider encosta na borda em vez de virar o padrão", () => {
  // Quem mandou 100 quis "o mais devagar que der", não "o de fábrica".
  assert.equal(theme.sanitize({ sliderSpeed: 1000 }).sliderSpeed, theme.MAX_SPEED);
  assert.equal(theme.sanitize({ sliderSpeed: 0 }).sliderSpeed, theme.MIN_SPEED);
  assert.equal(theme.sanitize({ sliderSpeed: -5 }).sliderSpeed, theme.MIN_SPEED);
  assert.equal(theme.sanitize({ sliderSpeed: 12 }).sliderSpeed, 12);
});

test("velocidade que não é número cai no padrão", () => {
  for (const ruim of ["depressa", null, undefined, {}, NaN]) {
    assert.equal(
      theme.sanitize({ sliderSpeed: ruim }).sliderSpeed,
      theme.defaults().sliderSpeed,
      JSON.stringify(ruim)
    );
  }
});

test("efeito e movimento só aceitam o que existe", () => {
  for (const e of theme.EFFECTS) assert.equal(theme.sanitize({ sliderEffect: e }).sliderEffect, e);
  for (const m of theme.MOTIONS) assert.equal(theme.sanitize({ gradientMotion: m }).gradientMotion, m);

  assert.equal(theme.sanitize({ sliderEffect: "explodir" }).sliderEffect, theme.defaults().sliderEffect);
  assert.equal(theme.sanitize({ gradientMotion: "girar" }).gradientMotion, theme.defaults().gradientMotion);
});

test("o tamanho da logo é em pixels, dentro da faixa", () => {
  assert.equal(theme.sanitize({ logoSize: 72 }).logoSize, 72);
  assert.equal(theme.sanitize({ logoSize: "72" }).logoSize, 72);
  assert.equal(theme.sanitize({ logoSize: 5000 }).logoSize, theme.MAX_LOGO);
  assert.equal(theme.sanitize({ logoSize: 1 }).logoSize, theme.MIN_LOGO);
  assert.equal(theme.sanitize({ logoSize: "grande" }).logoSize, theme.defaults().logoSize);
});

test("os degraus antigos da logo viram o pixel que valiam", () => {
  // Quem já tinha escolhido não pode ver a logo mudar de tamanho sozinha.
  assert.equal(theme.sanitize({ logoSize: "sm" }).logoSize, 32);
  assert.equal(theme.sanitize({ logoSize: "md" }).logoSize, 44);
  assert.equal(theme.sanitize({ logoSize: "lg" }).logoSize, 56);
  assert.equal(theme.sanitize({ logoSize: "xl" }).logoSize, 80);
});

test("as cores do fundo são hex, e cor ruim vira VAZIO — não o padrão", () => {
  // Vazio quer dizer "tira da marca", que é exatamente o que fazer quando não
  // se sabe o que a pessoa quis. Cair no padrão fixaria uma cor que ninguém
  // escolheu e pararia de acompanhar a marca.
  const t = theme.sanitize({ bgColor: "#0a0", gradientFrom: "2563EB", gradientTo: "#dc2626" });
  assert.equal(t.bgColor, "#00aa00");
  assert.equal(t.gradientFrom, "#2563eb");
  assert.equal(t.gradientTo, "#dc2626");

  for (const campo of ["bgColor", "gradientFrom", "gradientTo"]) {
    for (const ruim of ["red; background: url(x)", "var(--x)", "#12345", "", null, 7]) {
      assert.equal(theme.sanitize({ [campo]: ruim })[campo], "", `${campo}: ${JSON.stringify(ruim)}`);
    }
  }
});

test("os pontos do degradê nascem ligados, e um false explícito sobrevive", () => {
  // Desligar para todo mundo mudaria a tela de quem nunca pediu nada.
  assert.equal(theme.sanitize({}).dots, true);
  assert.equal(theme.sanitize({ dots: false }).dots, false);
  assert.equal(theme.sanitize({ dots: true }).dots, true);
});

test("sanitize devolve só os campos conhecidos", () => {
  const t = theme.sanitize({ brand: "#16a34a", inventado: "x", __proto__: { mau: 1 } });
  assert.equal(t.inventado, undefined);
  assert.deepEqual(Object.keys(t).sort(), Object.keys(theme.defaults()).sort());
});

test("as fotos do slider são limitadas e só aceitam http(s)", () => {
  const t = theme.sanitize({
    photos: [
      "https://ok.com/a.jpg",
      "http://ok.com/b.jpg",
      "javascript:alert(1)",
      "data:text/html,<script>",
      123,
    ],
  });
  assert.deepEqual(t.photos, ["https://ok.com/a.jpg", "http://ok.com/b.jpg"]);
});

test("o slider não aceita mais fotos do que cabe", () => {
  const muitas = Array.from({ length: 30 }, (_, i) => `https://x.com/${i}.jpg`);
  assert.ok(theme.sanitize({ photos: muitas }).photos.length <= theme.MAX_PHOTOS);
});

test("textos longos são cortados em vez de virar tela quebrada", () => {
  const t = theme.sanitize({ title: "x".repeat(500), subtitle: "y".repeat(500) });
  assert.ok(t.title.length <= 80);
  assert.ok(t.subtitle.length <= 160);
});

test("a escala sai do claro para o escuro, com 10 tons", () => {
  const escala = theme.scale("#16a34a");
  assert.deepEqual(Object.keys(escala), ["50","100","200","300","400","500","600","700","800","900"]);
  for (const v of Object.values(escala)) assert.match(v, /^#[0-9a-f]{6}$/);
});

test("cada tom é mais escuro que o anterior", () => {
  const escala = theme.scale("#16a34a");
  const luz = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  };
  const tons = Object.values(escala).map(luz);
  for (let i = 1; i < tons.length; i++) {
    assert.ok(tons[i] < tons[i - 1], `o tom ${i} não escureceu: ${tons[i - 1]} → ${tons[i]}`);
  }
});

test("a escala preserva o matiz da cor escolhida", () => {
  // Um azul não pode virar verde no meio da escala.
  const matiz = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    let h = max === r ? (g - b) / d % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };

  for (const cor of ["#2563eb", "#dc2626", "#16a34a", "#9333ea"]) {
    const base = matiz(cor);
    for (const [tom, v] of Object.entries(theme.scale(cor))) {
      const dif = Math.abs(((matiz(v) - base + 540) % 360) - 180);
      assert.ok(dif < 20, `${cor} tom ${tom}: matiz mudou ${dif.toFixed(0)}°`);
    }
  }
});

test("os temas prontos existem e todos passam pelo sanitize sem mudar", () => {
  assert.ok(theme.PRESETS.length >= 4);
  for (const p of theme.PRESETS) {
    assert.match(p.brand, /^#[0-9a-f]{6}$/);
    assert.equal(theme.sanitize({ brand: p.brand }).brand, p.brand, p.key);
  }
});

test("os temas prontos não repetem chave nem cor", () => {
  const chaves = theme.PRESETS.map((p) => p.key);
  assert.equal(new Set(chaves).size, chaves.length);
});

// ── O menu principal ────────────────────────────────────────────────────────

test("as cores do menu são hex, e cor ruim vira vazio", () => {
  // Vazio é "usa o padrão". Cair numa cor fixa deixaria o menu de uma cor que
  // ninguém escolheu.
  const t = theme.sanitize({ menuBg: "#fff", menuText: "0F172A" });
  assert.equal(t.menuBg, "#ffffff");
  assert.equal(t.menuText, "#0f172a");

  for (const ruim of ["red; url(x)", "#12345", "", null]) {
    assert.equal(theme.sanitize({ menuBg: ruim }).menuBg, "", JSON.stringify(ruim));
    assert.equal(theme.sanitize({ menuText: ruim }).menuText, "");
  }
});

test("a largura da logo do menu aceita 0, que é 'automática'", () => {
  // Zero preserva a proporção do arquivo; é diferente de não ter escolhido.
  assert.equal(theme.sanitize({ menuLogoWidth: 0 }).menuLogoWidth, 0);
  assert.equal(theme.sanitize({ menuLogoWidth: 90 }).menuLogoWidth, 90);
  // Entre 1 e o piso seria uma logo invisível: sobe para o piso.
  assert.equal(theme.sanitize({ menuLogoWidth: 5 }).menuLogoWidth, theme.MIN_MENU_LOGO);
  assert.equal(theme.sanitize({ menuLogoWidth: 9999 }).menuLogoWidth, theme.MAX_MENU_LOGO);
});

test("a altura da logo do menu tem piso — sem ele a logo some", () => {
  assert.equal(theme.sanitize({ menuLogoHeight: 0 }).menuLogoHeight, theme.MIN_MENU_LOGO);
  assert.equal(theme.sanitize({ menuLogoHeight: 64 }).menuLogoHeight, 64);
  assert.equal(theme.sanitize({}).menuLogoHeight, theme.defaults().menuLogoHeight);
});

test("a logo do menu só aceita http(s)", () => {
  assert.equal(theme.sanitize({ menuLogo: "https://x.com/a.png" }).menuLogo, "https://x.com/a.png");
  assert.equal(theme.sanitize({ menuLogo: "javascript:alert(1)" }).menuLogo, "");
});

test("o painel do cartão tem cores próprias, e cor ruim vira vazio", () => {
  // Vazio aqui é "usa a cor interna", como em todo campo de cor do tema.
  const t = theme.sanitize({ cardFrom: "#f97316", cardTo: "DB2777" });
  assert.equal(t.cardFrom, "#f97316");
  assert.equal(t.cardTo, "#db2777");

  for (const ruim of ["red; url(x)", "#12345", "", null]) {
    assert.equal(theme.sanitize({ cardFrom: ruim }).cardFrom, "", JSON.stringify(ruim));
  }
});

test("a escuridão do fundo aceita ZERO — é o que faz o branco ficar branco", () => {
  // O piso é 0 de propósito, e não um mínimo de segurança: "sem escurecer
  // nada" é uma escolha legítima.
  assert.equal(theme.sanitize({ overlay: 0 }).overlay, 0);
  assert.equal(theme.sanitize({ overlay: 80 }).overlay, 80);
  assert.equal(theme.sanitize({ overlay: 500 }).overlay, theme.MAX_OVERLAY);
  assert.equal(theme.sanitize({ overlay: -10 }).overlay, theme.MIN_OVERLAY);
  assert.equal(theme.sanitize({ overlay: "muito" }).overlay, theme.defaults().overlay);
});

test("a velocidade do movimento tem faixa própria", () => {
  assert.equal(theme.sanitize({ motionSpeed: 5 }).motionSpeed, 5);
  assert.equal(theme.sanitize({ motionSpeed: 0 }).motionSpeed, theme.MIN_MOTION_SPEED);
  assert.equal(theme.sanitize({ motionSpeed: 9999 }).motionSpeed, theme.MAX_MOTION_SPEED);
});

test("o degradê tem TRÊS cores, e a do meio segue a mesma regra", () => {
  const t = theme.sanitize({ gradientFrom: "#2563eb", gradientVia: "#f59e0b", gradientTo: "#dc2626" });
  assert.equal(t.gradientVia, "#f59e0b");
  assert.equal(theme.sanitize({ gradientVia: "nao-e-cor" }).gradientVia, "");
});

test("frase e título têm cor própria, e podem ser escondidos", () => {
  const t = theme.sanitize({
    titleColor: "#f59e0b",
    subtitleColor: "FFF",
    hideTitle: true,
    hideSubtitle: 1,
  });

  assert.equal(t.titleColor, "#f59e0b");
  assert.equal(t.subtitleColor, "#ffffff");
  assert.equal(t.hideTitle, true);
  assert.equal(t.hideSubtitle, true, "valor de formulário também conta");

  // O padrão é MOSTRAR: quem nunca mexeu não pode perder o texto da tela.
  assert.equal(theme.sanitize({}).hideTitle, false);
  assert.equal(theme.sanitize({}).hideSubtitle, false);
  assert.equal(theme.sanitize({ titleColor: "nao-e-cor" }).titleColor, "");
});

// ── A segunda cor dos botões ─────────────────────────────────────────────
//
// Vazia é o normal: botão sólido, da cor da marca. Preenchida, os botões
// primários viram um degradê que vai da marca até ela. Só a segunda ponta é
// guardada — a primeira é sempre a marca, e é isso que faz o botão continuar
// acompanhando a marca no dia em que ela mudar.

test("a segunda cor nasce vazia — botão sólido é o normal", () => {
  const t = theme.sanitize({});
  assert.equal(t.brandTo, "");
});

test("a segunda cor é guardada quando é cor de verdade", () => {
  const t = theme.sanitize({ brandTo: "#2563EB" });
  assert.equal(t.brandTo, "#2563eb");
});

test("lixo no lugar da segunda cor vira VAZIO, não o padrão", () => {
  // Vazio é "sem degradê". Cair num padrão colorido daria a alguém um botão
  // degradê que ninguém pediu.
  assert.equal(theme.sanitize({ brandTo: "azul" }).brandTo, "");
  assert.equal(theme.sanitize({ brandTo: 123 }).brandTo, "");
});

test("os degradês prontos trazem as DUAS pontas", () => {
  // Oferecer só a segunda cor faria "pôr do sol" ficar verde-laranja para quem
  // tem marca verde — um par que ninguém escolheu.
  assert.ok(theme.GRADIENTS.length >= 4);

  for (const g of theme.GRADIENTS) {
    assert.ok(g.key, "cada pronto precisa de chave para a tradução");
    assert.equal(theme.sanitize({ brand: g.brand }).brand, g.brand);
    assert.equal(theme.sanitize({ brandTo: g.brandTo }).brandTo, g.brandTo);
  }
});

test("nenhum pronto é uma cor só", () => {
  // Duas pontas iguais é um botão sólido com um passo a mais para chegar lá.
  for (const g of theme.GRADIENTS) {
    assert.notEqual(g.brand, g.brandTo, g.key);
  }
});

// ── Os botões: sombra, mouse e clique ────────────────────────────────────
//
// Vazio é "como está" nos três, e é o padrão. Qualquer outro valor vale para
// TODOS os botões primários — inclusive os que hoje não têm sombra nenhuma —,
// então o padrão é o único que não muda a tela de ninguém.

test("os três nascem vazios: nada muda para quem nunca escolheu", () => {
  const t = theme.sanitize({});

  assert.equal(t.buttonShadow, "");
  assert.equal(t.buttonHover, "");
  assert.equal(t.buttonPress, "");
});

test("valor de fora da lista vira vazio, não o primeiro da lista", () => {
  // Cair num valor qualquer daria a alguém um efeito que ninguém pediu.
  assert.equal(theme.sanitize({ buttonShadow: "gigante" }).buttonShadow, "");
  assert.equal(theme.sanitize({ buttonHover: "explodir" }).buttonHover, "");
  assert.equal(theme.sanitize({ buttonPress: "sumir" }).buttonPress, "");
});

test("cada valor da lista é aceito como ele é", () => {
  for (const v of theme.BUTTON_SHADOWS) {
    assert.equal(theme.sanitize({ buttonShadow: v }).buttonShadow, v);
  }
  for (const v of theme.BUTTON_HOVERS) {
    assert.equal(theme.sanitize({ buttonHover: v }).buttonHover, v);
  }
  for (const v of theme.BUTTON_PRESSES) {
    assert.equal(theme.sanitize({ buttonPress: v }).buttonPress, v);
  }
});

test("todo pronto aguenta TEXTO BRANCO nas duas pontas", () => {
  // O texto do botão é branco. Um pronto com uma ponta clara seria um botão
  // com metade do rótulo ilegível — e ninguém veria isso numa revisão de cor
  // por hexadecimal.
  //
  // 3:1 é a régua do texto grande e em negrito, que é o caso do botão.
  const luminancia = (hex) => {
    const canais = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));

    return 0.2126 * canais[0] + 0.7152 * canais[1] + 0.0722 * canais[2];
  };

  const contraste = (hex) => 1.05 / (luminancia(hex) + 0.05);

  for (const g of theme.GRADIENTS) {
    assert.ok(contraste(g.brand) >= 3, `${g.key}: ponta ${g.brand} clara demais`);
    assert.ok(contraste(g.brandTo) >= 3, `${g.key}: ponta ${g.brandTo} clara demais`);
  }
});

test("nenhum pronto repete o par de outro", () => {
  const vistos = new Set();

  for (const g of theme.GRADIENTS) {
    const par = `${g.brand}>${g.brandTo}`;
    assert.ok(!vistos.has(par), `${g.key} repete ${par}`);
    vistos.add(par);
  }
});

// ── As imagens do tema ───────────────────────────────────────────────────
//
// Quem grava o tema também recolhe o lixo: as imagens que ele não referencia
// mais são APAGADAS do banco. Por isso a lista de campos de imagem é uma coisa
// só, e não uma lista escrita à mão em quem faz a faxina.
//
// A lista à mão existiu, ficou para trás quando a logo do menu nasceu, e o
// efeito foi mudo e destrutivo: a imagem era enviada, gravada no tema, e
// apagada na gravação SEGUINTE — a logo do menu virava 404 sozinha, algum tempo
// depois, sem nada nos logs.

test("as URLs de imagem do tema saem todas juntas", () => {
  const urls = theme.imageUrls({
    logo: "u/1",
    menuLogo: "u/2",
    photo: "u/3",
    photos: ["u/4", "u/5"],
  });

  assert.deepEqual(urls, ["u/1", "u/2", "u/3", "u/4", "u/5"]);
});

test("campo de imagem vazio não entra na lista", () => {
  // Um vazio na lista de "em uso" não apagaria nada, mas seria um `undefined`
  // atravessando a consulta — e é ruído que esconde o erro de verdade.
  assert.deepEqual(theme.imageUrls({ logo: "u/1", menuLogo: "", photos: [] }), ["u/1"]);
  assert.deepEqual(theme.imageUrls({}), []);
});

test("TODO campo de imagem do saneamento está na lista da faxina", () => {
  // Esta é a que impede o bug de voltar. O saneamento é a única lista completa
  // de campos que guardam endereço de imagem: cada um passa por `parseUrl`.
  // Um campo novo que não entre em IMAGE_FIELDS teria a imagem apagada na
  // gravação seguinte, em silêncio.
  const { readFileSync } = require("node:fs");
  const fonte = readFileSync(require.resolve("../../lib/theme.js"), "utf8");

  const comUrl = [...fonte.matchAll(/^\s{4}(\w+): parseUrl\(/gm)].map((m) => m[1]);
  assert.ok(comUrl.length >= 3, "não achei os campos de imagem no saneamento");

  for (const campo of comUrl) {
    assert.ok(
      theme.IMAGE_FIELDS.includes(campo),
      `${campo} guarda imagem e não está em IMAGE_FIELDS — ela seria apagada`
    );
  }
});

// ── O fundo de depois de entrar ──────────────────────────────────────────
//
// A área onde se trabalha. O padrão é NÃO ter fundo: um desenho atrás de uma
// tabela cansa em dez minutos, e quem quiser um pode escurecê-lo.

test("sem fundo é o padrão", () => {
  const t = theme.sanitize({});

  assert.equal(t.appBg, "");
  assert.equal(t.appBgPattern, "");
  assert.equal(t.appBgDim, 0);
});

test("desenho de fora da lista não vira fundo", () => {
  assert.equal(theme.sanitize({ appBgPattern: "xadrez" }).appBgPattern, "");
});

test("o escurecer é contido entre 0 e o teto", () => {
  // Acima do teto o conteúdo perde contraste com o próprio fundo.
  assert.equal(theme.sanitize({ appBgDim: 200 }).appBgDim, theme.MAX_APP_BG_DIM);
  assert.equal(theme.sanitize({ appBgDim: -5 }).appBgDim, 0);
  assert.equal(theme.sanitize({ appBgDim: 35 }).appBgDim, 35);
});

test("a imagem do fundo entra na faxina, como as outras", () => {
  // Sem isto ela seria apagada do banco na gravação seguinte e viraria 404 —
  // exatamente o que aconteceu com a logo do menu.
  assert.ok(theme.IMAGE_FIELDS.includes("appBg"));
  assert.deepEqual(theme.imageUrls({ appBg: "u/9" }), ["u/9"]);
});

// ── A barra do navegador ─────────────────────────────────────────────────
//
// O ícone da aba e o que vai escrito nela.

test("o título da aba nasce como NOME FIXO", () => {
  // Uma aba que diz "Pessoas" não diz de quem. Com quinze abas abertas, o nome
  // é o que identifica.
  assert.equal(theme.sanitize({}).tabTitle, "fixed");
  assert.equal(theme.sanitize({}).tabName, "");
  assert.equal(theme.sanitize({}).favicon, "");
});

test("modo de fora da lista cai no nome fixo, e não em vazio", () => {
  // Uma aba SEMPRE tem título; não existe "sem título".
  assert.equal(theme.sanitize({ tabTitle: "sumido" }).tabTitle, "fixed");
});

test("o favicon entra na faxina de imagens", () => {
  // Sem isto ele seria apagado do banco na gravação seguinte e viraria 404 —
  // o mesmo que aconteceu com a logo do menu.
  assert.ok(theme.IMAGE_FIELDS.includes("favicon"));
  assert.deepEqual(theme.imageUrls({ favicon: "u/1" }), ["u/1"]);
});

test("o nome da aba tem teto — barra de navegador não é campo de texto", () => {
  assert.equal(theme.sanitize({ tabName: "x".repeat(200) }).tabName.length, 40);
});

// ── O link compartilhado ─────────────────────────────────────────────────
//
// O cartão que WhatsApp, LinkedIn e Google montam. Eles NÃO executam
// JavaScript: leem o HTML cru, e é a função de borda que o reescreve.

test("tudo vazio é o padrão do GoFitNow", () => {
  const t = theme.sanitize({});

  assert.equal(t.metaTitle, "");
  assert.equal(t.metaDescription, "");
  assert.equal(t.metaImage, "");
  assert.equal(t.metaRobots, "", "sem tag de robô é o que o app faz hoje");
  assert.equal(t.metaCard, "summary_large_image");
});

test("a descrição para no tamanho que os robôs leem", () => {
  // Guardar mais é guardar o que ninguém vê.
  assert.equal(theme.sanitize({ metaDescription: "x".repeat(500) }).metaDescription.length, 200);
  assert.equal(theme.sanitize({ metaTitle: "x".repeat(500) }).metaTitle.length, 70);
});

test("formato e robô fora da lista caem no padrão", () => {
  assert.equal(theme.sanitize({ metaCard: "gigante" }).metaCard, "summary_large_image");
  assert.equal(theme.sanitize({ metaRobots: "talvez" }).metaRobots, "");
});

test("a imagem de compartilhamento entra na faxina", () => {
  assert.ok(theme.IMAGE_FIELDS.includes("metaImage"));
});

test("cor de barra inválida vira vazio — vazio acompanha a marca", () => {
  assert.equal(theme.sanitize({ metaThemeColor: "azulzão" }).metaThemeColor, "");
});

test("apagar o fundo é contido, e o teto não é 100", () => {
  // Apagar por inteiro é o mesmo que não ter fundo — e aí a escolha certa é
  // "Sem fundo", que nem paga o download da imagem.
  assert.equal(theme.sanitize({ appBgFade: 300 }).appBgFade, theme.MAX_APP_BG_FADE);
  assert.ok(theme.MAX_APP_BG_FADE < 100);
  assert.equal(theme.sanitize({ appBgFade: -1 }).appBgFade, 0);
  assert.equal(theme.sanitize({}).appBgFade, 0);
});
