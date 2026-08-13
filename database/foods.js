// A semente do catálogo de alimentos.
//
// Valores por 100 g (ou 100 ml), como as tabelas oficiais publicam. Os números
// seguem a TACO (Tabela Brasileira de Composição de Alimentos, Unicamp) para os
// itens que ela cobre, arredondados — é referência pública e é o que
// nutricionista brasileiro usa.
//
// Não é uma tabela completa, e não tenta ser: são os alimentos que aparecem em
// quase todo plano. O catálogo é editável na tela, então ele cresce do uso — a
// mesma escolha que o de exercícios fez ao deixar `muscleGroup` como texto
// livre em vez de uma taxonomia fixada de antemão.
//
// `portion` é a medida caseira usual, só para a tela sugerir uma quantidade.
// Quem calcula sempre usa regra de três sobre os 100 g.
const FOODS = [
  // ── Cereais e massas ────────────────────────────────────────────────────
  ["Arroz branco cozido", "Cereais", 128, 2.5, 28.1, 0.2, 1.6, 100, "1 escumadeira"],
  ["Arroz integral cozido", "Cereais", 124, 2.6, 25.8, 1.0, 2.7, 100, "1 escumadeira"],
  ["Macarrão cozido", "Cereais", 158, 5.8, 30.9, 1.3, 1.6, 120, "1 pegador"],
  ["Aveia em flocos", "Cereais", 394, 13.9, 66.6, 8.5, 9.1, 30, "3 colheres de sopa"],
  ["Pão francês", "Cereais", 300, 8.0, 58.6, 3.1, 2.3, 50, "1 unidade"],
  ["Pão integral", "Cereais", 253, 9.4, 49.9, 3.7, 6.9, 50, "2 fatias"],
  ["Tapioca (goma hidratada)", "Cereais", 240, 0.0, 59.0, 0.0, 0.5, 60, "1 unidade"],
  ["Cuscuz de milho cozido", "Cereais", 113, 2.4, 25.3, 0.6, 1.4, 100, "1 fatia"],
  ["Batata inglesa cozida", "Tubérculos", 52, 1.2, 11.9, 0.0, 1.3, 150, "1 unidade média"],
  ["Batata doce cozida", "Tubérculos", 77, 0.6, 18.4, 0.1, 2.2, 150, "1 unidade média"],
  ["Mandioca cozida", "Tubérculos", 125, 0.6, 30.1, 0.3, 1.6, 100, "1 pedaço"],

  // ── Leguminosas ─────────────────────────────────────────────────────────
  ["Feijão carioca cozido", "Leguminosas", 76, 4.8, 13.6, 0.5, 8.5, 80, "1 concha"],
  ["Feijão preto cozido", "Leguminosas", 77, 4.5, 14.0, 0.5, 8.4, 80, "1 concha"],
  ["Lentilha cozida", "Leguminosas", 93, 6.3, 16.3, 0.5, 7.9, 80, "1 concha"],
  ["Grão-de-bico cozido", "Leguminosas", 121, 6.6, 20.0, 2.1, 5.7, 80, "1 concha"],
  ["Soja em grão cozida", "Leguminosas", 151, 12.5, 9.1, 7.7, 6.0, 80, "1 concha"],

  // ── Carnes e ovos ───────────────────────────────────────────────────────
  ["Peito de frango grelhado", "Carnes", 159, 32.0, 0.0, 2.5, 0.0, 100, "1 filé"],
  ["Coxa de frango assada", "Carnes", 215, 26.9, 0.0, 11.8, 0.0, 100, "1 unidade"],
  ["Patinho bovino grelhado", "Carnes", 219, 35.9, 0.0, 7.3, 0.0, 100, "1 bife"],
  ["Alcatra grelhada", "Carnes", 241, 31.9, 0.0, 11.8, 0.0, 100, "1 bife"],
  ["Carne moída (acém) refogada", "Carnes", 212, 26.7, 0.0, 11.0, 0.0, 100, ""],
  ["Lombo suíno assado", "Carnes", 210, 35.7, 0.0, 6.4, 0.0, 100, "1 fatia"],
  ["Tilápia grelhada", "Peixes", 96, 20.1, 0.0, 1.7, 0.0, 100, "1 filé"],
  ["Salmão grelhado", "Peixes", 243, 23.0, 0.0, 16.4, 0.0, 100, "1 posta"],
  ["Atum em água (lata)", "Peixes", 116, 25.5, 0.0, 1.0, 0.0, 120, "1 lata"],
  ["Ovo de galinha cozido", "Ovos", 146, 13.3, 0.6, 9.5, 0.0, 50, "1 unidade"],
  ["Clara de ovo cozida", "Ovos", 59, 13.4, 0.0, 0.1, 0.0, 33, "1 unidade"],

  // ── Laticínios ──────────────────────────────────────────────────────────
  ["Leite integral", "Laticínios", 61, 2.9, 4.3, 3.2, 0.0, 200, "1 copo"],
  ["Leite desnatado", "Laticínios", 35, 3.4, 4.9, 0.2, 0.0, 200, "1 copo"],
  ["Iogurte natural integral", "Laticínios", 51, 4.1, 1.9, 3.0, 0.0, 170, "1 pote"],
  ["Iogurte natural desnatado", "Laticínios", 41, 3.8, 5.4, 0.2, 0.0, 170, "1 pote"],
  ["Queijo minas frescal", "Laticínios", 264, 17.4, 3.2, 20.2, 0.0, 30, "1 fatia"],
  ["Queijo muçarela", "Laticínios", 330, 22.6, 3.0, 25.2, 0.0, 20, "1 fatia"],
  ["Requeijão cremoso", "Laticínios", 257, 9.6, 3.0, 23.0, 0.0, 30, "1 colher de sopa"],
  ["Whey protein concentrado", "Suplementos", 400, 80.0, 8.0, 5.0, 0.0, 30, "1 scoop"],

  // ── Frutas ──────────────────────────────────────────────────────────────
  ["Banana prata", "Frutas", 98, 1.3, 26.0, 0.1, 2.0, 70, "1 unidade"],
  ["Maçã com casca", "Frutas", 56, 0.3, 15.2, 0.0, 1.3, 130, "1 unidade"],
  ["Mamão formosa", "Frutas", 45, 0.8, 11.6, 0.1, 1.8, 150, "1 fatia"],
  ["Laranja pera", "Frutas", 37, 1.0, 8.9, 0.1, 0.8, 180, "1 unidade"],
  ["Abacate", "Frutas", 96, 1.2, 6.0, 8.4, 6.3, 100, "1/2 unidade"],
  ["Morango", "Frutas", 30, 0.9, 6.8, 0.3, 1.7, 100, "1 xícara"],
  ["Uva itália", "Frutas", 53, 0.7, 13.6, 0.2, 0.9, 100, "1 cacho pequeno"],
  ["Melancia", "Frutas", 33, 0.9, 8.1, 0.0, 0.1, 200, "1 fatia"],
  ["Abacaxi", "Frutas", 48, 0.9, 12.3, 0.1, 1.0, 100, "1 fatia"],

  // ── Verduras e legumes ──────────────────────────────────────────────────
  ["Alface crespa", "Verduras", 11, 1.3, 1.7, 0.2, 1.8, 40, "1 prato de sobremesa"],
  ["Rúcula", "Verduras", 13, 1.8, 2.2, 0.3, 1.7, 40, "1 prato de sobremesa"],
  ["Tomate cru", "Legumes", 15, 1.1, 3.1, 0.2, 1.2, 80, "1 unidade"],
  ["Cenoura crua", "Legumes", 34, 1.3, 7.7, 0.2, 3.2, 80, "1 unidade"],
  ["Brócolis cozido", "Legumes", 25, 2.1, 4.4, 0.5, 3.4, 80, "1 xícara"],
  ["Abobrinha cozida", "Legumes", 19, 1.1, 2.9, 0.4, 1.5, 80, "1 xícara"],
  ["Beterraba cozida", "Legumes", 32, 1.3, 7.2, 0.1, 1.9, 80, "1 xícara"],
  ["Couve refogada", "Verduras", 90, 1.7, 5.8, 6.6, 3.1, 60, "1 xícara"],
  ["Pepino cru", "Legumes", 10, 0.9, 2.0, 0.0, 1.1, 80, ""],

  // ── Gorduras e oleaginosas ──────────────────────────────────────────────
  ["Azeite de oliva", "Gorduras", 884, 0.0, 0.0, 100.0, 0.0, 10, "1 colher de sopa"],
  ["Óleo de soja", "Gorduras", 884, 0.0, 0.0, 100.0, 0.0, 10, "1 colher de sopa"],
  ["Manteiga com sal", "Gorduras", 726, 0.4, 0.1, 82.4, 0.0, 10, "1 colher de chá"],
  ["Castanha-do-pará", "Oleaginosas", 643, 14.5, 15.1, 63.5, 7.9, 20, "4 unidades"],
  ["Amendoim torrado", "Oleaginosas", 544, 27.2, 20.3, 43.9, 8.0, 25, "1 punhado"],
  ["Pasta de amendoim integral", "Oleaginosas", 588, 25.0, 20.0, 50.0, 6.0, 20, "1 colher de sopa"],
  ["Chia em grão", "Oleaginosas", 486, 16.5, 42.1, 30.7, 34.4, 12, "1 colher de sopa"],

  // ── Bebidas ─────────────────────────────────────────────────────────────
  ["Água de coco", "Bebidas", 22, 0.0, 5.3, 0.0, 0.1, 200, "1 copo", "ml"],
  ["Suco de laranja natural", "Bebidas", 37, 0.7, 8.7, 0.2, 0.2, 200, "1 copo", "ml"],
  ["Café sem açúcar", "Bebidas", 2, 0.1, 0.3, 0.0, 0.0, 50, "1 xícara", "ml"],
];

// Só semeia collection VAZIA. Rodar de novo não duplica nem sobrescreve o que o
// profissional tenha corrigido à mão — o `db:init` é idempotente por contrato, e
// um catálogo que se restaura sozinho apagaria trabalho alheio.
async function seedFoods(db) {
  const col = db.collection("foods");

  if ((await col.countDocuments({})) > 0) return 0;

  const semAcento = (t) =>
    String(t).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  const docs = FOODS.map(
    ([name, category, kcal, protein, carbs, fat, fiber, portion, portionLabel, unit]) => ({
      name,
      nameSort: semAcento(name),
      category,
      kcal,
      protein,
      carbs,
      fat,
      fiber,
      portion,
      portionLabel: portionLabel || "",
      unit: unit || "g",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  );

  await col.insertMany(docs);
  return docs.length;
}

module.exports = { FOODS, seedFoods };
