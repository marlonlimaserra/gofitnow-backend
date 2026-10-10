const instanceContext = require("../instance.js");

// A DIETA — vigência, macros e alimentos.
//
// *"quero poder escolher dieta com kcal acima de ou abaixo etc., mesma coisa
// para carboidratos e gorduras, e também por alimento: tem o alimento x, não
// tem o alimento x"* (10/10/2026).
//
// ── O TOTAL É GRAVADO, E ISSO FOI DECISÃO DELE ───────────────────────────
//
// *"acho que seria bom salvar o total no mongo mesmo, pra ficar mais fácil de
// filtrar"* (10/10/2026). Ele tem razão, e a primeira versão disto provava:
// era um `$lookup` que desmontava refeição por refeição e alimento por
// alimento DENTRO do banco, por pessoa da página, só para refazer uma conta já
// feita na última vez que alguém salvou o plano.
//
// Agora `Diet_model.resumoDoPlano` grava `resumo` no `saveMeals` — o único
// caminho que mexe em alimento —, usando o MESMO `somar` e os mesmos
// `principais` da tela. A nota lá explica por que isso não contraria o "não
// guardar total" que estava escrito no modelo.
//
// Daqui, o que sobra é ler.
//
// ── SOBRE QUAL DIETA ─────────────────────────────────────────────────────
//
// A VIGENTE. Filtrar pelas calorias de um plano que acabou em março é ruído —
// e com `$max`, quem tem duas vigentes responde "tem alguma dieta com mais de
// 2000 kcal", que é a leitura natural da pergunta.
const VIGENTE = (dia) => ({
  $and: [
    { $or: [{ startDate: { $in: [null, ""] } }, { startDate: { $lte: dia } }] },
    { $or: [{ endDate: { $in: [null, ""] } }, { endDate: { $gte: dia } }] },
  ],
});

const MACROS = ["kcal", "protein", "carbs", "fat"];

const JUNTA = {
  chave: "dieta",
  estagios: ({ dia }) => [
    {
      $lookup: {
        from: "diets",
        let: { eu: "$_id" },
        pipeline: [
          // `student`, e não `person`: as dietas chamam assim, como as
          // cobranças e as avaliações. Apontar para o errado devolve lista
          // vazia, que parece "ninguém tem dieta".
          {
            $match: {
              instance: instanceContext.required(),
              $expr: { $eq: ["$student", "$$eu"] },
            },
          },
          { $match: VIGENTE(dia) },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              ...Object.fromEntries(MACROS.map((m) => [m, { $max: "$resumo." + m }])),
              // Um array por dieta; o `$addFields` abaixo achata.
              nomes: { $push: { $ifNull: ["$resumo.alimentos", []] } },
            },
          },
        ],
        as: "_dieta",
      },
    },
    {
      $addFields: {
        dietaTotal: { $ifNull: [{ $arrayElemAt: ["$_dieta.total", 0] }, 0] },
        ...Object.fromEntries(
          MACROS.map((m) => [
            "dieta" + m[0].toUpperCase() + m.slice(1),
            { $ifNull: [{ $arrayElemAt: ["$_dieta." + m, 0] }, null] },
          ])
        ),
        // Dois níveis viram um: sem achatar, o `$regex` procuraria num array
        // de arrays e não casaria com nada — e o filtro diria que ninguém
        // come frango.
        dietaAlimentos: {
          $reduce: {
            input: { $ifNull: [{ $arrayElemAt: ["$_dieta.nomes", 0] }, []] },
            initialValue: [],
            in: { $concatArrays: ["$$value", "$$this"] },
          },
        },
      },
    },
  ],
};

// Caloria, proteína, carboidrato e gordura perguntam a mesma coisa de quatro
// campos — escrever as quatro à mão seria quatro chances de errar um nome.
const porMacro = (chave, campo, icone) => ({
  chave: "dieta_" + chave,
  categoria: "dieta",
  icone,
  tipo: "numero",
  campo: "dieta" + campo[0].toUpperCase() + campo.slice(1),
  junta: JUNTA,
  // "acima de" é o que se pergunta de um macro; "é exatamente 2000 kcal" não é
  // pergunta que alguém faça.
  padrao: "maior",
});

module.exports = [
  {
    chave: "dieta_vigente",
    categoria: "dieta",
    icone: "Salad",
    tipo: "booleano",
    junta: JUNTA,
    montar: (v) => (v ? { dietaTotal: { $gt: 0 } } : { dietaTotal: 0 }),
  },

  porMacro("kcal", "kcal", "Flame"),
  porMacro("proteina", "protein", "Beef"),
  porMacro("carboidrato", "carbs", "Wheat"),
  porMacro("gordura", "fat", "Droplet"),

  {
    chave: "dieta_alimento",
    categoria: "dieta",
    icone: "Apple",
    tipo: "texto",
    junta: JUNTA,
    // `contem` e não `e`: ninguém digita "Frango grelhado 120g" — digita
    // "frango". O nome do alimento no plano é uma frase, e a pergunta é se
    // ela contém a palavra.
    padrao: "contem",
    montar: (v, op) => {
      const texto = String(v).trim();
      if (!texto) return null;

      const escapado = texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // No Mongo, um `$regex` sobre um ARRAY casa quando QUALQUER elemento
      // casa — que é exatamente "tem o alimento x".
      if (op === "nao_contem") {
        // Quem não tem dieta nenhuma também não tem o alimento. É a leitura
        // certa da pergunta, e quem quiser o contrário soma "dieta vigente".
        return { dietaAlimentos: { $not: new RegExp(escapado, "i") } };
      }
      return { dietaAlimentos: { $regex: escapado, $options: "i" } };
    },
  },
];
