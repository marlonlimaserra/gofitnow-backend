const test = require("node:test");
const assert = require("node:assert/strict");

const { digitos, chave, mesmoTelefone } = require("../../lib/telefone.js");

// COMPARAR TELEFONES DIGITADOS POR PESSOAS DIFERENTES.
//
// Nasceu para a inscrição pelo WhatsApp: quem chega na página do aulão digita o
// número, e o sistema precisa saber se essa pessoa já é aluna do estúdio.
//
// ── O que estes testes impedem, e são duas coisas OPOSTAS ────────────────
//
//   não casar o que é igual  → cria um aluno DUPLICADO do próprio cliente, com
//                              o histórico dele partido em dois;
//   casar o que é diferente  → inscreve a pessoa ERRADA numa aula, com cobrança.
//
// O segundo é pior, e é por isso que a regra erra para o lado de perguntar.

test("os formatos do mesmo número casam", () => {
  const formas = [
    "11987650001",
    "(11) 98765-0001",
    "11 98765-0001",
    "+55 11 98765-0001",
    "+5511987650001",
    "011987650001",
    "55 (11) 98765.0001",
  ];

  // Todos contra todos: a igualdade tem de ser transitiva, senão a resposta
  // depende de quem foi digitado primeiro.
  for (const a of formas) {
    for (const b of formas) {
      assert.ok(mesmoTelefone(a, b), `${a} ≠ ${b}`);
    }
  }
});

test("número SEM DDD não casa com número COM DDD", () => {
  // A decisão central. Casaria se a regra comparasse os últimos nove dígitos —
  // e aí "98765-0001" de São Paulo casaria com o mesmo número em Belém.
  assert.equal(mesmoTelefone("98765-0001", "11987650001"), false);
  assert.equal(mesmoTelefone("987650001", "(11) 98765-0001"), false);
});

test("números diferentes não casam", () => {
  assert.equal(mesmoTelefone("11987650001", "11987650002"), false);
  assert.equal(mesmoTelefone("11987650001", "21987650001"), false);
});

// O 55 é código de país E é o DDD do Maranhão. Tirá-lo sempre transformaria um
// fixo de lá em outro número — e ele passaria a casar com o de outra pessoa.
test("o DDD 55 não é confundido com o código do país", () => {
  assert.equal(chave("5598765000"), "5598765000");
  // "+55 55 98765-0001": treze dígitos. O 55 da FRENTE é o país e sai; o
  // segundo 55 é o DDD e fica.
  assert.equal(chave("+55 55 98765-0001"), "55987650001");
});

test("vazio nunca casa — nem com outro vazio", () => {
  // Duas fichas sem telefone não são a mesma pessoa. Tratá-las como iguais faria
  // a primeira inscrição sem número adotar qualquer ficha vazia do banco.
  assert.equal(mesmoTelefone("", ""), false);
  assert.equal(mesmoTelefone(null, undefined), false);
  assert.equal(mesmoTelefone("11987650001", ""), false);
  assert.equal(mesmoTelefone("abc", "def"), false);
});

test("digitos tira tudo que não é número, sem estourar", () => {
  assert.equal(digitos("(11) 98765-0001"), "11987650001");
  assert.equal(digitos(null), "");
  assert.equal(digitos(undefined), "");
  assert.equal(digitos(11987650001), "11987650001");
});

test("chave é estável: aplicá-la duas vezes dá o mesmo", () => {
  // Importa porque o valor comparado pode vir de um campo já normalizado no
  // futuro — e uma função que muda o próprio resultado criaria duas verdades.
  for (const v of ["+55 (11) 98765-0001", "011987650001", "5598765000"]) {
    assert.equal(chave(chave(v)), chave(v));
  }
});
