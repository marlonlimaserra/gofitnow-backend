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

// Onde HTML mora dentro de template string. Se outro arquivo passar a montar
// HTML assim, ele entra aqui.
const ARQUIVOS = ["lib/emailTemplates.js"];

function comentariosHtmlDe(texto) {
  return texto.match(/<!--[\s\S]*?-->/g) || [];
}

for (const arquivo of ARQUIVOS) {
  test(`${arquivo}: nenhum comentário HTML usa crase`, () => {
    const caminho = path.join(__dirname, "..", "..", arquivo);
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

test("e o arquivo continua sendo JavaScript válido", () => {
  // O teste acima é sobre a CAUSA; este é sobre a consequência, e pega qualquer
  // outra forma de quebrar a string (um ${ solto, por exemplo).
  assert.doesNotThrow(() => require("../../lib/emailTemplates.js"));
});
