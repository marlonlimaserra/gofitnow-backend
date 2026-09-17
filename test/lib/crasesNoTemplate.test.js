const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// A CRASE DENTRO DO TEMPLATE LITERAL — o erro que eu cometi QUATRO vezes.
//
// `lib/emailTemplates.js` monta HTML dentro de uma template string. Escrever um
// comentário HTML lá dentro é natural — é onde a explicação pertence —, e é
// natural citar código com crase, que é como se cita código em todo o resto do
// projeto. Só que ali a crase FECHA a string, e o arquivo deixa de ser
// JavaScript.
//
// O `node --check` pega, mas só depois de rodar. Este teste pega no `npm test`,
// junto de tudo, e diz exatamente onde.
//
// A regra: dentro do HTML, cite código com aspas ou sem nada.

// ── A LISTA É DESCOBERTA, e não escrita à mão ────────────────────────────
//
// Ela era `["lib/emailTemplates.js"]`, com um comentário dizendo "se outro
// arquivo passar a montar HTML assim, ele entra aqui". Nasceram quatro outros —
// os geradores de documento — e ninguém entrou. Em 17/09/2026 eu caí na mesma
// crase DUAS vezes no mesmo dia, em `lib/documentoBase.js`, e este teste passou
// verde as duas.
//
// Uma lista que depende de alguém lembrar não é uma trava, é uma esperança. O
// critério agora é o que define o risco: arquivo `.js` que contém comentário
// HTML. Se ele tem `<!--`, ele monta HTML — e se monta HTML em JavaScript, é
// dentro de template string.
const RAIZ = path.join(__dirname, "..", "..");
const PASTAS = ["lib", "helper", "controllers", "model"];

function varrer(dir) {
  const saida = [];
  if (!fs.existsSync(dir)) return saida;

  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...varrer(p));
    else if (e.name.endsWith(".js")) saida.push(p);
  }
  return saida;
}

const ARQUIVOS = PASTAS.flatMap((pasta) => varrer(path.join(RAIZ, pasta)))
  .filter((p) => fs.readFileSync(p, "utf8").includes("<!--"))
  .map((p) => path.relative(RAIZ, p))
  .sort();

function comentariosHtmlDe(texto) {
  return texto.match(/<!--[\s\S]*?-->/g) || [];
}

for (const arquivo of ARQUIVOS) {
  test(`${arquivo}: nenhum comentário HTML usa crase`, () => {
    const caminho = path.join(RAIZ, arquivo);
    const texto = fs.readFileSync(caminho, "utf8");

    const culpados = comentariosHtmlDe(texto)
      .filter((c) => c.includes("`"))
      .map((c) => c.slice(0, 90).replace(/\s+/g, " "));

    assert.deepEqual(
      culpados,
      [],
      "crase dentro de comentário HTML fecha a template string — cite com aspas"
    );
  });
}

test("e os arquivos continuam sendo JavaScript válido", () => {
  // O teste acima é sobre a CAUSA; este é sobre a consequência, e pega qualquer
  // outra forma de quebrar a string (um ${ solto, por exemplo).
  //
  // Vale para TODOS os descobertos, e não só para o e-mail: foi em
  // `lib/documentoBase.js` que a crase entrou duas vezes, e ele nem era olhado.
  for (const arquivo of ARQUIVOS) {
    assert.doesNotThrow(() => require(path.join(RAIZ, arquivo)), arquivo);
  }
});

test("a varredura está ACHANDO arquivo — uma lista vazia passaria calada", () => {
  // A lição do `idsConferir`: um conferidor que não pode reprovar devolve zero
  // para sempre e vira enfeite. Se a varredura parar de achar (pasta renomeada,
  // filtro quebrado), é aqui que aparece.
  assert.ok(ARQUIVOS.length >= 2, `achou só ${ARQUIVOS.length}: ${ARQUIVOS.join(", ")}`);
  assert.ok(ARQUIVOS.includes("lib/documentoBase.js"));
  assert.ok(ARQUIVOS.includes("lib/emailTemplates.js"));
});
