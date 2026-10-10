const { porPessoa } = require("./_junta.js");

// AS PENDÊNCIAS EM ABERTO.
//
// *"quero condição de … pendências"* (10/10/2026). É a mesma pendência que
// desde hoje pode travar a catraca — documento, entrega, pagamento.
//
// `resolvidoEm: null` e não "sem o campo": a consulta das abertas filtra
// assim em todo o resto do sistema, e é por isso que o `insert` grava `null`
// em vez de deixar ausente.
const JUNTA = porPessoa({
  chave: "pend",
  de: "pendencies",
  pessoa: "person",
  filtro: () => ({ resolvidoEm: null }),
});

module.exports = [
  {
    chave: "pendencia_aberta",
    categoria: "pendencias",
    icone: "ListTodo",
    tipo: "booleano",
    junta: JUNTA,
    montar: (v) => (v ? { pendTotal: { $gt: 0 } } : { pendTotal: 0 }),
  },
  {
    chave: "pendencia_total",
    categoria: "pendencias",
    icone: "Hash",
    tipo: "numero",
    campo: "pendTotal",
    junta: JUNTA,
    padrao: "maior",
  },
];
