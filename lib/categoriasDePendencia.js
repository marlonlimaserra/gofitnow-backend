// AS CATEGORIAS DE PENDÊNCIA.
//
// *"não seria só documentos. Exemplo: eu queria uma camisa, aí a academia
// cadastrou camisa como pendência, para eu ser barrado na recepção para eles me
// entregarem a camisa."*
//
// ── O QUE ISTO MUDOU ────────────────────────────────────────────────────
//
// A primeira versão era só documento: o que o ALUNO deve entregar. A camisa é o
// contrário — é o que a CASA deve entregar a ele —, e a razão de existir é a
// mesma: fazer alguém ser parado no balcão para a coisa acontecer.
//
// E nenhuma delas tranca nada: *"só cadastra como pendência, não precisa travar
// até o login dele no app"*.
//
// Por isso "pendência" deixou de ser "documento que falta" e virou "assunto em
// aberto entre a casa e a pessoa". O documento continua sendo uma delas, e
// agora é uma entre várias.
const CATEGORIAS = [
  {
    id: "documento",
    icone: "FileText",
    rotulo: "pendencies.category.document",
    padrao: "Documento",
  },
  {
    // A CAMISA. Também: carteirinha, chave do armário, brinde do plano anual.
    id: "entrega",
    icone: "Package",
    rotulo: "pendencies.category.delivery",
    padrao: "Entrega",
  },
  {
    id: "pagamento",
    icone: "Wallet",
    rotulo: "pendencies.category.payment",
    padrao: "Pagamento",
  },
  {
    // O atestado médico, a avaliação que venceu, o exame que o professor pediu.
    id: "saude",
    icone: "HeartPulse",
    rotulo: "pendencies.category.health",
    padrao: "Saúde",
  },
  { id: "outro", icone: "CircleDot", rotulo: "pendencies.category.other", padrao: "Outro" },
];

const IDS = CATEGORIAS.map((c) => c.id);

// ── QUEM DEVE ─────────────────────────────────────────────────────────────
//
// A distinção que a camisa trouxe, e ela muda o que a recepção faz com o aviso.
//
// "O aluno deve" é uma cobrança: peça o termo. "A casa deve" é um lembrete para
// NÓS: entregue a camisa. As duas param a pessoa no balcão, e é por isso que
// moram na mesma lista — mas quem lê precisa saber de que lado está a bola.
const DEVEDORES = [
  { id: "aluno", rotulo: "pendencies.owedByPerson", padrao: "O aluno deve entregar" },
  { id: "casa", rotulo: "pendencies.owedByHouse", padrao: "A casa deve entregar" },
];

function existe(id) {
  return IDS.includes(String(id || ""));
}

function paraTela(t) {
  return CATEGORIAS.map((c) => ({
    id: c.id,
    label: t ? t(c.rotulo) : c.padrao,
    icone: c.icone,
  }));
}

function devedoresParaTela(t) {
  return DEVEDORES.map((d) => ({ id: d.id, label: t ? t(d.rotulo) : d.padrao }));
}

module.exports = {
  CATEGORIAS,
  DEVEDORES,
  IDS,
  existe,
  paraTela,
  devedoresParaTela,
};
