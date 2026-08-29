// ⚠️  ARQUIVO ESPELHADO — NÃO EDITE AQUI.
//
// A fonte é o site:
//   gofitnow-frontend/src/views/student/assessments/grupos.js
//
// Cópia byte a byte, feita por `node scripts/formulasDoSite.mjs`, e há teste
// (test/lib/formulasEspelhadas.test.js) que quebra se os dois divergirem.
//
// Por que espelho e não import: são três programas diferentes. O site precisa das
// fórmulas no NAVEGADOR (o formulário recalcula a cada tecla), o app precisa delas
// no aparelho, e o backend precisa delas para montar o documento da avaliação.
// Reescrever seria manter três versões da mesma matemática — e a divergência entre
// elas é MUDA.

// OS GRUPOS DE MEDIDAS da avaliação física: quais existem e que campos cada um
// tem. É DADO, não lógica — e é por isso que mora sozinho aqui.
//
// ── Por que saiu de `campos.js` (28/08/2026) ──────────────────────────────
//
// O BACKEND passou a montar o documento da avaliação (folha, PDF, e-mail), e para
// isso precisa saber quais grupos existem. Espelhar `campos.js` inteiro puxaria a
// corrente de imports dele (`calculos.js`, `lib/fuso.js`); esta lista não importa
// nada e atravessa sozinha.
//
// `campos.js` continua reexportando, então nenhuma tela precisou mudar.

export const GRUPOS = [
  {
    key: "skinfolds",
    icone: "Ruler",
    unit: "mm",
    campos: [
      "biceps",
      "subscapular",
      "triceps",
      "chest",
      "midaxillary",
      "suprailiac",
      "abdominal",
      "thigh",
      "calf",
    ],
  },
  {
    key: "circumferences",
    icone: "Circle",
    unit: "cm",
    campos: [
      "neck",
      "chest",
      "waist",
      "abdomen",
      "hip",
      "shoulder",
      "forearmRight",
      "forearmLeft",
      "armRightRelaxed",
      "armLeftRelaxed",
      "armRightFlexed",
      "armLeftFlexed",
      "thighRight",
      "thighLeft",
      "calfRight",
      "calfLeft",
    ],
  },
  {
    key: "bioimpedance",
    icone: "Activity",
    // A bioimpedância é o único grupo com unidade POR CAMPO: ela mistura massa,
    // percentual, caloria e idade na mesma tela do aparelho.
    unidades: {
      muscleMass: "kg",
      musclePercent: "%",
      skeletalMusclePercent: "%",
      boneMass: "kg",
      fatMass: "kg",
      fatPercent: "%",
      waterMass: "kg",
      waterPercent: "%",
      leanMass: "kg",
      residualMass: "kg",
      protein: "kg",
      minerals: "kg",
      bmi: "kg/m²",
      visceralFatMass: "kg",
      visceralFatPercent: "%",
      bmr: "kcal",
      bodyAge: "anos",
    },
    campos: [
      "muscleMass",
      "musclePercent",
      "skeletalMusclePercent",
      "boneMass",
      "fatMass",
      "fatPercent",
      "waterMass",
      "waterPercent",
      "leanMass",
      "residualMass",
      "protein",
      "minerals",
      "bmi",
      "visceralFatMass",
      "visceralFatPercent",
      "bmr",
      "bodyAge",
    ],
  },
  {
    key: "tests",
    icone: "Timer",
    unidades: {
      situps: "/min",
      pushups: "/min",
      cooper: "m",
      tugt: "seg",
      sitStand: "seg",
      flexibility: "cm",
    },
    campos: ["situps", "pushups", "cooper", "tugt", "sitStand", "flexibility"],
  },
  {
    key: "weltman",
    icone: "Ruler",
    unit: "cm",
    campos: ["abdomen1", "abdomen2"],
  },
];
