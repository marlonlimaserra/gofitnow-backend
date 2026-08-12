const test = require("node:test");
const assert = require("node:assert/strict");

const instance = require("../../lib/instance.js");

// O nome da instância vira parte de um nome de DATABASE. É o dado mais
// perigoso do sistema: quem controla esse texto escolhe em qual banco a
// requisição escreve.
//
// Estes testes guardam duas coisas: o que é aceito como nome, e que ficar sem
// instância ESTOURA em vez de cair num banco padrão.

test("aceita um nome simples", () => {
  assert.equal(instance.normalize("marlon"), "marlon");
  assert.equal(instance.normalize("  Marlon  "), "marlon");
  assert.equal(instance.normalize("studio-2"), "studio-2");
});

test("recusa o que não pode virar nome de banco", () => {
  for (const ruim of [
    "",
    " ",
    "-comeca-com-hifen",
    "termina-com-hifen-",
    "com espaço",
    "com.ponto",
    "com/barra",
    "com$dolar",
    "acentuação",
    "under_score",
    "x".repeat(41),
    null,
    undefined,
    123,
    {},
  ]) {
    assert.equal(instance.normalize(ruim), null, JSON.stringify(ruim));
  }
});

test("nomes reservados não podem ser instância", () => {
  // `admin`, `local` e `config` são bancos do próprio Mongo; `center` é nosso.
  for (const r of ["admin", "local", "config", "center", "central"]) {
    assert.equal(instance.normalize(r), null, r);
  }
});

test("ponto e barra são recusados — eles trocariam o banco de destino", () => {
  // Um ponto no nome viraria outro database; uma barra sairia do nome.
  assert.equal(instance.normalize("marlon.outro"), null);
  assert.equal(instance.normalize("../admin"), null);
});

// ── De onde a instância vem numa requisição ────────────────────────────────

test("o cabeçalho X-Instance manda", () => {
  const req = { headers: { "x-instance": "Marlon" } };
  assert.equal(instance.fromRequest(req), "marlon");
});

test("o cabeçalho vence o host", () => {
  // O app roda em app.gofitnow.fit, que não é o endereço de ninguém: se o host
  // mandasse, o cabeçalho não teria como corrigir.
  const req = { headers: { "x-instance": "marlon", host: "outro.gofitnow.fit" } };
  assert.equal(instance.fromRequest(req), "marlon");
});

test("sem cabeçalho, o subdomínio serve", () => {
  assert.equal(instance.fromRequest({ headers: { host: "marlon.gofitnow.fit" } }), "marlon");
  assert.equal(instance.fromRequest({ headers: { host: "MARLON.gofitnow.fit:3030" } }), "marlon");
});

test("o host do produto NÃO é instância", () => {
  // Foi exatamente o que fez a cor voltar ao padrão no F5 quando o tema era
  // resolvido por host: app.gofitnow.fit não é de ninguém.
  for (const host of ["app.gofitnow.fit", "www.gofitnow.fit", "api.gofitnow.fit", "gofitnow.fit"]) {
    assert.equal(instance.fromRequest({ headers: { host } }), null, host);
  }
});

test("host de dois níveis não é instância", () => {
  assert.equal(instance.fromRequest({ headers: { host: "a.b.gofitnow.fit" } }), null);
});

test("domínio de fora não vira instância pelo host", () => {
  // `treinos.marlon.com.br` é domínio próprio: quem resolve é o registro
  // central, não o formato do nome.
  assert.equal(instance.fromRequest({ headers: { host: "treinos.marlon.com.br" } }), null);
});

test("a query serve de último recurso, para curl", () => {
  assert.equal(instance.fromRequest({ headers: {}, query: { instance: "marlon" } }), "marlon");
});

test("requisição sem nada devolve null — quem decide o que fazer é o middleware", () => {
  assert.equal(instance.fromRequest({ headers: {} }), null);
  assert.equal(instance.fromRequest(undefined), null);
});

// ── O contexto ─────────────────────────────────────────────────────────────

test("dentro do escopo, current() devolve a instância", () => {
  instance.run("marlon", () => {
    assert.equal(instance.current(), "marlon");
    assert.equal(instance.required(), "marlon");
  });
});

test("a instância sobrevive ao await", async () => {
  // É o ponto do AsyncLocalStorage: sem isso, tudo depois do primeiro await
  // leria o banco errado.
  await instance.run("marlon", async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(instance.current(), "marlon");
  });
});

test("dois escopos ao mesmo tempo não se misturam", async () => {
  // Duas requisições de clientes diferentes rodando juntas é o caso normal, e
  // é onde uma variável global teria vazado uma na outra.
  const [a, b] = await Promise.all([
    instance.run("marlon", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return instance.current();
    }),
    instance.run("outro", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return instance.current();
    }),
  ]);

  assert.equal(a, "marlon");
  assert.equal(b, "outro");
});

test("FORA do escopo, required() estoura em vez de cair num banco padrão", () => {
  // É a regra mais importante daqui. Um undefined que virasse "o banco de
  // sempre" faria uma rota sem instância ler dados de alguém, em silêncio.
  assert.equal(instance.current(), undefined);
  assert.throws(() => instance.required(), /no_instance_in_context/);
});

test("escopo aninhado troca a instância só dentro dele", () => {
  // É como as rotas abertas fazem: elas rodam sem instância e abrem um escopo
  // curto para ler o banco de um cliente específico.
  instance.run("marlon", () => {
    instance.run("outro", () => {
      assert.equal(instance.current(), "outro");
    });
    assert.equal(instance.current(), "marlon");
  });
});
