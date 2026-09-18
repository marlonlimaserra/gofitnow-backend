const test = require("node:test");
const assert = require("node:assert/strict");

const iconify = require("../../lib/iconify.js");

// O ÍCONE VINDO DA ICONIFY, e o que o impede de ser um problema.
//
// *"tinha alguma biblioteca de icones que pesquisava na internet"*. O SVG
// buscado lá vai para o banco e, depois, INLINE dentro de uma página pública
// que abre no site de outra pessoa. É o pior lugar possível para markup que
// ninguém conferiu.
//
// A regra é RECUSAR, e não limpar: um sanitizador tenta adivinhar o que o
// navegador faz com o que sobrou, e erra justamente nos casos que importam.

test("aceita o que é DESENHO", () => {
  assert.equal(iconify.seguro('<path fill="currentColor" d="M1 2h3z"/>'), true);
  assert.equal(iconify.seguro('<circle cx="8" cy="8" r="4"/><rect width="2" height="2"/>'), true);
  assert.equal(
    iconify.seguro('<g><defs><linearGradient><stop offset="0"/></linearGradient></defs></g>'),
    true
  );
});

test("recusa o que EXECUTA", () => {
  for (const veneno of [
    '<script>alert(1)</script>',
    '<path onload="alert(1)" d="M0 0"/>',
    '<path ONCLICK="x" d="M0 0"/>',
    '<foreignObject><div>oi</div></foreignObject>',
    '<style>*{display:none}</style>',
  ]) {
    assert.equal(iconify.seguro(veneno), false, veneno);
  }
});

test("recusa o que CARREGA ou NAVEGA de fora", () => {
  // Um ícone que busca algo é um ícone que conta a alguém quem abriu a vitrine.
  for (const veneno of [
    '<image href="https://fora/x.png"/>',
    '<use xlink:href="#outro"/>',
    '<a href="https://fora"><path d="M0 0"/></a>',
    '<path d="M0 0" fill="url(javascript:alert(1))"/>',
  ]) {
    assert.equal(iconify.seguro(veneno), false, veneno);
  }
});

test("recusa comentário e CDATA — os dois escondem coisa de quem lê por regex", () => {
  assert.equal(iconify.seguro("<!-- <script>x</script> --><path d=\"M0 0\"/>"), false);
  assert.equal(iconify.seguro("<![CDATA[<script>x</script>]]>"), false);
});

test("recusa o vazio e o gigante", () => {
  assert.equal(iconify.seguro(""), false);
  assert.equal(iconify.seguro(null), false);
  assert.equal(iconify.seguro("<path d=\"" + "0".repeat(iconify.MAX_BYTES) + "\"/>"), false);
});

test("o NOME é conferido antes de virar endereço", () => {
  // Ele entra numa URL. Sem esta trava, um nome torto vira caminho para outro
  // lugar da API — ou para fora dela.
  assert.equal(iconify.NOME.test("mdi:shower"), true);
  assert.equal(iconify.NOME.test("material-symbols:pool-rounded"), true);

  for (const torto of [
    "../etc/passwd",
    "mdi:shower?x=1",
    "mdi:../outro",
    "MDI:Shower",
    "semdoispontos",
    "mdi:",
    ":shower",
    "mdi:shower/extra",
  ]) {
    assert.equal(iconify.NOME.test(torto), false, torto);
  }
});

test("nome invalido nem chega a virar requisicao", async () => {
  // `buscar` devolve null ANTES do fetch — o teste roda sem rede.
  assert.equal(await iconify.buscar("../etc/passwd"), null);
  assert.equal(await iconify.buscar(""), null);
  assert.equal(await iconify.buscar(null), null);
});
