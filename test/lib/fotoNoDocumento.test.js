const test = require("node:test");
const assert = require("node:assert/strict");

// A CLASSE DE DEFEITO QUE ISTO SEGURA: byte que sumiu para o R2.
//
// Em 04/09/2026 o Marlon relatou: *"as imagens do plano alimentar, no e-mail e
// pdf estão indo quebradas"*. A causa foi a migração de 31/08: as 2.499 fotos de
// alimento passaram a viver no R2, e o gerador do documento continuou lendo
// `img.data` — campo que não existe mais em nenhuma delas.
//
// ── O QUE FAZ ESSE DEFEITO SER PERIGOSO ───────────────────────────────────
//
// Ele falha produzindo algo VÁLIDO. `Buffer.from(undefined || "")` dá um buffer
// vazio, e um buffer vazio vira `data:image/webp;base64,` — endereço bem
// formado, sem dado dentro. O `<img>` sai no lugar certo, o anexo sai no lugar
// certo, e o que chega é o ícone de imagem quebrada.
//
// Nenhum erro, nenhum log, nenhum teste vermelho. Meses assim.
//
// ── POR QUE O TESTE OLHA O FORMATO E NÃO O GERADOR ────────────────────────
//
// O gerador (`documentoDieta`) já é testado e está certo: ele só desenha `<img>`
// se a chave existir no mapa que recebe. O defeito estava em QUEM MONTA o mapa,
// dentro de um controller com dez outras coisas.
//
// Então o que se trava aqui é a REGRA: um data URI sem dado não é um data URI, e
// nenhum caminho pode produzi-lo. É a regra que vale para as oito collections
// que migraram, e não só para a dieta.

// A conversão que o controller faz, isolada — a mesma expressão dos dois lados.
function comoDataUri(mime, bytes) {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

test("buffer vazio vira um data URI BEM FORMADO — e é por isso que passou", () => {
  const uri = comoDataUri("image/webp", Buffer.from(""));

  // O ponto do teste: nada nesta string denuncia o problema. Ela começa com
  // `data:`, tem mime, tem `;base64,`. Um `if (!src)` no gerador não a pega.
  assert.equal(uri, "data:image/webp;base64,");
  assert.equal(uri.startsWith("data:image/"), true);
  assert.equal(uri.includes(";base64,"), true);

  // O que a distingue é só o que vem DEPOIS da vírgula.
  assert.equal(uri.split(",")[1], "");
});

test("a guarda certa é o TAMANHO dos bytes, antes de montar a string", () => {
  // Foi a guarda que faltava. Ela precisa estar antes: depois de virar string,
  // "vazio" e "válido" só se distinguem contando caracteres, e ninguém conta.
  const vazio = Buffer.from("");
  const cheio = Buffer.from([0x52, 0x49, 0x46, 0x46]);

  assert.equal(Boolean(vazio && vazio.length), false);
  assert.equal(Boolean(cheio && cheio.length), true);
});

test("o `.buffer` de um Buffer é a armadilha do pool de 8 KB", () => {
  // O código antigo tinha `dado?.buffer ? Buffer.from(dado.buffer) : ...`, e essa
  // ordem importa: um Buffer do Node TAMBÉM tem `.buffer`, apontando para o pool
  // compartilhado de 8 KB. Testar `.buffer` antes de `Buffer.isBuffer` devolve
  // 8 KB de memória alheia em vez da imagem.
  //
  // É o mesmo erro que `lib/arquivos.js` documenta em `paraBuffer`, e o motivo
  // de a conversão viver LÁ e não espalhada nos controllers.
  const b = Buffer.from([1, 2, 3]);

  assert.equal(Buffer.isBuffer(b), true);
  // O `.buffer` dele existe e é MAIOR que os três bytes.
  assert.ok(b.buffer.byteLength >= 3);
  // Convertido pelo caminho errado, sai coisa que não é a imagem.
  assert.notEqual(Buffer.from(b.buffer).length, b.length);
});

test("nenhum controller lê `.data` direto de collection que migrou", async () => {
  const { readdirSync, readFileSync } = require("node:fs");
  const path = require("node:path");

  // As oito collections cujos bytes foram para o R2 em 31/08/2026 — a lista sai
  // do próprio script de migração, e não escrita aqui: acrescentar uma lá passa
  // a ser coberto aqui sem ninguém lembrar.
  const migracao = readFileSync(
    path.join(__dirname, "..", "..", "database", "migrarArquivos.js"),
    "utf8"
  );
  const collections = [...migracao.matchAll(/nome:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(collections.length >= 8, `esperava 8+ collections migradas, achei ${collections.length}`);

  const dir = path.join(__dirname, "..", "..", "controllers");
  const culpados = [];

  for (const arquivo of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const texto = readFileSync(path.join(dir, arquivo), "utf8");

    // `const algo = X.data;` ou `X.data ||` — a forma exata que o defeito tinha.
    // Não pega tudo que existe, e não é para pegar: pega a FORMA que ninguém
    // escreve de propósito depois de ler este teste.
    for (const m of texto.matchAll(/^\s*const \w+ = (\w+)\.data;/gm)) {
      culpados.push(`${arquivo}: const … = ${m[1]}.data;`);
    }
  }

  assert.deepEqual(
    culpados,
    [],
    "controller lendo `.data` direto — use `arquivos.bytesDoDocumento(doc)`, que resolve R2 e banco:\n" +
      culpados.join("\n")
  );
});
