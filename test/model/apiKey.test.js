const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const ApiKey_model = require("../../model/ApiKey_model.js");

const model = new ApiKey_model({ crypto });

test("a chave gerada tem o rótulo do produto na frente", () => {
  // Um vazamento acidental fica reconhecível: um varredor de repositório sabe
  // que "gfn_" é credencial.
  const { key } = model.generate();
  assert.ok(key.startsWith("gfn_"), key.slice(0, 12));
});

test("a chave carrega o prefixo visível, e ele bate com o guardado", () => {
  const { prefix, key } = model.generate();
  assert.equal(key.split("_")[1], prefix);
  assert.equal(prefix.length, 8);
});

test("duas chaves nunca são iguais", () => {
  const geradas = new Set(Array.from({ length: 500 }, () => model.generate().key));
  assert.equal(geradas.size, 500);
});

test("o segredo tem 32 bytes: é o que dispensa salt no hash", () => {
  const segredo = model.generate().key.split("_")[2];
  assert.equal(segredo.length, 64, "32 bytes em hex são 64 caracteres");
});

test("a chave se separa em exatamente três partes", () => {
  // O segredo NÃO pode conter o separador, senão quem tentar dividir a chave
  // corta o segredo no meio. Foi por isso que ele deixou de ser base64url.
  for (let i = 0; i < 500; i++) {
    const partes = model.generate().key.split("_");
    assert.equal(partes.length, 3, `chave ambígua: ${partes.length} partes`);
  }
});

test("a chave é segura em URL, cabeçalho e linha de comando", () => {
  for (let i = 0; i < 200; i++) {
    assert.match(model.generate().key, /^gfn_[0-9a-f]{8}_[0-9a-f]{64}$/);
  }
});

test("o hash é estável: é assim que a verificação encontra a chave", () => {
  const { key } = model.generate();
  assert.equal(model.hash(key), model.hash(key));
});

test("chaves diferentes têm hashes diferentes", () => {
  assert.notEqual(model.hash(model.generate().key), model.hash(model.generate().key));
});

test("o hash não deixa a chave ser reconstruída", () => {
  const { key } = model.generate();
  const h = model.hash(key);

  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(key.split("_")[2]), "o segredo apareceu dentro do hash");
});

test("filter tira o hash do que vai para a tela", () => {
  const doc = { _id: "1", name: "Integração", prefix: "abcd1234", hash: "segredo", revokedAt: null };
  const out = model.filter(doc);

  assert.equal(out.hash, undefined);
  assert.equal(out.prefix, "abcd1234");
  assert.equal(out.revoked, false);
});

test("filter marca a chave revogada", () => {
  assert.equal(model.filter({ revokedAt: new Date() }).revoked, true);
});

test("filter passa reto por documento ausente", () => {
  assert.equal(model.filter(undefined), undefined);
});

test("verify recusa o que não tem cara de chave, sem ir ao banco", async () => {
  // Se fosse ao banco, `collection()` estouraria — o modelo aqui não tem mongodb.
  for (const v of [undefined, null, "", 123, {}, "chave-qualquer", "Bearer x"]) {
    assert.equal(await model.verify(v), undefined, JSON.stringify(v));
  }
});

test("o teto de chaves por conta é declarado", () => {
  assert.equal(ApiKey_model.MAXIMO_POR_CONTA, 10);
});
