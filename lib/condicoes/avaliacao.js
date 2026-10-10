const { porPessoa } = require("./_junta.js");

// A AVALIAÇÃO FÍSICA — tem, e de quando é a última.
//
// *"quero condição de … avaliação física"* (10/10/2026).
//
// A pergunta que isto responde de verdade é "quem está sem avaliação há seis
// meses?", e ela se faz com "última avaliação ANTES de tal dia" — por isso o
// padrão da data é `antes`, e não `a partir de`.
const JUNTA = porPessoa({
  chave: "aval",
  de: "assessments",
  pessoa: "student",
  data: "date",
});

module.exports = [
  {
    chave: "avaliacao_tem",
    categoria: "avaliacao",
    icone: "Ruler",
    tipo: "booleano",
    junta: JUNTA,
    montar: (v) => (v ? { avalTotal: { $gt: 0 } } : { avalTotal: 0 }),
  },
  {
    chave: "avaliacao_ultima",
    categoria: "avaliacao",
    icone: "CalendarClock",
    tipo: "data",
    campo: "avalUltima",
    junta: JUNTA,
    padrao: "antes",
  },
];
