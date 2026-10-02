const test = require("node:test");
const assert = require("node:assert/strict");

const nome = require("../../lib/nomeDaPessoa.js");

// NOME E SOBRENOME — *"acho melhor agente trabalhar com 'nome' e 'sobrenome'"*
// (01/10/2026).
//
// O que estes casos guardam é a forma da mudança: `name` é DERIVADO, nunca
// perdido, e a separação atende tanto quem digita dois campos quanto quem
// continua mandando o nome inteiro numa linha só.

test("o sobrenome é o RESTO, e não a última palavra", () => {
  // "Marlon Lima Serra" com sobrenome "Serra" perderia "Lima" para sempre.
  assert.deepEqual(nome.separar("Marlon Lima Serra"), {
    firstName: "Marlon",
    lastName: "Lima Serra",
  });
});

test("quem tem um nome só não ganha sobrenome inventado", () => {
  assert.deepEqual(nome.separar("Madonna"), { firstName: "Madonna", lastName: "" });
});

test("espaços repetidos não viram sobrenome começando com espaço", () => {
  // Um nome colado de duas colunas de planilha chega exatamente assim.
  assert.deepEqual(nome.separar("  Ana   Beatriz  Costa "), {
    firstName: "Ana",
    lastName: "Beatriz Costa",
  });
});

test("vazio não estoura", () => {
  for (const v of [undefined, null, "", "   "]) {
    assert.deepEqual(nome.separar(v), { firstName: "", lastName: "" });
  }
});

test("montar não deixa espaço pendurado quando não há sobrenome", () => {
  // O espaço entraria no `nameSort`, na ordenação da lista e no nome do arquivo
  // de um PDF.
  assert.equal(nome.montar("Marlon", ""), "Marlon");
  assert.equal(nome.montar("Marlon", "   "), "Marlon");
  assert.equal(nome.montar("", "Lima"), "Lima");
});

test("paraGravar devolve as TRÊS chaves quando vêm as partes", () => {
  assert.deepEqual(nome.paraGravar({ firstName: " Marlon ", lastName: " Lima " }), {
    firstName: "Marlon",
    lastName: "Lima",
    name: "Marlon Lima",
  });
});

test("paraGravar separa quando vem só o nome inteiro", () => {
  // É o caminho da planilha, da página pública e do app antigo — eles não
  // sabem que o campo virou dois, e continuam funcionando.
  assert.deepEqual(nome.paraGravar({ name: "Ana Costa" }), {
    firstName: "Ana",
    lastName: "Costa",
    name: "Ana Costa",
  });
});

test("as partes VENCEM o nome inteiro quando os dois vêm juntos", () => {
  // O formulário manda os três (ele carregou a ficha e devolve o que leu). Se
  // `name` vencesse, editar o sobrenome não teria efeito nenhum.
  const r = nome.paraGravar({ name: "Marlon Lima", firstName: "Marlon", lastName: "Lima Serra" });
  assert.equal(r.name, "Marlon Lima Serra");
});

test("não mandar nome é diferente de mandar vazio", () => {
  // Num PATCH, `null` quer dizer "não mexa no nome"; `{ name: "" }` quer dizer
  // "apague", e tem de ser recusado por quem chama.
  assert.equal(nome.paraGravar({}), null);
  assert.deepEqual(nome.paraGravar({ name: "" }), { firstName: "", lastName: "", name: "" });
});

test("sobrenome sozinho é aceito — e `name` sai sem espaço na frente", () => {
  assert.deepEqual(nome.paraGravar({ firstName: "", lastName: "Lima" }), {
    firstName: "",
    lastName: "Lima",
    name: "Lima",
  });
});

// ── EDITAR UMA PARTE NÃO PODE APAGAR A OUTRA ─────────────────────────────
//
// Defeito encontrado editando em produção, não em teste: um PUT com só
// `{ lastName }` — arrumar o sobrenome, que é a edição mais comum — devolvia
// `firstName: ""`. A pessoa perdia o próprio nome ao corrigir o sobrenome.
test("mandar só o sobrenome preserva o nome que já está gravado", () => {
  const r = nome.paraGravar({ lastName: "Costa Lima" }, { firstName: "Ana", lastName: "Beatriz" });
  assert.deepEqual(r, { firstName: "Ana", lastName: "Costa Lima", name: "Ana Costa Lima" });
});

test("mandar só o nome preserva o sobrenome", () => {
  const r = nome.paraGravar({ firstName: "Ana Paula" }, { firstName: "Ana", lastName: "Costa" });
  assert.equal(r.name, "Ana Paula Costa");
});

test("na ficha ANTIGA, a parte que falta sai do `name` inteiro", () => {
  // Quem ainda não passou pela migração não tem `firstName` gravado.
  const r = nome.paraGravar({ lastName: "Serra" }, { name: "Marlon Lima" });
  assert.deepEqual(r, { firstName: "Marlon", lastName: "Serra", name: "Marlon Serra" });
});

test("mandar a parte VAZIA de propósito ainda apaga — é diferente de não mandar", () => {
  // Quem tem um nome só precisa poder limpar o sobrenome.
  const r = nome.paraGravar({ lastName: "" }, { firstName: "Madonna", lastName: "Ciccone" });
  assert.deepEqual(r, { firstName: "Madonna", lastName: "", name: "Madonna" });
});
