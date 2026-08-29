const test = require("node:test");
const assert = require("node:assert");

const { documentoAvaliacao, escapar, formatarData } = require("../../lib/documentoAvaliacao.js");

// O DOCUMENTO DA AVALIAÇÃO, montado no servidor.
//
// Ele existe porque o Marlon pediu que o PDF fosse "um HTML gerado direto no
// backend, assim garantimos que vai ser igual no web e no app". O que estes testes
// seguram é o que faz esse desenho valer: o documento tem de ser AUTOSSUFICIENTE
// (vai para e-mail, para o `expo-print` e para disco) e não pode confiar em nada
// que venha do banco sem escapar.

const COLETA = {
  _id: "a1",
  date: "2026-08-20T00:00:00.000Z",
  weight: 78.4,
  height: 1.78,
  method: "skinfolds",
  protocol: "pollock3",
  skinfolds: { triceps: 18, suprailiac: 20, thigh: 26 },
  circumferences: { waist: 82, hip: 98 },
  note: "Manter o volume.",
};

const PESSOA = { name: "Bruna Alves", sex: "female", birthDate: "1994-02-01" };

const base = (extra = {}) =>
  documentoAvaliacao({
    assessment: COLETA,
    person: PESSOA,
    photoSides: [{ key: "front" }],
    lang: "pt-BR",
    fuso: "America/Sao_Paulo",
    ...extra,
  });

test("os rótulos saem traduzidos, não como chave", () => {
  const html = base();

  assert.match(html, /Peso/);
  assert.match(html, /Dobras cutâneas/);
  // Chave crua na folha é o sintoma de espelho de tradução desatualizado.
  assert.ok(!/>assessments\./.test(html), "sobrou chave crua no HTML");
});

test("as contas são as MESMAS do site — vêm do espelho", () => {
  const html = base();

  // 78.4 kg com 1,78 m dá IMC 24.74; Pollock 3 dobras (mulher) dá 25.54%.
  assert.match(html, /24\.74/);
  assert.match(html, /25\.54/);
});

