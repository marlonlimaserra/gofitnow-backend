const test = require("node:test");
const assert = require("node:assert/strict");

const instanceContext = require("../../lib/instance.js");
const arquivos = require("../../lib/arquivos.js");

// A CHAVE É A SEGURANÇA DESTE MÓDULO.
//
// Não há permissão dentro do R2: quem abre o bucket abre tudo. O que separa um
// cliente do outro é o PREFIXO da chave, e é por isso que ele sai do contexto da
// requisição e não de um argumento — a mesma decisão de `lib/escopo.js`.
//
// Enquanto o cliente é parâmetro, existe um lugar onde alguém passa o errado, e
// esse lugar é achado por um bug e não por uma revisão.

test("a chave do cliente começa pela INSTÂNCIA, e ela vem do contexto", async () => {
  await instanceContext.run("bruna", () => {
    assert.equal(
      arquivos.chaveDoCliente("avaliacoes", "68b1c0de1234567890abcdef", "frente"),
      "bruna/avaliacoes/68b1c0de1234567890abcdef/frente"
    );
  });

  // A MESMA chamada, noutro cliente, dá outra pasta. Não há argumento para
  // passar errado.
  await instanceContext.run("marlon", () => {
    assert.match(arquivos.chaveDoCliente("avatares", "u1"), /^marlon\//);
  });
});

test("fora de um contexto de instância, ESTOURA", () => {
  // Cair na raiz do bucket misturaria o arquivo com a pasta nossa, e ninguém
  // saberia de quem ele é. Melhor não gravar.
  assert.throws(() => arquivos.chaveDoCliente("avatares", "u1"));
});

test("o catálogo NOSSO tem pasta só dele", () => {
  // 130 MB de foto de alimento são os mesmos bytes para todo cliente. Numa pasta
  // por cliente, virariam 130 MB vezes o número de clientes.
  assert.equal(arquivos.chaveNossa("alimentos", "abc123"), "gofitnow/alimentos/abc123");
  assert.equal(arquivos.chaveNossa("clipes", "rosca-direta--mulher.webp"), "gofitnow/clipes/rosca-direta--mulher.webp");
});

test("a pasta nossa NÃO precisa de contexto — ela não é de cliente nenhum", () => {
  // A migração e o boot rodam fora de requisição. Se o catálogo exigisse
  // contexto, subir as fotos de alimento pediria um cliente inventado.
  assert.doesNotThrow(() => arquivos.chaveNossa("receitas", "x1"));
});

test("`..` e `/` num pedaço são RECUSADOS", async () => {
  // É o ataque: um id mal validado com `../outro-cliente` escreveria fora da
  // pasta. Recusar com erro, e não limpar em silêncio — um id que não passa
  // nesta régua é sintoma de outro defeito, e limpá-lo esconde a causa.
  await instanceContext.run("bruna", () => {
    for (const ruim of ["..", ".", "../marlon", "a/b", "/etc/passwd", "..%2F", "a b", ""]) {
      assert.throws(
        () => arquivos.chaveDoCliente("avaliacoes", ruim),
        undefined,
        `deveria recusar: ${JSON.stringify(ruim)}`
      );
    }
  });
});

test("pasta que não está na lista é recusada", () => {
  // Lista fechada pelo mesmo motivo da dos limites: um `avaliacaoes` gravado com
  // typo é um arquivo que ninguém acha e nada apaga.
  assert.throws(() => arquivos.chaveNossa("avaliacaoes", "x"));
  assert.throws(() => arquivos.chaveNossa("", "x"));
});

test("DESLIGADO, tudo devolve null — e ninguém quebra", async () => {
  // Sem as variáveis de ambiente o módulo não se liga, e quem chama cai no
  // caminho antigo (o banco). É o que permite este código estar em produção
  // antes de o bucket existir.
  assert.equal(arquivos.ligado(), false, "o teste roda sem R2 configurado");

  assert.equal(await arquivos.guardar("k", Buffer.from("x"), "image/png"), null);
  assert.equal(await arquivos.ler("k"), null);
  assert.equal(await arquivos.apagar("k"), false);
  assert.equal(await arquivos.apagarMuitas(["a", "b"]), 0);
});

test("o id do Mongo passa, que é o caso de todo dia", async () => {
  await instanceContext.run("bruna", () => {
    assert.doesNotThrow(() => arquivos.chaveDoCliente("marca", "507f1f77bcf86cd799439011"));
    // E o slug de clipe, com ponto e hífen.
    assert.doesNotThrow(() => arquivos.chaveNossa("clipes", "agachamento-com-barra--mulher.webp"));
  });
});

// ── OS BYTES ──────────────────────────────────────────────────────────────

test("um Buffer pequeno NÃO vira o pool de 8 KB do Node", async () => {
  // Este é o defeito que eu escrevi e um teste de e-mail pegou. `Buffer` também
  // tem `.buffer`, e ele aponta para o pool compartilhado do Node — não para os
  // bytes deste buffer. Testar `dado.buffer` antes de `Buffer.isBuffer` fazia
  // uma foto de 11 bytes virar 8 KB de lixo com a foto perdida no meio.
  const foto = Buffer.from("BYTESDAFOTO");
  assert.ok(foto.buffer.byteLength > foto.length, "o pool é maior — é o que causava o bug");

  const saiu = await arquivos.bytesDoDocumento({ data: foto });

  assert.equal(saiu.length, foto.length);
  assert.equal(saiu.toString(), "BYTESDAFOTO");
});

test("o BSON Binary do driver também sai certo", async () => {
  // É o formato que o Mongo devolve: um objeto com `.buffer` sendo um Buffer
  // exato. Aqui a cópia por `.buffer` é a correta — e é por isso que a ordem dos
  // `if` importa em vez de um deles bastar.
  const binario = { buffer: Buffer.from("DOBANCO"), sub_type: 0 };

  const saiu = await arquivos.bytesDoDocumento({ data: binario });
  assert.equal(saiu.toString(), "DOBANCO");
});

test("documento sem bytes e sem chave devolve null — a rota faz 404", async () => {
  assert.equal(await arquivos.bytesDoDocumento(null), null);
  assert.equal(await arquivos.bytesDoDocumento({}), null);
  assert.equal(await arquivos.bytesDoDocumento({ data: null }), null);
});

test("com chave e o R2 desligado, cai nos bytes do banco", async () => {
  // É o estado do meio da migração: o documento já tem chave, o R2 não responde
  // (ou nem está configurado), e o `data` ainda está lá. Servir a foto antiga é
  // melhor que servir erro.
  const saiu = await arquivos.bytesDoDocumento({
    chave: "bruna/marca/abc",
    data: Buffer.from("AINDA NO BANCO"),
  });

  assert.equal(saiu.toString(), "AINDA NO BANCO");
});
