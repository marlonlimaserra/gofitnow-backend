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
