// OS CATÁLOGOS DA ESTRUTURA — equipamentos e insumos.
//
// *"academia tem manutenção, tem gasto com produtos de limpeza; como a gente
// poderia controlar isso — o que saiu, o que entrou, equipamentos que precisam
// de manutenção etc."*
//
// ── SÃO DUAS COISAS DIFERENTES, e o modelo respeita isso ────────────────
//
// O EQUIPAMENTO é uma coisa com identidade: a esteira 3 tem número de série,
// fica na sala de cardio, quebrou em março e foi consertada em abril. Ela é uma
// só, e o que interessa nela é a HISTÓRIA.
//
// O INSUMO é uma quantidade: desinfetante não tem número de série, tem SALDO.
// Entram cinco galões, saem dois, sobram três — e o que interessa é o saldo e o
// dia em que ele chega perto do fim.
//
// Guardá-los na mesma collection obrigaria toda consulta a perguntar "isto tem
// saldo ou tem histórico?", e a primeira vez que alguém esquecesse, uma esteira
// apareceria com "saldo: 1".

// ── OS EQUIPAMENTOS ───────────────────────────────────────────────────────
const EQUIPAMENTOS = [
  { id: "cardio", icone: "HeartPulse", rotulo: "structure.equipment.cardio", padrao: "Cardio" },
  { id: "musculacao", icone: "Dumbbell", rotulo: "structure.equipment.strength", padrao: "Musculação" },
  { id: "livre", icone: "Weight", rotulo: "structure.equipment.free", padrao: "Peso livre" },
  { id: "acessorio", icone: "Cable", rotulo: "structure.equipment.accessory", padrao: "Acessório" },
  // O que não é aparelho e quebra do mesmo jeito: ar-condicionado, chuveiro,
  // armário, som. É a categoria que faz a lista servir para a academia inteira,
  // e não só para a sala de musculação.
  { id: "predial", icone: "Building2", rotulo: "structure.equipment.building", padrao: "Predial" },
  { id: "outro", icone: "Package", rotulo: "structure.equipment.other", padrao: "Outro" },
];

// ── O ESTADO DE UM EQUIPAMENTO ────────────────────────────────────────────
//
// `manutencao` é "está parado esperando conserto" — e é diferente de `parado`,
// que é "não uso mais, mas ainda está aí". A diferença importa na hora de
// comprar: um espera peça, o outro espera decisão.
const ESTADOS = [
  { id: "ok", tom: "ok", rotulo: "structure.state.ok", padrao: "Em uso" },
  { id: "manutencao", tom: "aviso", rotulo: "structure.state.maintenance", padrao: "Em manutenção" },
  { id: "parado", tom: "neutro", rotulo: "structure.state.idle", padrao: "Parado" },
  { id: "baixado", tom: "neutro", rotulo: "structure.state.retired", padrao: "Baixado" },
];

// ── O TIPO DE MANUTENÇÃO ──────────────────────────────────────────────────
//
// `preventiva` é a que se agenda; `corretiva` é a que acontece. A conta que
// interessa no fim do ano é a proporção entre as duas: muita corretiva quer
// dizer que a preventiva não está acontecendo.
const MANUTENCOES = [
  { id: "preventiva", rotulo: "structure.maintenance.preventive", padrao: "Preventiva" },
  { id: "corretiva", rotulo: "structure.maintenance.corrective", padrao: "Corretiva" },
  { id: "instalacao", rotulo: "structure.maintenance.install", padrao: "Instalação" },
];

// ── OS INSUMOS ────────────────────────────────────────────────────────────
const INSUMOS = [
  { id: "limpeza", icone: "SprayCan", rotulo: "structure.supply.cleaning", padrao: "Limpeza" },
  { id: "banheiro", icone: "ShowerHead", rotulo: "structure.supply.bathroom", padrao: "Banheiro" },
  { id: "escritorio", icone: "Paperclip", rotulo: "structure.supply.office", padrao: "Escritório" },
  { id: "manutencao", icone: "Wrench", rotulo: "structure.supply.maintenance", padrao: "Manutenção" },
  // O que a academia REVENDE: barrinha, água, camiseta. Entra e sai como
  // qualquer insumo, e é o que faz o saldo valer dinheiro de verdade.
  { id: "revenda", icone: "ShoppingBag", rotulo: "structure.supply.resale", padrao: "Revenda" },
  { id: "outro", icone: "Package", rotulo: "structure.supply.other", padrao: "Outro" },
];

// A unidade de medida. Curta de propósito: a lista é para escolher rápido, e
// "mililitro" ao lado de "unidade" é uma decisão que ninguém quer tomar às
// sete da manhã.
const MEDIDAS = [
  { id: "un", rotulo: "structure.unit.piece", padrao: "un" },
  { id: "cx", rotulo: "structure.unit.box", padrao: "cx" },
  { id: "l", rotulo: "structure.unit.liter", padrao: "L" },
  { id: "kg", rotulo: "structure.unit.kilo", padrao: "kg" },
  { id: "m", rotulo: "structure.unit.meter", padrao: "m" },
];

// ── O MOVIMENTO ───────────────────────────────────────────────────────────
//
// Três tipos, e o terceiro é o que torna o livro honesto.
//
// `entrada` e `saida` são o dia a dia. `ajuste` é a contagem física: o livro
// diz cinco, a prateleira tem três, e alguém lança a diferença dizendo por quê.
//
// Sem o ajuste, a única forma de corrigir seria editar um lançamento antigo — e
// um livro que se edita para trás deixa de ser prova de alguma coisa.
const MOVIMENTOS = [
  { id: "entrada", sinal: 1, rotulo: "structure.move.in", padrao: "Entrada" },
  { id: "saida", sinal: -1, rotulo: "structure.move.out", padrao: "Saída" },
  { id: "ajuste", sinal: 0, rotulo: "structure.move.fix", padrao: "Ajuste de contagem" },
];

function paraTela(lista, t) {
  return lista.map((c) => ({
    id: c.id,
    label: t ? t(c.rotulo) : c.padrao,
    ...(c.icone ? { icone: c.icone } : {}),
    ...(c.tom ? { tom: c.tom } : {}),
    ...(c.sinal !== undefined ? { sinal: c.sinal } : {}),
  }));
}

const temId = (lista) => (id) => lista.some((x) => x.id === String(id || ""));

module.exports = {
  EQUIPAMENTOS,
  ESTADOS,
  MANUTENCOES,
  INSUMOS,
  MEDIDAS,
  MOVIMENTOS,
  paraTela,
  ehEquipamento: temId(EQUIPAMENTOS),
  ehEstado: temId(ESTADOS),
  ehManutencao: temId(MANUTENCOES),
  ehInsumo: temId(INSUMOS),
  ehMedida: temId(MEDIDAS),
  ehMovimento: temId(MOVIMENTOS),
};
