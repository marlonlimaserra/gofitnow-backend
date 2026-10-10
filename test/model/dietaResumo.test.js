const test = require("node:test");
const assert = require("node:assert/strict");

const Diet = require("../../model/Diet_model.js");
const resumo = Diet.prototype.resumoDoPlano;

// O RESUMO DO PLANO, GRAVADO NA ESCRITA.
//
// *"acho que seria bom salvar o total no mongo mesmo, pra ficar mais fácil de
// filtrar"* (10/10/2026).
//
// ── POR QUE ISTO PRECISA DE TESTE, E NÃO SÓ O FILTRO ─────────────────────
//
// Havia uma decisão escrita no modelo contra guardar total: *"um total gravado
// é um total que pode discordar da lista logo abaixo dele"*. Ela continua
// certa — o que a desarma é este resumo sair do MESMO `somar` e dos mesmos
// `principais` que a tela usa.
//
// Se um dia ele divergir, o filtro passa a mentir em silêncio: a dieta some de
// um recorte e ninguém abre chamado. Daí os casos abaixo serem sobre a conta,
// e não sobre a consulta.

test("substitutos NÃO somam — a pessoa come um deles", () => {
  // Arroz OU batata. Somar os dois dobra as calorias de todo plano com
  // substituição, e o filtro discorda da tela sobre a MESMA dieta.
  const r = resumo([
    {
      foods: [
        { name: "Arroz", kcal: 100, group: 1 },
        { name: "Batata", kcal: 300, group: 1 },
        { name: "Frango", kcal: 200, group: null },
      ],
    },
  ]);

  assert.equal(r.kcal, 300);
});

test("mas os substitutos ENTRAM na lista de alimentos", () => {
  // "Tem frango?" é sobre o que está no plano, e um substituto está no plano:
  // a pessoa pode comê-lo. São duas perguntas sobre o mesmo array.
  const r = resumo([
    { foods: [{ name: "Arroz", kcal: 100, group: 1 }, { name: "Batata", kcal: 300, group: 1 }] },
  ]);

  assert.deepEqual(r.alimentos, ["Arroz", "Batata"]);
});

test("dois alimentos SEM grupo são dois alimentos", () => {
  const r = resumo([
    { foods: [{ name: "Ovo", kcal: 70, group: null }, { name: "Pão", kcal: 130, group: null }] },
  ]);

  assert.equal(r.kcal, 200);
});

test("grupo ZERO é um grupo — e não 'sem grupo'", () => {
  // `0` é falso em JavaScript, e um `if (f.group)` o trataria como solto:
  // os dois substitutos somariam.
  const r = resumo([
    { foods: [{ name: "A", kcal: 100, group: 0 }, { name: "B", kcal: 500, group: 0 }] },
  ]);

  assert.equal(r.kcal, 100);
});

test("macro que ninguém informou fica NULO, e não zero", () => {
  // Um plano montado só com receitas caseiras sem rótulo mostraria "0 g de
  // proteína", que é falso. A mesma regra do `somar`, e por isso ela não foi
  // reescrita aqui.
  const r = resumo([{ foods: [{ name: "Marmita da vó", kcal: null, group: null }] }]);

  assert.equal(r.kcal, null);
  assert.equal(r.protein, null);
});

test("as refeições somam entre si", () => {
  const r = resumo([
    { foods: [{ name: "Café", kcal: 300, group: null }] },
    { foods: [{ name: "Almoço", kcal: 700, group: null }] },
  ]);

  assert.equal(r.kcal, 1000);
  assert.deepEqual(r.alimentos, ["Café", "Almoço"]);
});

test("plano vazio tem resumo, e não campo ausente", () => {
  // `$lt` não casa com ausente: quem filtrasse "menos de 500 kcal" perderia
  // os planos vazios, que são justamente os que alguém quer achar.
  const r = resumo([]);

  assert.deepEqual(r.alimentos, []);
  assert.ok("kcal" in r);
});

test("nome em branco não vira alimento", () => {
  const r = resumo([{ foods: [{ name: "  ", kcal: 10 }, { name: "Aveia", kcal: 20 }] }]);

  assert.deepEqual(r.alimentos, ["Aveia"]);
});
