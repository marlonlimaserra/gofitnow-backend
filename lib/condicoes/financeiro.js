const { porPessoa } = require("./_junta.js");

// O FINANCEIRO — o que está em aberto.
//
// *"quero condição de … financeiro"* (10/10/2026).
//
// ── UMA JUNÇÃO PARA AS TRÊS PERGUNTAS ────────────────────────────────────
//
// "Tem cobrança em aberto", "tem vencida" e "quanto deve" parecem três
// recortes diferentes e são um só: as cobranças em aberto desta pessoa. O que
// muda é o que se lê delas — quantas, a mais antiga, e a soma.
//
// A VENCIDA sai da mais antiga: se a cobrança em aberto mais velha venceu, há
// vencida. Sem isso seria uma segunda junção na mesma collection, pagando
// duas varreduras por pessoa da página para responder o óbvio.
//
// `amount` está em CENTAVOS (ver `centavos` no Finance_model), e a tela
// pergunta em reais — a conversão é da condição, não de quem digita.
const JUNTA = porPessoa({
  chave: "fin",
  de: "charges",
  // `student`, e não `person`: as cobranças chamam assim. Apontar para o
  // errado devolve lista vazia, que parece "ninguém deve nada".
  pessoa: "student",
  dataMin: "dueDate",
  soma: "amount",
  filtro: () => ({ status: "open" }),
});

module.exports = [
  {
    chave: "cobranca_aberta",
    categoria: "financeiro",
    icone: "Wallet",
    tipo: "booleano",
    junta: JUNTA,
    montar: (v) => (v ? { finTotal: { $gt: 0 } } : { finTotal: 0 }),
  },
  {
    chave: "cobranca_vencida",
    categoria: "financeiro",
    icone: "TriangleAlert",
    tipo: "booleano",
    junta: JUNTA,
    montar: (v, op, { hoje }) =>
      v ? { finPrimeira: { $lt: hoje } } : { $or: [{ finPrimeira: null }, { finPrimeira: { $gte: hoje } }] },
  },
  {
    chave: "cobranca_valor",
    categoria: "financeiro",
    icone: "CircleDollarSign",
    tipo: "numero",
    junta: JUNTA,
    padrao: "maior",
    // Reais na tela, centavos no banco. Quem digita "100" quer cem reais.
    montar: (v, op) => {
      const centavos = Math.round(Number(v) * 100);
      if (op === "menor") return { finSoma: { $lt: centavos } };
      if (op === "e") return { finSoma: centavos };
      return { finSoma: { $gt: centavos } };
    },
  },
];