// ── AUTOSSUFICIENTE ───────────────────────────────────────────────────────
//
// Um HTML que precisa buscar arquivo não sobrevive a nenhuma das saídas: no
// e-mail o cliente bloqueia, no `expo-print` não há origem, e salvo em disco vira
// folha sem foto.
test("não busca nada de fora: sem <link>, sem <script>, sem src http", () => {
  const html = base({ imagens: { front: "data:image/jpeg;base64,AAAA" } });

  assert.ok(!/<link\b/i.test(html), "tem <link>");
  assert.ok(!/<script\b/i.test(html), "tem <script>");
  assert.ok(!/src="https?:/i.test(html), "tem src apontando para fora");
  assert.match(html, /src="data:image\/jpeg;base64,AAAA"/);
});

test("estilo é INLINE — cliente de e-mail apaga <style>", () => {
  assert.ok(!/<style\b/i.test(base()), "tem bloco <style>");
});

// ── O QUE VEM DO BANCO NÃO ENTRA CRU ──────────────────────────────────────
test("nome e observação são escapados", () => {
  const html = documentoAvaliacao({
    assessment: { ...COLETA, note: '<script>alert(1)</script>' },
    person: { ...PESSOA, name: 'Ana <b>"Teste"</b>' },
    photoSides: [],
    lang: "pt-BR",
  });

  assert.ok(!/<script>alert/.test(html), "injetou script pela observação");
  assert.match(html, /Ana &lt;b&gt;/);
});

test("escapar cobre os quatro caracteres que quebram HTML", () => {
  assert.equal(escapar('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.equal(escapar(null), "");
});

// ── A DATA NO FUSO DA CONTA ───────────────────────────────────────────────
//
// O servidor roda em UTC. Sem o fuso, uma coleta das 21h de São Paulo sai com a
// data do dia seguinte — e a folha mostra um dia em que a pessoa não veio.
test("coleta com HORA usa o fuso da conta", () => {
  // 2026-08-21T00:30Z é ainda dia 20 em São Paulo.
  assert.equal(formatarData("2026-08-21T00:30:00.000Z", "pt-BR", "America/Sao_Paulo"), "20/08/2026");
});

test("coleta sem hora é um DIA, e não anda com o fuso", () => {
  // Meia-noite UTC quer dizer "dia 20", não um instante — formatar no fuso
  // devolveria 19/08 e a folha mostraria a véspera.
  assert.equal(formatarData("2026-08-20T00:00:00.000Z", "pt-BR", "America/Sao_Paulo"), "20/08/2026");
});

// ── SÓ O QUE FOI PREENCHIDO ───────────────────────────────────────────────
test("grupo sem nenhuma medida não vira seção vazia", () => {
  const html = base();

  assert.match(html, /Circunferências/);
  // `tests` e `bioimpedance` não foram preenchidos nesta coleta.
  assert.ok(!/Testes físicos/.test(html), "imprimiu grupo vazio");
});

test("campo que não existe no grupo é ignorado, não inventado", () => {
  // `arm` não é campo de circunferências (os reais são `armRightRelaxed` etc.).
  const html = documentoAvaliacao({
    assessment: { ...COLETA, circumferences: { waist: 82, arm: 34.5 } },
    person: PESSOA,
    photoSides: [],
  });

  assert.ok(!/34\.5/.test(html), "imprimiu um campo que o grupo não tem");
});

test("sem coleta anterior, não sai tabela de comparativo", () => {
  assert.ok(!/Comparativo/.test(base()));
});

test("com coleta anterior, as duas colunas aparecem", () => {
  const html = base({
    previous: { date: "2026-05-12T00:00:00.000Z", weight: 82.1, height: 1.78 },
  });

  assert.match(html, /Comparativo/);
  assert.match(html, /12\/05\/2026/);
  assert.match(html, /82\.1/);
});

// ── AS FOTOS, NO FIM ──────────────────────────────────────────────────────
test("as fotos vêm depois das medidas e da observação", () => {
  const html = base({ imagens: { front: "data:image/jpeg;base64,AAAA" } });

  assert.ok(html.indexOf("Fotos de evolução") > html.indexOf("Observação"), "foto antes da observação");
});

test("ângulo sem imagem não deixa vaga vazia na folha", () => {
  const html = base({ photoSides: [{ key: "front" }, { key: "back" }], imagens: { front: "data:image/jpeg;base64,AAAA" } });

  assert.match(html, /Frente/);
  assert.ok(!/Costas/.test(html), "desenhou vaga de foto que não existe");
});

test("sem foto nenhuma, a seção não existe", () => {
  assert.ok(!/Fotos de evolução/.test(base({ imagens: {} })));
});

// O idioma é o de quem LÊ. Sem catálogo para ele, cai no padrão em vez de sair
// com as chaves à mostra.
test("idioma desconhecido cai no padrão, não quebra", () => {
  const html = documentoAvaliacao({ assessment: COLETA, person: PESSOA, photoSides: [], lang: "de" });
  assert.match(html, /Peso/);
});

test("em inglês, os rótulos mudam", () => {
  const html = documentoAvaliacao({ assessment: COLETA, person: PESSOA, photoSides: [], lang: "en" });
  assert.match(html, /Weight/);
});

// ── A LOGO NO CABEÇALHO (29/08/2026) ──────────────────────────────────────
//
// Pedido: *"coloca a nossa logo também, no e-mail, no PDF etc… precisamos
// divulgar a marca"*.
test("a logo entra no cabeçalho quando é passada", () => {
  const html = base({ marca: "data:image/png;base64,AAAA" });

  assert.match(html, /<img src="data:image\/png;base64,AAAA"/);
});

test("a logo NÃO depende de cor de fundo do CSS", () => {
  // O wordmark tem o "FitNow" em branco e precisa de fundo escuro. Ele já vem
  // ASSADO no PNG: como `background` do CSS, sumia ao imprimir — navegador não
  // imprime cor de fundo por padrão, e a logo saía invisível no papel.
  const html = base({ marca: "data:image/png;base64,AAAA" });

  assert.doesNotMatch(html, /background:#0f172a[^"]*"[^>]*>\s*<img/);
});

test("a logo leva `height` como ATRIBUTO — cliente de e-mail ignora o estilo", () => {
  const html = base({ marca: "data:image/png;base64,AAAA" });

  assert.match(html, /<img[^>]*height="\d+"/);
});

test("sem logo, o cabeçalho continua inteiro", () => {
  const html = base({ marca: null });

  assert.doesNotMatch(html, /<img src="data:image\/png/);
  assert.match(html, /Marlon|assessments|Avaliação/i);
});
