const { ObjectId } = require("mongodb");
const { porPessoa } = require("./_junta.js");

// AS AULAS COLETIVAS que a pessoa FREQUENTOU.
//
// *"em aulas coletivas, quero que tenha: frequentou a aula X, quantas vezes,
// última vez"* (10/10/2026).
//
// ── `presente`, E NÃO `inscrito` ─────────────────────────────────────────
//
// São três estados, e a diferença é o assunto inteiro desta família:
// `inscrito` é "disse que vem", `presente` é "veio, e alguém confirmou",
// `faltou` é "não veio". Contar inscrição como presença faria "frequentou
// mais de 10 aulas" devolver quem só clica em "vou" — e o professor tiraria
// conclusão sobre uma turma que não existiu.
//
// ── UMA JUNÇÃO PARA AS TRÊS PERGUNTAS ────────────────────────────────────
//
// Quantas vezes, quando foi a última e quais aulas são leituras do mesmo
// histórico. `lista` guarda os IDS das aulas com `$addToSet`: frequentar
// Pilates quatro vezes não faz quatro aulas diferentes.
const JUNTA = porPessoa({
  chave: "aula",
  de: "group_class_checkins",
  pessoa: "person",
  // `dia` é texto "AAAA-MM-DD", como nas dietas — a aula é de um dia de
  // calendário, não de um instante.
  data: "dia",
  lista: "class",
  filtro: () => ({ status: "presente" }),
});

module.exports = [
  {
    chave: "aula_total",
    categoria: "aula",
    icone: "Users",
    tipo: "numero",
    campo: "aulaTotal",
    junta: JUNTA,
    padrao: "maior",
  },
  {
    chave: "aula_ultima",
    categoria: "aula",
    icone: "CalendarClock",
    tipo: "data",
    campo: "aulaUltima",
    junta: JUNTA,
    // "antes de" primeiro: quem abre esta condição procura quem parou de vir
    // nas aulas, não quem veio.
    padrao: "antes",
  },
  {
    chave: "aula_qual",
    categoria: "aula",
    icone: "CalendarCheck",
    tipo: "pessoa",
    junta: JUNTA,
    // A lista de aulas é VIVA e muda por conta — a tela a resolve, como faz
    // com as unidades. O catálogo não a embute: ela nasce e morre o tempo
    // todo, e um catálogo com as aulas de ontem dentro seria pior que nenhum.
    fonte: "aulas",
    montar: (v, op) => {
      if (!ObjectId.isValid(v)) return null;
      const id = new ObjectId(String(v));

      // No Mongo, comparar um array com um valor casa quando QUALQUER
      // elemento casa — que é exatamente "frequentou esta aula".
      //
      // E "não frequentou" pega também quem nunca foi a aula nenhuma: quem
      // não vai a aula alguma não vai a esta. É a leitura literal, e quem
      // quiser o contrário soma "aulas que frequentou: mais de 0".
      if (op === "nao_e") return { aulaLista: { $ne: id } };
      if (op === "vazio") return { aulaLista: { $size: 0 } };
      return { aulaLista: id };
    },
  },
];
