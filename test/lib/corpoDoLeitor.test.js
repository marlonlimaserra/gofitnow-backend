const test = require("node:test");
const assert = require("node:assert");

const { lerCorpo, limpar } = require("../../lib/corpoDoLeitor.js");

// O CORPO DO LEITOR DA PORTA, LIDO COM TOLERÂNCIA.
//
// Este arquivo existe por um defeito que custou três dias (09/10/2026). O canal
// de monitor parecia mudo — a tela dizia "nenhum evento", o dono via a catraca
// não registrar ninguém, e eu procurei o problema no aparelho.
//
// O aparelho estava falando. Nós é que devolvíamos **HTTP 400**, três vezes a
// cada 30 segundos: 213 recusas no log do nginx e NENHUMA linha no log do app,
// porque o `bodyParser.json()` roda antes do registrador de requisições.
//
// A regra que estes casos prendem: **um evento de catraca não se perde por
// causa de um byte que não gostamos.** Do nosso lado, rigor no parsing não
// protege nada — quem manda já foi autenticado pela credencial do caminho, e a
// alternativa a um JSON torto não é um JSON certo: é a frequência do dia
// sumindo sem ninguém notar.
test("o corpo normal é lido como sempre", () => {
  assert.deepStrictEqual(lerCorpo('{"device_id":4409419584553886}'), {
    device_id: 4409419584553886,
  });
});

test("marca de ordem de bytes não derruba a batida", () => {
  // Firmware embarcado manda BOM na frente do JSON, e `JSON.parse` estoura.
  assert.deepStrictEqual(lerCorpo('﻿{"a":1}'), { a: 1 });
});

test("NUL de preenchimento no fim não derruba a batida", () => {
  // Buffer de tamanho fixo, preenchido com zeros — clássico de C embarcado.
  assert.deepStrictEqual(lerCorpo('{"a":1}\0\0\0'), { a: 1 });
});

test("vírgula pendurada não derruba a batida", () => {
  assert.deepStrictEqual(lerCorpo('{"a":1,}'), { a: 1 });
  assert.deepStrictEqual(lerCorpo('{"a":[1,2,]}'), { a: [1, 2] });
});

test("o JSON embrulhado em formulário ainda é lido", () => {
  // `application/x-www-form-urlencoded` com o JSON inteiro como chave: o corpo
  // chega como `{"a":1}=` e o parser de formulário não ajuda em nada.
  assert.deepStrictEqual(lerCorpo('%7B%22a%22%3A1%7D='), { a: 1 });
});

test("corpo vazio vira objeto vazio, e não erro", () => {
  assert.deepStrictEqual(lerCorpo(""), {});
  assert.deepStrictEqual(lerCorpo("   "), {});
  assert.deepStrictEqual(lerCorpo(null), {});
});

test("corpo ilegível vira objeto vazio — NUNCA uma exceção", () => {
  // Este é o caso que virava 400. A rota precisa rodar de qualquer jeito: ela
  // responde 200, e é o 200 que faz o aparelho parar de reenviar.
  assert.deepStrictEqual(lerCorpo("isto não é json de jeito nenhum"), {});
  assert.deepStrictEqual(lerCorpo("{quebrado"), {});
});

test("um JSON que não é objeto não vira objeto solto", () => {
  // `JSON.parse("4")` devolve número, e a rota espera poder ler `corpo.x`.
  assert.deepStrictEqual(lerCorpo("4"), { valor: 4 });
  assert.deepStrictEqual(lerCorpo('"texto"'), { valor: "texto" });
});

test("limpar não estraga o que já estava bom", () => {
  assert.strictEqual(limpar('{"a":1}'), '{"a":1}');
});

test("a vírgula dentro de um texto não é tocada", () => {
  // O remendo de vírgula é uma regex, e regex não entende aspas. Num corpo
  // VÁLIDO como este ela comeria a vírgula de dentro do texto e entregaria
  // `entrou}` — dado adulterado em silêncio, num registro de quem entrou na
  // academia. Por isso ela só roda DEPOIS que o parse honesto falha.
  //
  // Este caso já falhou uma vez, e foi assim que o remendo virou segunda
  // tentativa em vez de limpeza de entrada.
  assert.deepStrictEqual(lerCorpo('{"nota":"entrou,}"}'), { nota: "entrou,}" });
});

// ── O SEGREDO NÃO PODE SAIR NO LOG ────────────────────────────────────────
//
// A credencial do leitor viaja no CAMINHO, porque um leitor facial não manda
// cabeçalho. O registrador de requisições do `app.js` escrevia
// `req.originalUrl` inteiro — e com ele o segredo, de minuto em minuto, no log
// do pm2, nas DUAS credenciais (monitor e push).
//
// Guardamos só o hash no banco para que um vazamento de banco não entregue a
// credencial. De nada adianta se ela estiver em texto no log ao lado.
// Encontrado em 09/10/2026, lendo o log atrás da primeira batida que chegou.
const semSegredo = (url) => String(url).replace(/(\/cid\/[^./?#]+\.)[^/?#]+/, "$1…");

test("o log guarda a instância e esconde o segredo", () => {
  // A instância FICA: ela não é segredo (é nome de subdomínio) e é o que diz
  // de qual academia veio a linha.
  assert.strictEqual(semSegredo("/cid/marlon.ABCD.12345678901234/dao"), "/cid/marlon.…/dao");
});

test("a query não escapa do mascaramento", () => {
  assert.strictEqual(
    semSegredo("/cid/marlon.ABCD.12345678901234/push?deviceId=44094&uuid=abc"),
    "/cid/marlon.…/push?deviceId=44094&uuid=abc"
  );
});

test("caminho que não é do leitor passa intacto", () => {
  // Um mascarador que come URL demais torna o log inútil para o resto.
  assert.strictEqual(semSegredo("/people/123?x=1"), "/people/123?x=1");
  assert.strictEqual(semSegredo("/units"), "/units");
});
