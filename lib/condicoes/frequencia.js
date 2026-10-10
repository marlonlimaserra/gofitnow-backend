const { porPessoa } = require("./_junta.js");

// A FREQUÊNCIA — quantas vezes veio, e quando foi a última.
//
// *"quero condição de … frequência"* (10/10/2026).
//
// Duas perguntas, e a segunda é a que uma academia faz todo mês: "quem parou
// de vir?". Ela se responde com "última visita ANTES de tal dia", que o tipo
// `data` já sabe perguntar — não precisou de um "dias sem vir" em número, que
// pareceria mais direto e envelheceria sozinho na tela.
const JUNTA = porPessoa({ chave: "freq", de: "checkins", pessoa: "person", data: "em" });

module.exports = [
  {
    chave: "frequencia_total",
    categoria: "frequencia",
    icone: "Activity",
    tipo: "numero",
    campo: "freqTotal",
    junta: JUNTA,
    // "mais que" é o que se pergunta de um contador; "é igual a 7 visitas" não
    // é pergunta que alguém faça.
    padrao: "maior",
  },
  {
    chave: "frequencia_ultima",
    categoria: "frequencia",
    icone: "CalendarClock",
    tipo: "data",
    campo: "freqUltima",
    junta: JUNTA,
    // "antes de" primeiro: quem abre esta condição está procurando quem
    // sumiu, não quem veio.
    padrao: "antes",
  },
];
