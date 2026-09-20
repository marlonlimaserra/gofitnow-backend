const test = require("node:test");
const assert = require("node:assert/strict");

const { limpar, enderecoSeguro, estiloSeguro } = require("../../lib/htmlSeguro.js");

// O HTML DO TERMO, limpo antes de virar documento.
//
// *"coloque um editor de HTML para ele poder colar e editar o documento"*.
//
// Este arquivo é o que sustenta a decisão de aceitar HTML escrito por gente. O
// termo é exibido num quadro que carrega HTML NOSSO — script ali roda na nossa
// origem, com a sessão de quem abriu.

test("o texto formatado passa inteiro", () => {
  // A peneira não pode custar o que o editor existe para fazer.
  const html = "<h2>Termo</h2><p>Eu, <b>fulano</b>, <i>declaro</i>.</p><ul><li>um</li></ul>";
  assert.equal(limpar(html), html);
});

test("tabela com atributos de layout sobrevive — é como o Word cola", () => {
  const html = '<table border="1"><tr><td colspan="2">a</td></tr></table>';
  assert.equal(limpar(html), html);
});

test("o `style` fica: sem ele o documento colado perde a formatação", () => {
  assert.match(limpar('<p style="text-align:center">x</p>'), /text-align:center/);
});

// ── O QUE NÃO PODE PASSAR ────────────────────────────────────────────────

test("`<script>` some COM o miolo", () => {
  // Deixar o miolo viraria o código impresso no meio do termo.
  assert.equal(limpar("<script>alert(1)</script><p>ok</p>"), "<p>ok</p>");
  assert.equal(limpar("<p>ok</p><script>roubar()</script>"), "<p>ok</p>");
});

test("`<style>`, `<iframe>`, `<object>` e `<embed>` também", () => {
  for (const tag of ["style", "iframe", "object", "embed", "noscript", "template"]) {
    const sujo = `<${tag}>miolo</${tag}><p>vive</p>`;
    assert.equal(limpar(sujo), "<p>vive</p>", tag);
  }
});

test("TODO atributo `on*` sai, declarado ou não", () => {
  // É a família inteira de execução, e ela cresce a cada versão de navegador —
  // por isso a regra é o prefixo, e não uma lista.
  for (const attr of ["onclick", "onerror", "onmouseover", "onfocus", "oninvento"]) {
    assert.equal(limpar(`<p ${attr}="alert(1)">x</p>`), "<p>x</p>", attr);
  }
});

test("`javascript:` num link vira link sem endereço", () => {
  assert.equal(limpar('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
  assert.equal(limpar('<a href="vbscript:msgbox">x</a>'), "<a>x</a>");
});

test("espaço e caractere de controle NÃO escondem o esquema", () => {
  // `java\tscript:` é lido pelo navegador como o esquema que se está barrando.
  assert.equal(enderecoSeguro("java\tscript:alert(1)"), "");
  assert.equal(enderecoSeguro("java\nscript:alert(1)"), "");
  assert.equal(enderecoSeguro("  JaVaScRiPt:alert(1)"), "");
});

test("`data:` só passa como IMAGEM — e nunca SVG", () => {
  // `data:text/html` num quadro herda a origem de quem o abriu. SVG é documento
  // executável com cara de imagem.
  assert.ok(enderecoSeguro("data:image/png;base64,AAAA", true));
  assert.equal(enderecoSeguro("data:text/html;base64,AAAA", true), "");
  assert.equal(enderecoSeguro("data:image/svg+xml;base64,AAAA", true), "");
  // Em `href` nenhum `data:` passa.
  assert.equal(enderecoSeguro("data:image/png;base64,AAAA", false), "");
});

test("tag fora da lista some, e o texto dela fica", () => {
  // `<svg onload>` é o caso clássico: a tag some, e com ela o atributo.
  assert.equal(limpar("<svg onload=alert(1)></svg>"), "");
  assert.equal(limpar("<form action='x'><p>texto</p></form>"), "<p>texto</p>");
  assert.equal(limpar("<marquee>corre</marquee>"), "corre");
});

test("`expression()` e `@import` derrubam o estilo inteiro", () => {
  assert.equal(estiloSeguro("width: expression(alert(1))"), "");
  assert.equal(estiloSeguro("@import url(x)"), "");
  assert.equal(estiloSeguro("behavior: url(#x)"), "");
});

test("`position: fixed` sai, e o resto do estilo fica", () => {
  // Um documento que gruda na tela sobrepõe a interface de quem o revisa.
  const limpo = estiloSeguro("color: red; position: fixed; font-size: 12px");
  assert.ok(!/fixed/.test(limpo));
  assert.match(limpo, /color: red/);
  assert.match(limpo, /font-size: 12px/);
});

test("link que abre fora ganha `rel`", () => {
  // Sem ele a página aberta ganha `window.opener` e pode trocar a nossa de
  // endereço.
  assert.match(limpar('<a href="https://x.com" target="_blank">x</a>'), /rel="noopener noreferrer"/);
});

test("comentário some — o `<!--[if IE]>` do Word guarda markup dentro", () => {
  assert.equal(limpar("<!--[if IE]><script>x()</script><![endif]--><p>ok</p>"), "<p>ok</p>");
});

test("aspas no valor de um atributo não escapam do atributo", () => {
  // O ataque é fechar a aspa e começar um atributo novo. A defesa é escapar,
  // e não apagar: a palavra "onclick" CONTINUA na saída — como texto dentro do
  // `title`, que é inofensivo e é o que a pessoa escreveu.
  //
  // Afirmar `!/onclick/` seria exigir que o sanitizador censurasse texto, e
  // passaria a falhar no dia em que alguém escrevesse a palavra num termo.
  const saida = limpar("<p title='a\" onclick=\"alert(1)'>x</p>");

  // A saída inteira, porque aqui o que importa é a forma exata: a aspa virou
  // `&quot;`, então o que parecia um atributo novo continua dentro do valor.
  assert.equal(saida, '<p title="a&quot; onclick=&quot;alert(1)">x</p>');

  // E a prova do que o ataque queria: não existe uma aspa CRUA fechando o
  // valor antes do fim dele.
  assert.ok(!/title="[^"]*"\s+\w+=/.test(saida), saida);
});

test("entrada vazia não estoura", () => {
  for (const v of ["", null, undefined, 0]) assert.equal(limpar(v), "");
});
