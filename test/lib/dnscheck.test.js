const test = require("node:test");
const assert = require("node:assert/strict");

const { pointsTo } = require("../../lib/dnscheck.js");

const ALVO = "app.gofitnow.fit";

// Resolver de mentira: cada nome tem CNAME e/ou A, e o que não estiver na
// tabela estoura como o DNS de verdade estoura.
function fakeResolver(tabela) {
  const erro = (code) => Object.assign(new Error(code), { code });
  return {
    async resolveCname(nome) {
      const r = tabela[nome]?.cname;
      if (!r) throw erro("ENODATA");
      return r;
    },
    async resolve4(nome) {
      const r = tabela[nome]?.a;
      if (!r) throw erro("ENOTFOUND");
      return r;
    },
  };
}

test("CNAME apontando para o alvo passa", async () => {
  const resolver = fakeResolver({ "treinos.marlon.com.br": { cname: ["app.gofitnow.fit"] } });
  const r = await pointsTo("treinos.marlon.com.br", ALVO, { resolver });

  assert.equal(r.ok, true);
  assert.equal(r.via, "cname");
});

test("ponto final e maiúscula são o mesmo endereço", async () => {
  const resolver = fakeResolver({ "treinos.marlon.com.br": { cname: ["APP.GoFitNow.fit."] } });
  assert.equal((await pointsTo("Treinos.Marlon.com.br.", ALVO, { resolver })).ok, true);
});

test("na raiz do domínio, mesmos IPs que o alvo também passa", async () => {
  // A raiz não pode ter CNAME; o provedor achata em ALIAS e sobram só os IPs.
  // Exigir CNAME aqui diria "não apontou" para quem apontou certo.
  const resolver = fakeResolver({
    "marlon.com.br": { a: ["104.21.0.1", "172.67.0.1"] },
    [ALVO]: { a: ["172.67.0.1"] },
  });
  const r = await pointsTo("marlon.com.br", ALVO, { resolver });

  assert.equal(r.ok, true);
  assert.equal(r.via, "ip");
});

test("apontado para outro lugar reprova e diz para onde foi", async () => {
  const resolver = fakeResolver({
    "marlon.com.br": { cname: ["outro.servidor.com"], a: ["1.2.3.4"] },
    [ALVO]: { a: ["172.67.0.1"] },
  });
  const r = await pointsTo("marlon.com.br", ALVO, { resolver });

  assert.equal(r.ok, false);
  assert.equal(r.erro, "wrong_target");
  assert.equal(r.found, "outro.servidor.com", "a tela mostra o que achou, não só que falhou");
});

test("domínio que ainda não existe é 'não achei', não erro", async () => {
  const resolver = fakeResolver({ [ALVO]: { a: ["172.67.0.1"] } });
  const r = await pointsTo("aindanao.marlon.com.br", ALVO, { resolver });

  assert.equal(r.ok, false);
  assert.equal(r.erro, "not_found");
});

test("DNS fora do ar não derruba a rota", async () => {
  const resolver = {
    async resolveCname() { throw new Error("servidor de DNS mudo"); },
    async resolve4() { throw new Error("servidor de DNS mudo"); },
  };
  const r = await pointsTo("marlon.com.br", ALVO, { resolver });
  assert.equal(r.ok, false);
});

test("entrada vazia nem consulta", async () => {
  const resolver = { async resolveCname() { throw new Error("não podia ser chamado"); },
    async resolve4() { throw new Error("não podia ser chamado"); } };
  assert.equal((await pointsTo("", ALVO, { resolver })).erro, "invalid");
  assert.equal((await pointsTo("x.com", "", { resolver })).erro, "invalid");
});
