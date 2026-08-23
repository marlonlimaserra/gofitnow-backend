// O CATÁLOGO de marcadores de exame de sangue.
//
// É ele que faz a aba de Exames ser uma ferramenta e não um bloco de notas: o
// profissional escolhe "Testosterona total" e a unidade e a faixa de referência
// já vêm — em vez de digitar as três coisas em cada exame, com três chances de
// digitar diferente do exame anterior e quebrar a comparação.
//
// Três decisões que valem estar escritas:
//
//   AS FAIXAS SÃO PONTO DE PARTIDA, não verdade. Cada laboratório imprime a sua
//   (método, kit e população mudam a faixa), e por isso a faixa é COPIADA para o
//   lançamento e editável lá: o que fica gravado é a referência do laudo que o
//   profissional tem na mão, e o catálogo só poupa a digitação do caso comum.
//   Mudar o catálogo amanhã não reescreve a história de ninguém.
//
//   FAIXA POR SEXO quando a biologia separa (testosterona de homem e de mulher
//   não dividem nem a ordem de grandeza). `ref` é [baixo, alto] quando vale para
//   todos, ou {male, female} quando não — e `null` numa ponta é faixa aberta:
//   HDL só tem piso, LDL só tem teto.
//
//   AS CHAVES SÃO IDENTIDADE, não texto. "TGP", "ALT" e "Alt" no mesmo histórico
//   seriam três linhas na tabela de evolução — a tela traduz `exams.markerAlt`
//   no idioma de quem lê, e a série continua uma só.
//
// A ordem dos grupos é a ordem do LAUDO como os laboratórios imprimem — é a
// ordem em que o profissional confere, e a tabela de evolução a respeita.
const GRUPOS = [
  {
    key: "hormonal",
    markers: [
      { key: "testosteroneTotal", unit: "ng/dL", ref: { male: [300, 1000], female: [15, 70] } },
      { key: "testosteroneFree", unit: "pg/mL", ref: { male: [9, 30], female: [0.3, 3.2] } },
      { key: "estradiol", unit: "pg/mL", ref: { male: [10, 40], female: [30, 400] } },
      { key: "shbg", unit: "nmol/L", ref: { male: [10, 57], female: [18, 144] } },
      { key: "lh", unit: "mUI/mL", ref: [1.7, 8.6] },
      { key: "fsh", unit: "mUI/mL", ref: [1.5, 12.4] },
      { key: "prolactin", unit: "ng/mL", ref: { male: [4, 15], female: [4, 23] } },
      { key: "progesterone", unit: "ng/mL", ref: { male: [0.2, 1.4], female: [0.1, 25] } },
      { key: "dheas", unit: "µg/dL", ref: { male: [80, 560], female: [35, 430] } },
      { key: "cortisol", unit: "µg/dL", ref: [6, 18] },
      { key: "igf1", unit: "ng/mL", ref: [90, 280] },
      { key: "psa", unit: "ng/mL", ref: [null, 4] },
    ],
  },
  {
    key: "thyroid",
    markers: [
      { key: "tsh", unit: "µUI/mL", ref: [0.4, 4.5] },
      { key: "t4Free", unit: "ng/dL", ref: [0.8, 1.8] },
      { key: "t3Free", unit: "pg/mL", ref: [2.3, 4.2] },
      { key: "antiTpo", unit: "UI/mL", ref: [null, 35] },
    ],
  },
  {
    key: "metabolic",
    markers: [
      { key: "glucose", unit: "mg/dL", ref: [70, 99] },
      { key: "insulin", unit: "µUI/mL", ref: [2.6, 24.9] },
      { key: "hba1c", unit: "%", ref: [null, 5.7] },
      { key: "uricAcid", unit: "mg/dL", ref: { male: [3.5, 7.2], female: [2.6, 6] } },
    ],
  },
  {
    key: "lipids",
    markers: [
      { key: "totalCholesterol", unit: "mg/dL", ref: [null, 190] },
      { key: "ldl", unit: "mg/dL", ref: [null, 130] },
      { key: "hdl", unit: "mg/dL", ref: [40, null] },
      { key: "triglycerides", unit: "mg/dL", ref: [null, 150] },
    ],
  },
  {
    key: "hematology",
    markers: [
      { key: "hemoglobin", unit: "g/dL", ref: { male: [13.5, 17.5], female: [12, 15.5] } },
      { key: "hematocrit", unit: "%", ref: { male: [41, 53], female: [36, 46] } },
      { key: "ferritin", unit: "ng/mL", ref: { male: [30, 400], female: [15, 150] } },
    ],
  },
  {
    key: "liverKidney",
    markers: [
      { key: "alt", unit: "U/L", ref: { male: [null, 41], female: [null, 33] } },
      { key: "ast", unit: "U/L", ref: [null, 40] },
      { key: "ggt", unit: "U/L", ref: { male: [8, 61], female: [5, 36] } },
      { key: "creatinine", unit: "mg/dL", ref: { male: [0.7, 1.3], female: [0.6, 1.1] } },
      { key: "urea", unit: "mg/dL", ref: [15, 45] },
    ],
  },
  {
    key: "vitamins",
    markers: [
      { key: "vitaminD", unit: "ng/mL", ref: [30, 100] },
      { key: "vitaminB12", unit: "pg/mL", ref: [200, 900] },
    ],
  },
];

// A faixa que vale para ESTA pessoa. Sexo desconhecido cai na masculina — é uma
// escolha arbitrária e consciente: alguma faixa tem de preencher o formulário, e
// ela chega EDITÁVEL, com o laudo do laboratório na mão de quem lança.
function faixaPara(ref, gender) {
  const par = Array.isArray(ref) ? ref : ref[gender === "female" ? "female" : "male"];
  return { low: par[0], high: par[1] };
}

// O catálogo já resolvido para uma pessoa: é o que a rota manda para a tela.
function catalogoPara(gender) {
  return GRUPOS.map((grupo) => ({
    key: grupo.key,
    markers: grupo.markers.map((m) => ({ key: m.key, unit: m.unit, ...faixaPara(m.ref, gender) })),
  }));
}

const CHAVES = new Set(GRUPOS.flatMap((g) => g.markers.map((m) => m.key)));

module.exports = { GRUPOS, catalogoPara, faixaPara, CHAVES };
