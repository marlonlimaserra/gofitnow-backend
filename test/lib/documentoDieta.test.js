const { test, describe } = require("node:test");
const assert = require("node:assert");

const { documentoDieta, marcarAlternativas } = require("../../lib/documentoDieta.js");

// O DOCUMENTO DO PLANO ALIMENTAR.
//
// Ele vai por e-mail, vira PDF e é impresso — e nas três a pessoa que lê está
// longe de quem poderia corrigir. Um erro aqui não aparece na tela de ninguém:
// aparece na folha que o cliente levou para casa.

const PESSOA = { name: "Ana Souza" };

const DIETA = {
  name: "Cutting — semana 1",
  goal: "Emagrecimento",
  totals: { kcal: 1885, protein: 148.5, carbs: 190.2, fat: 55.4 },
  targetKcal: 2000,
  meals: [
    {
      time: "07:00",
      name: "Café da manhã",
      totals: { kcal: 420, protein: 32, carbs: 45, fat: 10 },
      foods: [
        { name: "Ovo cozido", quantity: 2, unit: "unidade", kcal: 140, group: null },
        { name: "Pão de forma", quantity: 50, unit: "g", kcal: 130, group: 1 },
        { name: "Tapioca", quantity: 60, unit: "g", kcal: 128, group: 1 },
      ],
    },
  ],
};

const gerar = (extra = {}) => documentoDieta({ diet: { ...DIETA, ...extra }, person: PESSOA, lang: "pt-BR" });

describe("quem conta e quem é alternativa", () => {
  test("o primeiro de cada grupo é o principal; os seguintes, alternativas", () => {
    const r = marcarAlternativas([
      { name: "a", group: 1 },
      { name: "b", group: 1 },
      { name: "c", group: 1 },
    ]);

    assert.deepStrictEqual(r.map((f) => f.principal), [true, false, false]);
  });

  test("alimento sem grupo vale por si — nunca vira alternativa de outro", () => {
    // É o caso de tudo que foi gravado antes de existir substituição. Tratar
    // `null` como um grupo comum juntaria alimentos que nada têm a ver, e
    // sumiria com eles da conta.
    const r = marcarAlternativas([
      { name: "a", group: null },
      { name: "b", group: null },
      { name: "c" },
    ]);

    assert.deepStrictEqual(r.map((f) => f.principal), [true, true, true]);
  });

  test("grupos diferentes não se misturam", () => {
    const r = marcarAlternativas([
      { name: "a", group: 1 },
      { name: "b", group: 2 },
      { name: "c", group: 1 },
    ]);

    assert.deepStrictEqual(r.map((f) => f.principal), [true, true, false]);
  });

  test("grupo zero não é confundido com ausência de grupo", () => {
    // `0` é um grupo legítimo, e `!f.group` o trataria como solto — as duas
    // opções contariam, e o total do dia sairia inflado.
    const r = marcarAlternativas([
      { name: "a", group: 0 },
      { name: "b", group: 0 },
    ]);

    assert.deepStrictEqual(r.map((f) => f.principal), [true, false]);
  });
});

describe("a folha", () => {
  test("traz os rótulos resolvidos, sem chave crua na cara", () => {
    const html = gerar();

    assert.match(html, /Total do dia/);
    assert.match(html, /Refeições/);
    // Chave não resolvida sai como `diets.alguma.coisa` no meio do texto.
    assert.doesNotMatch(html, />\s*(diets|workouts|assessments|common)\.[a-zA-Z.]+\s*</);
  });

  test("a alternativa aparece com 'ou' e recuada — a folha não lista dois cafés", () => {
    const html = gerar();

    assert.match(html, /Pão de forma/);
    assert.match(html, /ou<\/span>\s*Tapioca|ou\s*<\/span>Tapioca/);
    // E ela é visualmente secundária: recuo é o que diz "no lugar do de cima".
    assert.match(html, /padding-left:14px/);
  });

  test("o total do dia mostra a meta ao lado quando ela existe", () => {
    assert.match(gerar(), /1885 \/ 2000/);
  });

  test("sem meta, mostra só o alcançado — nunca 'de 0'", () => {
    const html = gerar({ targetKcal: null });

    assert.match(html, /1885/);
    assert.doesNotMatch(html, /1885 \/ 0/);
  });

  test("dia da semana sai por extenso curto, e os sete somem", () => {
    assert.match(gerar({ weekdays: ["monday", "friday"] }), /Seg, Sex/);

    // Todo dia é o mesmo que dia nenhum: listar os sete só gasta linha.
    const todos = gerar({
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });
    assert.doesNotMatch(todos, /Seg, Ter, Qua/);
  });

  test("nada do banco entra cru — nome e observação são escapados", () => {
    const html = documentoDieta({
      diet: { ...DIETA, note: "<script>alert(1)</script>", name: "Plano <b>A</b>" },
      person: { name: "Ana <img src=x onerror=alert(1)>" },
      lang: "pt-BR",
    });

    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;script&gt;/);
  });

  test("é autossuficiente: nada para buscar na rede", () => {
    // Requisito, e não capricho. Um HTML que precisa buscar arquivo não
    // sobrevive a nenhuma das quatro saídas — o cliente de e-mail bloqueia, o
    // `expo-print` não tem origem, e salvo em disco vira folha quebrada.
    const html = gerar();

    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /src=["']https?:/i);
  });

  test("estilo é sempre inline — cliente de e-mail apaga <style>", () => {
    assert.doesNotMatch(gerar(), /<style\b/i);
  });

  test("refeição sem alimento e sem observação não vira bloco vazio", () => {
    const html = gerar({ meals: [{ time: "10:00", name: "Lanche", foods: [] }] });
    assert.doesNotMatch(html, /Lanche/);
  });

  test("plano sem refeição nenhuma ainda gera folha — não quebra", () => {
    const html = gerar({ meals: [] });

    assert.match(html, /Ana Souza/);
    assert.match(html, /Total do dia/);
  });

  test("alimento sem caloria não vira zero — a folha mostra um travessão", () => {
    // "Salada à vontade" não tem número, e imprimir 0 kcal seria falso.
    const html = gerar({
      meals: [{ time: "12:00", name: "Almoço", totals: {}, foods: [{ name: "Salada", kcal: null }] }],
    });

    assert.match(html, /Salada/);
    assert.doesNotMatch(html, /Salada<\/td>[\s\S]{0,200}>0</);
  });

  test("o idioma muda os rótulos", () => {
    const en = documentoDieta({ diet: DIETA, person: PESSOA, lang: "en" });

    assert.doesNotMatch(en, /Total do dia/);
    assert.match(en, /Ana Souza/);
  });

  test("a refeição não pode ser cortada ao meio pela quebra de página", () => {
    assert.match(gerar(), /page-break-inside:avoid/);
  });
});
