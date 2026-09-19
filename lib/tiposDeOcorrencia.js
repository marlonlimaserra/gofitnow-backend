// O QUE ACONTECE COM UM FUNCIONÁRIO — a linha do tempo da ficha.
//
// *"ver folha de ponto, salário, advertências, anotações e outras coisas que
// funcionário pode ter que eu não sei"*.
//
// ── POR QUE É UMA LISTA SÓ, e não uma aba para cada ──────────────────────
//
// Porque a pergunta que se faz na frente de um funcionário é cronológica: "o
// que aconteceu com ele?". Advertência em março, atestado em abril, reajuste em
// maio, elogio em junho — isso é uma história, e uma história contada em cinco
// abas separadas não se lê.
//
// A ficha tem uma LINHA DO TEMPO, filtrável por tipo. Quem quer só as
// advertências clica no filtro; quem quer entender a pessoa lê tudo em ordem.
//
// Do lado do banco a economia é a mesma: uma collection, um índice, um
// formulário. Cinco collections com quatro campos iguais seriam cinco lugares
// para corrigir o dia em que "quem lançou" precisar aparecer na tela.
//
// ── OS CAMPOS SÃO DECLARADOS AQUI, e a tela obedece ─────────────────────
//
// Cada tipo diz de que campos precisa. Férias precisa de um período; reajuste,
// de um valor; advertência, de gravidade e de "o funcionário ficou ciente".
// Anotação não precisa de nada além do texto.
//
// É o catálogo que desenha o formulário — do mesmo jeito que as categorias
// desenham o seletor de contas a pagar. Um tipo novo aparece na tela sozinho.
const TIPOS = [
  {
    id: "anotacao",
    rotulo: "employees.record.note",
    padrao: "Anotação",
    icone: "StickyNote",
    tom: "neutro",
  },
  {
    id: "elogio",
    rotulo: "employees.record.praise",
    padrao: "Elogio",
    icone: "ThumbsUp",
    tom: "ok",
  },
  {
    // ── A ADVERTÊNCIA CARREGA A GRAVIDADE, e não é três tipos ─────────────
    //
    // Verbal, escrita e suspensão são DEGRAUS da mesma coisa, e é justamente a
    // sequência delas que importa: a justa causa se sustenta quando existe a
    // escada documentada. Três tipos soltos na lista esconderiam a escada; um
    // tipo com gravidade a mostra em ordem.
    id: "advertencia",
    rotulo: "employees.record.warning",
    padrao: "Advertência",
    icone: "AlertTriangle",
    tom: "aviso",
    gravidade: true,
    ciente: true,
  },
  {
    id: "atestado",
    rotulo: "employees.record.sickNote",
    padrao: "Atestado",
    icone: "Stethoscope",
    tom: "info",
    periodo: true,
  },
  {
    id: "falta",
    rotulo: "employees.record.absence",
    padrao: "Falta",
    icone: "CalendarX",
    tom: "aviso",
    justificada: true,
  },
  {
    id: "ferias",
    rotulo: "employees.record.vacation",
    padrao: "Férias",
    icone: "Palmtree",
    tom: "info",
    periodo: true,
  },
  {
    id: "licenca",
    rotulo: "employees.record.leave",
    padrao: "Licença",
    icone: "CalendarClock",
    tom: "info",
    periodo: true,
  },
  {
    // O REAJUSTE é o histórico de salário. O valor ATUAL mora na ficha, porque
    // é o que se pergunta todo dia; o histórico mora aqui, porque é o que se
    // pergunta uma vez por ano — e porque um campo sozinho não responde "quando
    // foi o último aumento dela?".
    id: "reajuste",
    rotulo: "employees.record.raise",
    padrao: "Reajuste salarial",
    icone: "TrendingUp",
    tom: "ok",
    valor: true,
  },
  {
    id: "promocao",
    rotulo: "employees.record.promotion",
    padrao: "Promoção",
    icone: "Award",
    tom: "ok",
    cargo: true,
  },
  {
    id: "treinamento",
    rotulo: "employees.record.training",
    padrao: "Treinamento",
    icone: "GraduationCap",
    tom: "ok",
  },
];

const IDS = TIPOS.map((t) => t.id);

// Os degraus da advertência, na ordem da escada.
const GRAVIDADES = [
  { id: "verbal", rotulo: "employees.severity.verbal", padrao: "Verbal" },
  { id: "escrita", rotulo: "employees.severity.written", padrao: "Escrita" },
  { id: "suspensao", rotulo: "employees.severity.suspension", padrao: "Suspensão" },
];

function existe(id) {
  return IDS.includes(String(id || ""));
}

function porId(id) {
  return TIPOS.find((t) => t.id === String(id || ""));
}

function paraTela(t) {
  return TIPOS.map((tipo) => ({
    id: tipo.id,
    label: t ? t(tipo.rotulo) : tipo.padrao,
    icone: tipo.icone,
    tom: tipo.tom,
    // Quais campos o formulário deve mostrar. Ausente é `false` — a tela lê
    // `!!tipo.periodo`, e um tipo novo sem nenhum destes nasce com texto só.
    periodo: !!tipo.periodo,
    valor: !!tipo.valor,
    gravidade: !!tipo.gravidade,
    ciente: !!tipo.ciente,
    justificada: !!tipo.justificada,
    cargo: !!tipo.cargo,
  }));
}

function gravidadesParaTela(t) {
  return GRAVIDADES.map((g) => ({ id: g.id, label: t ? t(g.rotulo) : g.padrao }));
}

module.exports = {
  TIPOS,
  IDS,
  GRAVIDADES,
  existe,
  porId,
  paraTela,
  gravidadesParaTela,
};
