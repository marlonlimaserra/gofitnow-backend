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
