const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// O PDF GUARDADO POR CONTEÚDO.
//
// Medido no servidor em 30/08/2026: gerar um PDF custa 532 ms, e o primeiro
// depois de o navegador fechar custa 4.545 ms. Comparado com os 1,7 ms de toda
// requisição autenticada, é a coisa mais cara desta máquina por três ordens de
// grandeza — e numa máquina de UM núcleo, esse meio segundo bloqueia todo mundo,
// não só quem pediu o PDF.
//
// O mesmo documento é gerado mais de uma vez: baixar, mandar por e-mail, baixar
// de novo depois de conferir.

const arquivo = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "pdf.js"), "utf8");

test("a chave é o RESUMO DO CONTEÚDO, não o id do documento", () => {
  // A diferença importa: o HTML já embute tudo que muda a folha — os dados, o
  // vocabulário da conta, a logo do cliente, o idioma de quem pediu, as fotos.
  // Mudou qualquer uma, o resumo muda e a chave nova nasce vazia.
  //
  // Assim NÃO EXISTE invalidação para esquecer, que é onde cache apodrece: não
  // há como servir um PDF velho, porque um PDF velho tem outra chave.
  assert.match(arquivo, /createHash\("sha256"\)/);
  assert.match(arquivo, /\.update\(String\(html\)\)/);

  // As opções entram na chave também: o mesmo HTML em paisagem é outro arquivo.
  assert.match(arquivo, /\.update\(JSON\.stringify\(opcoes/);
});

test("lê ANTES da fila, e de novo DENTRO dela", () => {
  // Fora da fila porque um acerto de cache não usa o navegador — enfileirá-lo
  // faria ele esperar o PDF de outra pessoa terminar.
  //
  // E de novo dentro porque dois pedidos do mesmo documento chegando juntos
  // passam os dois pela primeira leitura (o cache ainda está vazio). Sem a
  // segunda, o segundo geraria o que o primeiro acabou de guardar — e dois
  // cliques é o caso comum.
  const leituras = arquivo.match(/redis\.lerBytes\(/g) || [];
  assert.equal(leituras.length, 2, "são duas leituras, e cada uma tem uma razão");

  const antesDaFila = arquivo.indexOf("redis.lerBytes(");
  const fila = arquivo.indexOf("return enfileirar(");
  assert.ok(antesDaFila < fila, "a primeira leitura precisa vir antes da fila");
});

test("guardar NÃO é esperado", () => {
  // O PDF já está pronto para quem pediu; uma ida ao Redis não pode entrar no
  // tempo de resposta dele.
  assert.match(arquivo, /\n\s*redis\.guardarBytes\(chave, bytes, CACHE_MS\);/);
  assert.doesNotMatch(arquivo, /await redis\.guardarBytes/);
});

test("o navegador espera MUITO mais que os dois minutos de antes", () => {
  // Com 2 minutos e o uso esparso de hoje, quase todo PDF pagava os 4,5 s de
  // subir o navegador — que era exatamente o custo que reaproveitá-lo existia
  // para evitar.
  const m = /const OCIOSO_MS = (\d+) \* 60 \* 1000;/.exec(arquivo);
  assert.ok(m, "OCIOSO_MS sumiu ou mudou de forma");
  assert.ok(Number(m[1]) >= 15, `${m[1]} minutos é pouco para cobrir uma sessão de trabalho`);
});

test("sem Redis, o PDF continua saindo", async () => {
  // `REDIS_URL` não existe em teste, então `lerBytes` e `guardarBytes` devolvem
  // `null` — e o gerador tem de seguir como sempre seguiu. Um cache que vira
  // dependência é um cache que derruba o que ele deveria acelerar.
  const redis = require("../../lib/redis.js");

  assert.equal(await redis.lerBytes("qualquer"), null);
  assert.equal(await redis.guardarBytes("qualquer", Buffer.from("x"), 1000), null);
});

test("PDF gigante não entope a memória do Redis", async () => {
  // A avaliação com fotos é o caso grande. Acima do teto simplesmente não se
  // guarda: gerar de novo é lento, mas um item comendo o espaço de todos os
  // outros é pior para todo mundo.
  const redis = require("../../lib/redis.js");

  assert.ok(redis.TETO_POR_ITEM > 0);
  assert.equal(await redis.guardarBytes("grande", Buffer.alloc(redis.TETO_POR_ITEM + 1), 1000), null);
});
