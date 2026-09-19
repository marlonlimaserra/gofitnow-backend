// As ferramentas que o assistente usa para OPERAR o sistema.
//
// Antes, ele operava a TELA: lia o DOM, procurava o botão, clicava, esperava a
// rede e lia de novo. Funcionava, e custava caro em três moedas — dinheiro (os
// retratos de tela eram 89% dos tokens, e mudavam a cada turno, o que estragava
// o cache), tempo (420 ms cegos por ação, mais a re-renderização) e acerto
// ("não achei na lista" quando o item estava lá, só que fora da parte visível).
//
// Aqui ele chama uma função. `buscarExercicio("remada baixa")` não tem como não
// achar o que existe: ou o banco tem, ou não tem.
//
// ── O que estas funções NÃO fazem ──────────────────────────────────────────
//
// Elas não reimplementam regra nenhuma. Cada uma chama o MESMO modelo que o
// controller da tela chama, na mesma ordem, com as mesmas checagens. Um caminho
// paralelo que "quase" faz o mesmo é a origem do bug que ninguém encontra: a
// tela valida o e-mail e a ferramenta não, e um dia aparece uma ficha com
// e-mail impossível que "o sistema aceitou".
//
// Por isso também a PERMISSÃO é a mesma: quem não pode criar pessoa pela tela
// não cria por aqui. A ferramenta recebe o usuário já autenticado e confere a
// permissão dele antes de tocar em qualquer coisa.
const ObjectId = require("mongodb").ObjectId;
const limiteDoPlano = require("./limiteDoPlano.js");
const instanceContext = require("./instance.js");
const examMarkers = require("./examMarkers.js");
const { avisarSemEsperar } = require("./avisar.js");

// O que uma ferramenta devolve quando dá errado.
//
// Erro é RESPOSTA, não exceção: o modelo precisa ler o motivo e decidir o que
// fazer — pedir o dado que falta, tentar outro nome, desistir. Uma exceção
// viraria "erro interno" e ele tentaria de novo, igual.
function erro(motivo, detalhe) {
  return { ok: false, erro: motivo, ...(detalhe ? { detalhe } : {}) };
}

// ── O TETO DO PLANO VALE AQUI TAMBÉM ──────────────────────────────────────
//
// Esta é a falha que a revisão de 19/09/2026 encontrou, e ela é da natureza que
// o cabeçalho deste arquivo promete não existir: **as ferramentas criavam sem
// olhar o teto do plano**. `pessoa_criar` não passava por `limiteDoPlano`, e a
// rota da tela passa — então a conta travada em 50 pessoas criava a 51ª pedindo
// ao assistente. Não era uma brecha de permissão (a permissão era conferida);
// era uma cota que só existia em um dos dois caminhos.
//
// Nada na tela denunciaria: o limite continuaria barrando o botão, e o cliente
// concluiria que o botão é que está com defeito.
//
// Usa `checar`, e não `barrou`: aquele responde 409 num `res` que aqui não
// existe. O motivo volta como RESULTADO, com os números — "50 de 50" é o que
// permite ao modelo dizer o que fazer em seguida, em vez de "não deu".
async function cabeNoPlano(app, chave, contar) {
  const estouro = await limiteDoPlano.checar(app, instanceContext.current(), chave, contar);
  if (!estouro) return null;

  // Os dois casos mandam a pessoa a lugares diferentes, e é por isso que são
  // dois motivos: "não incluído" é conversa com quem vende; "cheio" se resolve
  // apagando algo ou subindo de plano.
  return estouro.code === "not_in_plan"
    ? erro("fora_do_plano", `O plano desta conta não inclui ${chave}.`)
    : erro("teto_do_plano", `O plano permite ${estouro.max} em ${chave}, e já há ${estouro.atual}.`);
}

// ── E OS TETOS DE ESTRUTURA, que são de outra natureza ────────────────────
//
// "Alimentos por refeição", "exercícios por treino", "séries por exercício".
// Três diferenças para os de cima, e a terceira é a que importa aqui: eles
// NUNCA são ilimitados. Vazio quer dizer "o padrão do sistema", porque um teto
// anti-abuso que some quando o painel não responde não é um teto.
//
// A mesma revisão encontrou a mesma falha neles: acrescentar exercício por
// ferramenta passava de trinta sem olhar, um a um, enquanto a tela — que salva o
// treino inteiro de uma vez — recusava o pedido.
async function cabeNaEstrutura(app, chave, quantos) {
  const teto = await limiteDoPlano.tetoDoPlano(app, instanceContext.current(), chave);
  if (Number(quantos) <= teto) return null;

  // `>` e não `>=`: aqui o pedido inteiro chega junto, e trinta com teto trinta
  // é exatamente o permitido.
  return erro("teto_do_plano", `O limite é ${teto} em ${chave}, e o pedido chegaria a ${quantos}.`);
}

// A pessoa, reduzida ao que o assistente precisa.
//
// Nunca o documento inteiro: ele traz senha, salt e token de convite. Isso não
// pode entrar no contexto de um modelo — o que entra no contexto sai na
// resposta em algum momento.
function pessoaPublica(p) {
  if (!p) return null;

  return {
    id: String(p._id),
    nome: p.name,
    email: p.email || "",
    telefone: p.phone || "",
    ativo: p.active === undefined ? true : Boolean(p.active),
  };
}

function treinoPublico(t) {
  if (!t) return null;

  return {
    id: String(t._id),
    nome: t.name,
    pessoaId: t.student ? String(t.student) : null,
    inicio: t.startDate || "",
    fim: t.endDate || "",
    status: t.status || "",
    exercicios: (t.exercises || []).map((e, i) => ({
      posicao: i,
      nome: e.name,
      grupo: e.muscleGroup || "",
      series: (e.sets || []).map((s) => ({
        unidade: s.unit || "reps",
        quantidade: s.quantity || "",
        carga: s.load || "",
        descanso: s.rest || "",
      })),
    })),
  };
}


function dietaPublica(d) {
  if (!d) return null;

  return {
    id: String(d._id),
    nome: d.name,
    pessoaId: d.student ? String(d.student) : null,
    objetivo: d.goal || "",
    inicio: d.startDate || "",
    fim: d.endDate || "",
    metaKcal: d.targetKcal ?? null,
    refeicoes: (d.meals || []).map((m, i) => ({
      posicao: i,
      nome: m.name,
      hora: m.time || "",
      alimentos: (m.foods || []).map((a, j) => ({
        posicao: j,
        nome: a.name,
        quantidade: a.quantity ?? null,
        unidade: a.unit || "g",
        kcal: a.kcal ?? null,
      })),
    })),
  };
}

// A rota de uma dieta.
//
// Ela não tem endereço próprio: mora na ficha da pessoa, numa aba, com o id na
// busca da URL. Montar isto num lugar só evita a divergência entre as
// ferramentas — e o dia em que a tela mudar, muda aqui.
function rotaDaDieta(pessoaId, dietaId) {
  return `/people/${pessoaId}?tab=diet&diet=${dietaId}`;
}

// O financeiro e a avaliação também moram em ABAS da ficha, e por isso mandam
// `recarregar` junto com a rota: quem já está na ficha não navega para lugar
// nenhum, e sem o aviso a tela continuaria mostrando o de antes.
function rotaDoFinanceiro(pessoaId) {
  return `/people/${pessoaId}?tab=finance`;
}

function rotaDaAvaliacao(pessoaId) {
  return `/people/${pessoaId}?tab=assessment`;
}

// A moeda de um lançamento.
//
// Sem pedido, a da conta. Com pedido, ela precisa estar HABILITADA: a moeda
// fica gravada em cada lançamento, e é ela que dá sentido ao número — "50" em
// dólar e "50" em real são valores diferentes, e um relatório que soma os dois
// mente. Aceitar uma moeda que a conta não usa criaria essa soma.
//
// Isto existe porque a ferramenta não tinha o campo: pedir "registra 50 dólares"
// gravava 50 reais, calado.
async function moedaDoLancamento(app, pedida) {
  const conta = await app.api.tenant.currencyOfInstance();
  if (!pedida) return conta?.currency || "BRL";

  const alvo = String(pedida).trim().toUpperCase();
  const habilitadas = conta?.currencies || [conta?.currency].filter(Boolean);

  return habilitadas.includes(alvo) ? alvo : null;
}

// O dinheiro sai daqui como CENTAVOS e como texto pronto.
//
// Só centavos faria o modelo escrever "25000" na resposta ao profissional; só
// texto o impediria de somar. Os dois, e cada um serve a um leitor.
function dinheiro(centavos, moeda) {
  const valor = (Number(centavos) || 0) / 100;
  return {
    centavos: Number(centavos) || 0,
    texto: valor.toLocaleString("pt-BR", { style: "currency", currency: moeda || "BRL" }),
  };
}

function cobrancaPublica(c, pago) {
  const falta = Math.max(0, (c.amount || 0) - (pago || 0));

  return {
    id: String(c._id),
    descricao: c.description || "",
    valor: dinheiro(c.amount, c.currency),
    pago: dinheiro(pago, c.currency),
    falta: dinheiro(falta, c.currency),
    vencimento: c.dueDate ? new Date(c.dueDate).toISOString().slice(0, 10) : "",
    // A situação que a tela mostra, e não a gravada: "quitada" é consequência
    // dos pagamentos cobrirem o valor, e o modelo precisa ler o mesmo que o
    // profissional lê.
    situacao: c.status === "canceled" ? "cancelada" : falta === 0 ? "quitada" : "em aberto",
    daAgenda: Boolean(c.appointment),
  };
}

function compromissoPublico(a, nomes) {
  const quem = nomes?.[String(a.student)];

  return {
    id: String(a._id),
    pessoaId: String(a.student),
    pessoa: quem?.name || "",
    quando: a.date ? new Date(a.date).toISOString() : "",
    minutos: a.minutes || 60,
    titulo: a.title || "",
    situacao: a.status || "scheduled",
    observacao: a.note || "",
  };
}

// A avaliação como ela é LIDA.
//
// Sem percentual de gordura, massa magra ou IMC: eles são derivados do método e
// do protocolo, calculados na tela. Devolvê-los aqui seria devolver um número
// que a próxima conta contradiz — e o modelo passaria a repeti-lo como se fosse
// dado gravado.
function avaliacaoPublica(a) {
  return {
    id: String(a._id),
    pessoaId: String(a.student),
    data: a.date ? new Date(a.date).toISOString().slice(0, 10) : "",
    peso: a.weight ?? null,
    alturaMetros: a.height ?? null,
    dobras: a.skinfolds || null,
    circunferencias: a.circumferences || null,
    rascunho: a.draft === true,
    observacao: a.note || "",
  };
}

function pagamentoPublico(p) {
  return {
    id: String(p._id),
    valor: dinheiro(p.amount, p.currency),
    forma: p.method || "other",
    quando: p.date ? new Date(p.date).toISOString() : "",
    situacao: p.status || "paid",
    cobrancaId: p.charge ? String(p.charge) : null,
    observacao: p.note || "",
  };
}

// ── AS ROTAS DAS TELAS NOVAS ──────────────────────────────────────────────
//
// Constantes e não literais espalhados: o `alvo` é o que faz a tela seguir o
// assistente, e uma rota escrita em cinco lugares é uma rota que diverge na
// primeira vez que a tela muda de endereço.
const ROTA_DAS_UNIDADES = "/configuration/units";
const ROTA_DA_GRADE = "/configuration/group-classes";
const ROTA_DO_DIA = "/aulas";
const ROTA_DOS_PLANOS = "/configuration/plans";
const ROTA_DOS_AULOES = "/aulaoes";

function rotaDaAulaColetiva(id) {
  return `${ROTA_DA_GRADE}?aula=${id}`;
}

// A chamada de um horário. São DUAS chaves porque o que se abre não é a aula, e
// sim um horário dela: a das 07:00 e a das 18:00 são a mesma aula.
function rotaDoDia(aulaId, inicioMinutos) {
  return `${ROTA_DO_DIA}?aula=${aulaId}&h=${inicioMinutos}`;
}

function rotaDoPlano(id) {
  return `${ROTA_DOS_PLANOS}?plano=${id}`;
}

// Minutos desde a meia-noite → "07:05". O relógio de parede é como a grade é
// gravada, e o modelo não deveria precisar fazer esta conta para falar dela.
function horaDeMinutos(n) {
  const minutos = Number(n);
  if (!Number.isInteger(minutos) || minutos < 0) return "";

  const h = Math.floor(minutos / 60);
  return `${String(h).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
}

// O DIA de uma aula, e quem o decide.
//
// Sem `dia` dito, é hoje NO FUSO DA CONTA — nunca no relógio de quem pergunta.
// Um modelo rodando noutro fuso (ou com a data do contêiner errada) gravaria a
// chamada de hoje em ontem, e nada na tela denunciaria.
async function diaDaAula(app, pedido) {
  const dito = String(pedido || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dito)) return dito;

  const fuso = await app.api.tenant.timezoneOfInstance();
  return app.api.groupClass.estadoAgora({ dias: [] }, new Date(), fuso).data;
}

function unidadePublica(u) {
  if (!u) return null;

  return {
    id: String(u._id),
    nome: u.name,
    frase: u.tagline || "",
    // A linha pronta é DERIVADA das partes na gravação. Sai junto com elas: a
    // linha serve para escrever a resposta, as partes para editar uma delas.
    endereco: u.endereco || "",
    cidade: u.cidade || "",
    uf: u.uf || "",
    telefone: u.phone || "",
    whatsapp: u.whatsapp || "",
    email: u.email || "",
    ativa: u.active !== false,
    noMapaVafit: u.noMapa === true,
  };
}

// Os campos que a ferramenta sabe escrever numa unidade.
//
// `undefined` não entra: o modelo do banco grava campo a campo o que recebe, e
// mandar uma chave vazia apagaria o que já estava lá. Quem manda só `cidade`
// muda a cidade e nada mais.
//
// A foto, o ponto do mapa e a marca do mapa de parceiros NÃO estão aqui, e é de
// propósito: a primeira precisa de bytes, o segundo sai de geocodificação, e o
// terceiro manda um dado do cliente para uma página nossa aberta a qualquer um
// — consentimento não se dá por assistente.
function camposDaUnidade(args, base = {}) {
  const de = {
    name: args.nome,
    tagline: args.frase,
    cep: args.cep,
    logradouro: args.logradouro,
    numero: args.numero,
    complemento: args.complemento,
    bairro: args.bairro,
    cidade: args.cidade,
    uf: args.uf,
    phone: args.telefone,
    whatsapp: args.whatsapp,
    email: args.email,
    active: args.ativa,
  };

  return { ...somenteOsDitos(de), ...base };
}

function aulaColetivaPublica(a) {
  if (!a) return null;

  return {
    id: String(a._id),
    nome: a.name,
    descricao: a.description || "",
    sala: a.sala || "",
    // 0=domingo a 6=sábado, como o banco guarda. Traduzir para nome de dia aqui
    // obrigaria a destraduzir na hora de editar.
    dias: a.dias || [],
    horarios: (a.horarios || []).map((h) => ({
      inicio: horaDeMinutos(h.inicio),
      fim: horaDeMinutos(h.fim),
      inicioMinutos: h.inicio,
    })),
    vagas: a.seats || 0,
    unidadeIds: (a.units || []).map(String),
    checkinAbre: a.checkinAbre ?? 30,
    checkinFecha: a.checkinFecha ?? 15,
    variosHorarios: a.variosHorarios === true,
    ativa: a.active !== false,
  };
}

function camposDaAula(args, base = {}) {
  const de = {
    name: args.nome,
    description: args.descricao,
    sala: args.sala,
    dias: args.dias,
    horarios: args.horarios,
    seats: args.vagas,
    units: args.unidadeIds,
    checkinAbre: args.checkinAbre,
    checkinFecha: args.checkinFecha,
    variosHorarios: args.variosHorarios,
    active: args.ativa,
  };

  return { ...somenteOsDitos(de), ...base };
}

// Uma linha da lista de presença.
function inscritoPublico(l) {
  return {
    // O id do CHECK-IN, e não o da pessoa: é ele que `aula_coletiva_presenca` e
    // `aula_coletiva_tirar` pedem. A mesma pessoa pode ter duas linhas no
    // mesmo dia (dois horários), e o id dela não distinguiria uma da outra.
    id: String(l._id),
    pessoaId: String(l.person),
    nome: l.name || "",
    presenca: l.presenca || "inscrito",
  };
}

function planoPublico(p) {
  if (!p) return null;

  return {
    id: String(p._id),
    nome: p.name,
    frase: p.tagline || "",
    descricao: p.description || "",
    valor: dinheiro(p.amount, p.currency),
    cadencia: p.cadencia || "monthly",
    fidelidadeMeses: p.fidelidadeMeses || 0,
    unidadeIds: (p.units || []).map(String),
    destaque: p.destaque === true,
    ativo: p.active !== false,
  };
}

// As cores, a capa, os benefícios e o botão de comprar não entram por aqui: são
// a APARÊNCIA do cartão, escolhida olhando a prévia, e um modelo que pinta um
// cartão sem ver o resultado acerta por sorte.
function camposDoPlano(args, base = {}) {
  const de = {
    name: args.nome,
    tagline: args.frase,
    description: args.descricao,
    // O modelo do banco converte para centavos; aqui o valor chega como a
    // pessoa fala, que é o que o schema pede.
    amount: args.valor,
    cadencia: args.cadencia,
    fidelidadeMeses: args.fidelidadeMeses,
    units: args.unidadeIds,
    destaque: args.destaque,
    active: args.ativo,
  };

  return { ...somenteOsDitos(de), ...base };
}

function aulaoPublico(a, inscritos) {
  return {
    id: String(a._id),
    nome: a.name,
    apelido: a.slug || "",
    quando: a.startsAt ? new Date(a.startsAt).toISOString() : "",
    minutos: a.minutes || 60,
    endereco: a.address || "",
    vagas: a.seats || 0,
    inscritos: inscritos || 0,
    valor: dinheiro(a.priceCents, a.currency),
    publicado: a.published === true,
  };
}

// O que veio no pedido, e só isso.
//
// A diferença entre "não mandou" e "mandou vazio" é a diferença entre manter e
// APAGAR, e é o contrato que todas as ferramentas de edição daqui prometem:
// *"mande só os campos que devem mudar"*.
function somenteOsDitos(objeto) {
  const saida = {};
  for (const [chave, valor] of Object.entries(objeto)) {
    if (valor !== undefined) saida[chave] = valor;
  }
  return saida;
}

// ── AS ÁREAS CLÍNICAS ─────────────────────────────────────────────────────
//
// Anamnese, exames, suplementação e prescrição entraram no MCP em 19/09/2026,
// fechando a revisão. Eram as quatro telas antigas que o assistente não
// alcançava — e as quatro que respondem as perguntas mais comuns de quem está
// com a ficha aberta: "ela é alérgica a quê?", "como está a vitamina D dela?",
// "ela toma creatina?", "o que foi receitado?".
//
// O nome dos campos sai em PORTUGUÊS aqui e entra em inglês no banco. Não é
// enfeite: o modelo lê a resposta e escreve a frase para o profissional, e um
// "familyHistory" no meio dela é um vazamento do esquema.
const CAMPOS_DA_ANAMNESE = {
  queixaPrincipal: "mainComplaint",
  doencas: "conditions",
  medicamentos: "medications",
  alergias: "allergies",
  cirurgias: "surgeries",
  historicoFamiliar: "familyHistory",
  atividade: "activity",
  preferencias: "preferences",
  aversoes: "aversions",
  restricoes: "restrictions",
  quemCozinha: "whoCooks",
  exames: "exams",
  observacoes: "notes",
  horasDeSono: "sleepHours",
  aguaLitros: "water",
  refeicoesPorDia: "mealsPerDay",
  qualidadeDoSono: "sleepQuality",
  alcool: "alcohol",
  fumo: "smoking",
  intestino: "bowel",
  estresse: "stress",
};

function anamnesePublica(a) {
  if (!a) return null;

  const saida = {};
  for (const [nosso, deles] of Object.entries(CAMPOS_DA_ANAMNESE)) {
    // Só o que TEM valor. Devolver vinte e um campos vazios encheria o contexto
    // do modelo de nada, e ele repetiria "não informado" vinte e uma vezes.
    const valor = a[deles];
    if (valor !== undefined && valor !== null && valor !== "") saida[nosso] = valor;
  }

  // QUEM respondeu. É diferente de quando foi atualizada: a anamnese pode ter
  // sido preenchida pela própria pessoa, por um link, e isso muda como se lê o
  // que está escrito ali.
  saida.respondidaPelaPessoaEm = a.answeredByPersonAt
    ? new Date(a.answeredByPersonAt).toISOString()
    : null;

  return saida;
}

function camposDaAnamnese(args) {
  const saida = {};
  for (const [nosso, deles] of Object.entries(CAMPOS_DA_ANAMNESE)) {
    if (args[nosso] !== undefined) saida[deles] = args[nosso];
  }
  return saida;
}

// Um marcador de exame, na ida.
//
// `chave` OU `nome`, nunca os dois: o modelo do banco descarta o nome quando há
// chave, e mandar os dois faria a ferramenta prometer o que ele não guarda.
function marcadoresDoExame(lista) {
  return (Array.isArray(lista) ? lista : []).map((m) => ({
    key: m?.chave || "",
    name: m?.chave ? "" : m?.nome || "",
    value: m?.valor,
    unit: m?.unidade || "",
    low: m?.minimo,
    high: m?.maximo,
  }));
}

function camposDoExame(args) {
  const de = {
    collectedAt: args.data,
    lab: args.laboratorio,
    notes: args.observacao,
    markers: args.marcadores === undefined ? undefined : marcadoresDoExame(args.marcadores),
  };

  return somenteOsDitos(de);
}

function examePublico(e) {
  if (!e) return null;

  return {
    id: String(e._id),
    pessoaId: String(e.student),
    data: e.collectedAt || "",
    laboratorio: e.lab || "",
    observacao: e.notes || "",
    marcadores: (e.markers || []).map((m) => ({
      chave: m.key || "",
      nome: m.name || m.key || "",
      valor: m.value,
      unidade: m.unit || "",
      minimo: m.low,
      maximo: m.high,
      // FORA DA FAIXA é conta de leitura, e não dado gravado: a faixa é
      // editável, e congelar o veredito faria ele contradizer a própria linha.
      // `low` e `high` aqui são o VEREDITO, não a faixa — ver `flag` no modelo.
      fora: m.flag || null,
    })),
  };
}

function camposDoSuplemento(args, base = {}) {
  const de = {
    name: args.nome,
    brand: args.marca,
    dose: args.dose,
    unit: args.unidade,
    moment: args.momento,
    weekdays: args.diasDaSemana,
    notes: args.observacao,
    startDate: args.inicio,
    endDate: args.fim,
  };

  return { ...somenteOsDitos(de), ...base };
}

function suplementoPublico(s) {
  if (!s) return null;

  return {
    id: String(s._id),
    pessoaId: String(s.student),
    nome: s.name,
    marca: s.brand || "",
    dose: s.dose ?? null,
    unidade: s.unit || "",
    momento: s.moment || "any",
    // Vazio é TODO DIA, e não "nenhum dia". Guardar os sete e o vazio como
    // coisas diferentes seria duas formas de dizer a mesma coisa.
    diasDaSemana: s.weekdays || [],
    observacao: s.notes || "",
    inicio: s.startDate || "",
    fim: s.endDate || "",
    // current / future / past, as mesmas três palavras do treino e da dieta.
    situacao: s.status || "current",
  };
}

// Os itens de uma receita, na ida. O modelo do banco descarta item sem nome —
// aqui o nome é obrigatório no schema, e a conversão é só de vocabulário.
function itensDaPrescricao(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((i) => ({
      name: String(i?.nome || "").trim(),
      dose: i?.dose || "",
      posology: i?.posologia || "",
      duration: i?.duracao || "",
      notes: i?.observacao || "",
    }))
    .filter((i) => i.name.length > 0);
}

// `comItens` decide se os itens saem.
//
// A LISTA não os traz: dez receitas com oito itens cada são oitenta linhas para
// responder "quantas receitas ela tem". `prescricao_ver` traz, porque é essa a
// pergunta dele.
function prescricaoPublica(p, comItens) {
  if (!p) return null;

  const base = {
    id: String(p._id),
    pessoaId: String(p.student),
    tipo: p.type || "medication",
    titulo: p.title || "",
    data: p.date || "",
    valeAte: p.validUntil || "",
    itens: p.itemCount ?? (p.items || []).length,
    observacoes: p.notes || "",
    conselho: p.council || "",
  };

  if (!comItens) return base;

  return {
    ...base,
    conteudo: (p.items || []).map((i) => ({
      nome: i.name,
      dose: i.dose || "",
      posologia: i.posology || "",
      duracao: i.duration || "",
      observacao: i.notes || "",
    })),
  };
}

// ── O catálogo ─────────────────────────────────────────────────────────────
//
// Cada ferramenta é `{ nome, descricao, permissao, schema, executar }`.
//
// `schema` é JSON Schema, e é ele que o modelo lê. As descrições são escritas
// PARA ELE: elas dizem quando usar a ferramenta e o que a resposta significa,
// não o que o código faz. "Devolve a lista" não ajuda ninguém; "use quando a
// pessoa disser um nome e você precisar do id" ajuda.
//
// `alvo` no retorno é o que o front usa para abrir a tela certa e destacar o
// que mudou — é assim que a pessoa VÊ a ação acontecer sem o modelo ter tocado
// na tela.
//
// ── `naVoz`: QUEM CABE NO MODO DE VOZ ─────────────────────────────────────
//
// O modo escrito e o MCP carregam o catálogo INTEIRO. A voz não pode: na
// OpenAI realtime, instrução e catálogo são relidos por completo a cada
// resposta, contra um limite de 40.000 tokens por minuto. Eles são o piso do
// gasto, pagos antes de qualquer palavra — e com o catálogo cheio (26 mil
// caracteres) cinco frases seguidas fecham a conta e a conversa passa a pedir
// tempo no meio.
//
// Foi o que a revisão de 19/09/2026 esbarrou: as 23 ferramentas novas levaram o
// fixo de ~20 mil para 33 mil caracteres, e o teste do teto ficou vermelho na
// hora. A resposta certa não era subir o teto — era escolher.
//
// O critério é o GESTO, não a importância: a voz é usada de pé, no salão, com o
// celular no bolso. "Quem está na aula das sete", "marca presença da Bruna",
// "acrescenta remada" são coisas que se dizem em voz alta. Cadastrar uma
// unidade, montar a grade da semana ou mexer no cardápio de planos é trabalho
// sentado, e quem o faz está olhando a tela — onde o assistente escrito tem
// tudo.
const FERRAMENTAS = [
  // ── Pessoas ──────────────────────────────────────────────────────────────
  {
    nome: "pessoa_buscar",
    naVoz: true,
    descricao:
      "Procura pessoas pelo nome ou e-mail. Use SEMPRE antes de editar ou excluir: " +
      "as outras ferramentas pedem o id, e quem fala diz o nome.",
    permissao: "people.view",
    schema: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Parte do nome ou do e-mail." },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        unidadeId: {
          type: "string",
          description:
            "Só quem é desta unidade. É estrito: quem não foi atribuído a nenhuma não aparece.",
        },
      },
      required: ["termo"],
    },
    async executar(app, user, args) {
      const { rows } = await app.api.user.pageStudents(user._id, {
        search: String(args.termo || ""),
        limit: Math.min(50, Number(args.limite) || 10),
        page: 1,
        // A mesma LENTE da tela, e com a mesma regra: estrita. Deixar quem não
        // tem unidade aparecer junto faria "os alunos de Paraty" devolver a
        // conta inteira — que é como uma lente vira um filtro que não filtra.
        ...(args.unidadeId ? { unit: String(args.unidadeId) } : {}),
      });

      const pessoas = rows.map(pessoaPublica);

      // Achou UMA: a tela vai junto.
      //
      // Procurar alguém pelo nome quase sempre é o começo de "e agora faz X
      // com ela" — abrir a ficha adianta o passo seguinte e mostra que a busca
      // acertou. Com várias, não: navegar para uma delas seria escolher pela
      // pessoa, e para a lista sem o filtro seria pior que ficar parado, porque
      // ela teria de buscar de novo à mão.
      const alvo =
        pessoas.length === 1
          ? { rota: `/people/${pessoas[0].id}`, destacar: `person:${pessoas[0].id}` }
          : undefined;

      return { ok: true, pessoas, ...(alvo ? { alvo } : {}) };
    },
  },

  {
    nome: "pessoa_criar",
    naVoz: true,
    descricao:
      "Cadastra uma pessoa. O e-mail é OPCIONAL — sem ele a ficha existe inteira, " +
      "só não dá login. Não invente e-mail para preencher: um endereço falso ocupa " +
      "o índice único e impede o de verdade depois.",
    permissao: "people.create",
    schema: {
      type: "object",
      properties: {
        nome: { type: "string", minLength: 2 },
        email: { type: "string" },
        telefone: { type: "string" },
      },
      required: ["nome"],
    },
    async executar(app, user, args) {
      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto", "O nome precisa de ao menos 2 letras.");

      const email = String(args.email || "").trim().toLowerCase();
      if (email && !app.validator.isEmail(email)) {
        return erro("email_invalido", "Escreva um e-mail válido ou deixe em branco.");
      }

      if (email && (await app.api.user.dataByEmail(email))) {
        return erro("email_em_uso", "Já existe alguém com este e-mail.");
      }

      // O teto do plano, o mesmo que a rota da tela confere.
      const cheio = await cabeNoPlano(
        app,
        "people",
        limiteDoPlano.contarNa(app, "users", { type: "student" })
      );
      if (cheio) return cheio;

      const id = await app.api.user.insertStudent(user._id, {
        name: nome,
        email,
        phone: String(args.telefone || "").trim(),
      });

      const criada = await app.api.user.dataStudent(user._id, id);

      return {
        ok: true,
        pessoa: pessoaPublica(criada),
        alvo: { rota: `/people/${id}`, destacar: `person:${id}` },
      };
    },
  },

  {
    nome: "pessoa_editar",
    descricao:
      "Muda dados de uma pessoa. Mande SÓ os campos que devem mudar — o que não " +
      "vier fica como está.",
    permissao: "people.edit",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        email: { type: "string", description: "Vazio remove o e-mail." },
        telefone: { type: "string" },
        ativo: { type: "boolean" },
        unidadeId: {
          type: "string",
          description:
            "A unidade de que ela faz parte. Pegue o id em unidade_listar. " +
            'String vazia tira a pessoa de qualquer unidade.',
        },
      },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!alvo) return erro("pessoa_nao_encontrada");

      const mudanca = {};
      if (args.nome !== undefined) {
        const nome = String(args.nome).trim();
        if (nome.length < 2) return erro("nome_curto");
        mudanca.name = nome;
      }

      if (args.email !== undefined) {
        const email = String(args.email).trim().toLowerCase();
        if (email && !app.validator.isEmail(email)) return erro("email_invalido");

        // A mesma regra da tela: o e-mail é o login. Tirá-lo de quem tem senha
        // deixaria a pessoa sem porta de entrada, e sem aviso.
        if (!email && alvo.password) {
          return erro("email_e_login", "Esta pessoa entra no app por este e-mail.");
        }

        if (email) {
          const outro = await app.api.user.dataByEmail(email);
          if (outro && String(outro._id) !== String(alvo._id)) return erro("email_em_uso");
        }

        mudanca.email = email;
      }

      if (args.telefone !== undefined) mudanca.phone = String(args.telefone).trim();
      if (args.ativo !== undefined) mudanca.active = args.ativo ? 1 : 0;

      // A UNIDADE. Confere que ela EXISTE antes de gravar: um id chutado seria
      // aceito pelo modelo do banco como um vínculo qualquer, e a pessoa
      // sumiria da lista de todas as unidades — visível só em "Todas", sem
      // ninguém entender por quê.
      if (args.unidadeId !== undefined) {
        const id = String(args.unidadeId).trim();
        if (id && !(await app.api.unit.data(id))) return erro("unidade_nao_encontrada");
        mudanca.unit = id;
      }

      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      await app.api.user.updateStudent(user._id, args.pessoaId, mudanca);
      const depois = await app.api.user.dataStudent(user._id, args.pessoaId);

      return {
        ok: true,
        pessoa: pessoaPublica(depois),
        alvo: { rota: `/people/${args.pessoaId}`, destacar: `person:${args.pessoaId}` },
      };
    },
  },

  {
    nome: "pessoa_excluir",
    descricao:
      "Apaga uma ficha e tudo o que pende dela. NÃO tem desfazer: confirme com quem " +
      "pediu antes de chamar, dizendo o nome de quem vai sumir.",
    permissao: "people.delete",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!alvo) return erro("pessoa_nao_encontrada");

      await app.api.user.deleteStudent(user._id, args.pessoaId);
      // A sessão dela morre junto: sem isto, quem já estava logado continuaria
      // dentro de uma conta que não existe mais.
      await app.api.auth.deleteAllTokensByUser(args.pessoaId);

      return { ok: true, removida: alvo.name, alvo: { rota: "/people" } };
    },
  },

  // ── Treinos ──────────────────────────────────────────────────────────────
  {
    nome: "exercicio_buscar",
    naVoz: true,
    descricao:
      "Procura no CATÁLOGO de exercícios. Use antes de acrescentar um exercício a um " +
      "treino: o resultado traz o id, o nome exato e o grupo muscular. Se vier vazio, " +
      "diga que não existe no catálogo em vez de inventar um nome.",
    permissao: "workouts.view",
    schema: {
      type: "object",
      properties: {
        termo: { type: "string" },
        grupo: { type: "string", description: "Grupo muscular, para estreitar." },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["termo"],
    },
    async executar(app, user, args) {
      const { rows } = await app.api.exercise.list({
        search: String(args.termo || ""),
        muscleGroup: args.grupo || "",
        limit: Math.min(50, Number(args.limite) || 10),
        page: 1,
      });

      return {
        ok: true,
        exercicios: rows.map((e) => ({
          id: String(e._id),
          nome: e.name,
          grupo: e.muscleGroup || "",
        })),
        // Se a pessoa está montando um treino, ela tem o painel de exercícios
        // aberto na frente dela. Mandar o TERMO faz a lista dela mostrar o mesmo
        // que o assistente está vendo — em vez de ele falar de um exercício que
        // não está na tela de ninguém.
        alvo: { busca: { onde: "exercicios", termo: String(args.termo || "") } },
      };
    },
  },

  {
    nome: "treino_listar",
    naVoz: true,
    descricao: "Lista os treinos de uma pessoa, do mais novo para o mais antigo.",
    permissao: "workouts.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const rows = await app.api.workout.list(user._id, args.pessoaId);

      return {
        ok: true,
        // Ler a lista é sempre o começo de mexer em um deles: a tela abre junto.
        alvo: { rota: `/people/${args.pessoaId}/workouts` },
        treinos: rows.map((t) => ({
          id: String(t._id),
          nome: t.name,
          status: t.status || "",
          exercicios: (t.exercises || []).length,
        })),
      };
    },
  },

  {
    nome: "treino_ver",
    naVoz: true,
    descricao:
      "Abre um treino inteiro, com os exercícios e as séries de cada um. A POSIÇÃO " +
      "de cada exercício vem no resultado — é ela que as outras ferramentas pedem.",
    permissao: "workouts.view",
    schema: {
      type: "object",
      properties: { treinoId: { type: "string" } },
      required: ["treinoId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      return {
        ok: true,
        treino: treinoPublico(treino),
        alvo: {
          rota: `/people/${treino.student}/workouts/${args.treinoId}`,
          destacar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_criar",
    naVoz: true,
    descricao: "Cria um treino vazio para uma pessoa. Depois use treino_exercicio_adicionar.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        inicio: { type: "string", description: "AAAA-MM-DD" },
        fim: { type: "string", description: "AAAA-MM-DD" },
      },
      required: ["pessoaId", "nome"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto");

      if (args.inicio && args.fim && args.fim < args.inicio) {
        return erro("fim_antes_do_inicio");
      }

      const cheio = await cabeNoPlano(app, "workouts", limiteDoPlano.contarNa(app, "workouts"));
      if (cheio) return cheio;

      const id = await app.api.workout.insert(user._id, args.pessoaId, {
        name: nome,
        startDate: args.inicio || "",
        endDate: args.fim || "",
        // Sem professor dito, é quem está operando — a mesma regra da tela.
        teacherName: user.name,
      });

      const criado = await app.api.workout.data(user._id, id);

      return {
        ok: true,
        treino: treinoPublico(criado),
        alvo: { rota: `/people/${args.pessoaId}/workouts/${id}`, destacar: `workout:${id}` },
      };
    },
  },

  {
    nome: "treino_editar",
    descricao: "Muda nome, datas ou status de um treino. Só o que vier muda.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        inicio: { type: "string" },
        fim: { type: "string" },
      },
      required: ["treinoId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const mudanca = {};
      if (args.nome !== undefined) {
        const nome = String(args.nome).trim();
        if (nome.length < 2) return erro("nome_curto");
        mudanca.name = nome;
      }
      if (args.inicio !== undefined) mudanca.startDate = args.inicio;
      if (args.fim !== undefined) mudanca.endDate = args.fim;

      const inicio = mudanca.startDate ?? treino.startDate;
      const fim = mudanca.fim ?? mudanca.endDate ?? treino.endDate;
      if (inicio && fim && fim < inicio) return erro("fim_antes_do_inicio");

      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      await app.api.workout.update(user._id, args.treinoId, mudanca);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          destacar: `workout:${args.treinoId}`,
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_excluir",
    descricao: "Apaga um treino inteiro. Não tem desfazer.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: { treinoId: { type: "string" } },
      required: ["treinoId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      await app.api.workout.delete(user._id, args.treinoId);

      return {
        ok: true,
        removido: treino.name,
        alvo: { rota: `/people/${treino.student}/workouts` },
      };
    },
  },

  {
    nome: "treino_exercicio_adicionar",
    naVoz: true,
    descricao:
      "Acrescenta um exercício ao fim do treino, já com as séries. Passe o " +
      "exercicioId que veio de exercicio_buscar — o nome é copiado do catálogo, " +
      "então o treino continua legível se o exercício sair de lá depois.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        exercicioId: { type: "string" },
        series: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Quantas séries criar. Cada uma nasce com a quantidade e a carga abaixo.",
        },
        quantidade: { type: "string", description: 'Repetições ou tempo. Ex.: "12".' },
        unidade: { type: "string", enum: ["reps", "seconds", "minutes", "meters"] },
        carga: { type: "string", description: 'Ex.: "20kg".' },
        descanso: { type: "string", description: 'Ex.: "60s".' },
      },
      required: ["treinoId", "exercicioId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const doCatalogo = await app.api.exercise.data(args.exercicioId);
      if (!doCatalogo) return erro("exercicio_nao_encontrado");

      // A PRESCRIÇÃO padrão do exercício, quando ninguém disse outra coisa.
      //
      // O profissional que cadastrou "Remada baixa com triângulo" com 4 séries
      // de 15/12/10/8 espera que ela chegue assim — pela tela ou pela voz, dá no
      // mesmo. Se ele DISSE as séries no pedido, o que ele disse vence: quem
      // fala "acrescenta remada, 3 séries de 12" está prescrevendo agora.
      const disseAlgo =
        args.series !== undefined ||
        args.quantidade !== undefined ||
        args.carga !== undefined ||
        args.descanso !== undefined ||
        args.unidade !== undefined;

      const padrao = doCatalogo.defaultSets || [];

      const series =
        !disseAlgo && padrao.length
          ? padrao.map((s) => ({ ...s }))
          : Array.from({ length: Math.min(20, Math.max(1, Number(args.series) || 1)) }, () => ({
              unit: args.unidade || "reps",
              quantity: args.quantidade === undefined ? "" : String(args.quantidade),
              load: args.carga === undefined ? "" : String(args.carga),
              rest: args.descanso === undefined ? "" : String(args.descanso),
            }));

      const lista = [
        ...(treino.exercises || []),
        {
          exerciseId: doCatalogo._id,
          name: doCatalogo.name,
          muscleGroup: doCatalogo.muscleGroup || "",
          thumbUrl: doCatalogo.thumbUrl || null,
          videoUrl: doCatalogo.videoUrl || null,
          method: !disseAlgo ? doCatalogo.defaultMethod || "" : "",
          goal: !disseAlgo ? doCatalogo.defaultGoal || "" : "",
          tip: doCatalogo.defaultTip || "",
          sets: series,
        },
      ];

      // Os DOIS tetos de estrutura, na mesma ordem da rota da tela. O segundo é
      // por exercício e não somado: o limite é "séries por exercício", e somar
      // diria "seu plano permite 20" a quem tem dez exercícios de três.
      const demais =
        (await cabeNaEstrutura(app, "exercisesPerWorkout", lista.length)) ||
        (await cabeNaEstrutura(app, "setsPerExercise", series.length));
      if (demais) return demais;

      await app.api.workout.saveExercises(user._id, args.treinoId, lista);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          destacar: `exercise:${lista.length - 1}`,
          // Quem JÁ está nesta tela não tem para onde navegar: o que ela precisa
          // é buscar o treino de novo. Sem isto, o exercício entra no banco e a
          // lista na frente da pessoa continua a mesma — pior que não ter feito
          // nada, porque parece que funcionou e não mudou.
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_exercicio_editar",
    naVoz: true,
    descricao:
      "Muda as séries de UM exercício do treino, pela posição (0 é o primeiro). " +
      "Use treino_ver antes para saber a posição.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
        series: { type: "integer", minimum: 1, maximum: 20 },
        quantidade: { type: "string" },
        unidade: { type: "string", enum: ["reps", "seconds", "minutes", "meters"] },
        carga: { type: "string" },
        descanso: { type: "string" },
      },
      required: ["treinoId", "posicao"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const lista = [...(treino.exercises || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O treino tem ${lista.length} exercícios.`);

      // Quantas séries: a nova quantidade, ou as que já existem.
      const quantas = args.series ? Math.min(20, Math.max(1, Number(args.series))) : null;
      const atuais = alvo.sets || [];
      const total = quantas || atuais.length || 1;

      const series = Array.from({ length: total }, (_, i) => {
        const antes = atuais[i] || {};

        // Campo não mandado mantém o que a série já tinha: quem pede "coloca a
        // carga" não está pedindo para apagar as repetições.
        return {
          unit: args.unidade || antes.unit || "reps",
          quantity: args.quantidade === undefined ? antes.quantity || "" : String(args.quantidade),
          load: args.carga === undefined ? antes.load || "" : String(args.carga),
          rest: args.descanso === undefined ? antes.rest || "" : String(args.descanso),
          intensity: antes.intensity || "",
          speed: antes.speed || "",
        };
      });

      lista[args.posicao] = { ...alvo, sets: series };

      const demais = await cabeNaEstrutura(app, "setsPerExercise", series.length);
      if (demais) return demais;

      await app.api.workout.saveExercises(user._id, args.treinoId, lista);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          destacar: `exercise:${args.posicao}`,
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_exercicio_remover",
    naVoz: true,
    descricao: "Tira um exercício do treino, pela posição (0 é o primeiro).",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
      },
      required: ["treinoId", "posicao"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const lista = [...(treino.exercises || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O treino tem ${lista.length} exercícios.`);

      lista.splice(args.posicao, 1);

      await app.api.workout.saveExercises(user._id, args.treinoId, lista);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        removido: alvo.name,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  // ── Dietas ───────────────────────────────────────────────────────────────
  {
    nome: "dieta_listar",
    naVoz: true,
    descricao: "Lista os planos alimentares de uma pessoa.",
    permissao: "diets.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const rows = await app.api.diet.list(user._id, args.pessoaId);

      return {
        ok: true,
        alvo: { rota: `/people/${args.pessoaId}?tab=diet` },
        dietas: rows.map((d) => ({
          id: String(d._id),
          nome: d.name,
          status: d.status || "",
          refeicoes: (d.meals || []).length,
        })),
      };
    },
  },

  {
    nome: "dieta_ver",
    naVoz: true,
    descricao:
      "Abre um plano inteiro: refeições, horários e alimentos de cada uma. A " +
      "POSIÇÃO da refeição e a do alimento vêm no resultado — são elas que as " +
      "outras ferramentas pedem.",
    permissao: "diets.view",
    schema: {
      type: "object",
      properties: { dietaId: { type: "string" } },
      required: ["dietaId"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      return {
        ok: true,
        dieta: dietaPublica(dieta),
        alvo: {
          rota: rotaDaDieta(dieta.student, args.dietaId),
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "dieta_criar",
    naVoz: true,
    descricao:
      "Cria um plano alimentar vazio. Depois use refeicao_adicionar. `diasDaSemana` " +
      "serve para o caso comum de um plano para dia de treino e outro para descanso.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        objetivo: { type: "string" },
        inicio: { type: "string", description: "AAAA-MM-DD" },
        fim: { type: "string", description: "AAAA-MM-DD" },
        metaKcal: { type: "number" },
        diasDaSemana: {
          type: "array",
          items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
        },
      },
      required: ["pessoaId", "nome"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto");

      if (args.inicio && args.fim && args.fim < args.inicio) return erro("fim_antes_do_inicio");

      const cheio = await cabeNoPlano(app, "diets", limiteDoPlano.contarNa(app, "diets"));
      if (cheio) return cheio;

      const id = await app.api.diet.insert(user._id, args.pessoaId, {
        name: nome,
        goal: args.objetivo || "",
        startDate: args.inicio || "",
        endDate: args.fim || "",
        targetKcal: args.metaKcal,
        weekdays: args.diasDaSemana,
      });

      const criada = await app.api.diet.data(user._id, id);

      return {
        ok: true,
        dieta: dietaPublica(criada),
        // `recarregar` aqui não é redundante com `rota`: quem já está na ficha
        // da pessoa não NAVEGA para lugar nenhum — o plano vive na busca da
        // URL, não no caminho. Sem este aviso, o plano nasce no banco e a lista
        // na frente do profissional continua sem ele.
        alvo: {
          rota: rotaDaDieta(args.pessoaId, id),
          destacar: `diet:${id}`,
          recarregar: `diet:${id}`,
        },
      };
    },
  },

  {
    nome: "dieta_editar",
    descricao: "Muda nome, objetivo, datas ou metas do plano. Só o que vier muda.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        objetivo: { type: "string" },
        inicio: { type: "string" },
        fim: { type: "string" },
        metaKcal: { type: "number" },
      },
      required: ["dietaId"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const mudanca = {};
      if (args.nome !== undefined) {
        const nome = String(args.nome).trim();
        if (nome.length < 2) return erro("nome_curto");
        mudanca.name = nome;
      }
      if (args.objetivo !== undefined) mudanca.goal = args.objetivo;
      if (args.inicio !== undefined) mudanca.startDate = args.inicio;
      if (args.fim !== undefined) mudanca.endDate = args.fim;
      if (args.metaKcal !== undefined) mudanca.targetKcal = args.metaKcal;

      const inicio = mudanca.startDate ?? dieta.startDate;
      const fim = mudanca.endDate ?? dieta.endDate;
      if (inicio && fim && fim < inicio) return erro("fim_antes_do_inicio");

      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      await app.api.diet.update(user._id, args.dietaId, mudanca);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "dieta_excluir",
    descricao: "Apaga um plano alimentar inteiro. Não tem desfazer.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: { dietaId: { type: "string" } },
      required: ["dietaId"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      await app.api.diet.delete(user._id, args.dietaId);

      return {
        ok: true,
        removida: dieta.name,
        // Mesmo motivo de `dieta_criar`: sem `recarregar`, o plano some do banco
        // e continua na lista de quem está com a ficha aberta.
        alvo: {
          rota: `/people/${dieta.student}?tab=diet`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_adicionar",
    naVoz: true,
    descricao:
      "Acrescenta uma refeição ao plano, no fim. A hora vai como HH:MM — é hora " +
      "do DIA, não data: as 07:00 de segunda e as de terça são a mesma refeição.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        nome: { type: "string", description: 'Ex.: "Café da manhã".' },
        hora: { type: "string", description: "HH:MM" },
        observacao: { type: "string" },
      },
      required: ["dietaId", "nome"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const hora = String(args.hora || "");
      if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
        return erro("hora_invalida", "Escreva como HH:MM, das 00:00 às 23:59.");
      }

      const lista = [
        ...(dieta.meals || []),
        { name: String(args.nome).trim(), time: hora, note: args.observacao || "", foods: [] },
      ];

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${lista.length - 1}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_editar",
    descricao: "Muda nome, hora ou observação de uma refeição, pela posição (0 é a primeira).",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
        nome: { type: "string" },
        hora: { type: "string" },
        observacao: { type: "string" },
      },
      required: ["dietaId", "posicao"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      if (args.hora !== undefined && args.hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(args.hora)) {
        return erro("hora_invalida");
      }

      lista[args.posicao] = {
        ...alvo,
        name: args.nome === undefined ? alvo.name : String(args.nome).trim(),
        time: args.hora === undefined ? alvo.time : String(args.hora),
        note: args.observacao === undefined ? alvo.note : String(args.observacao),
      };

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${args.posicao}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_remover",
    descricao: "Tira uma refeição do plano, pela posição, com tudo o que há nela.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
      },
      required: ["dietaId", "posicao"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      lista.splice(args.posicao, 1);

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        removida: alvo.name,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "alimento_buscar",
    naVoz: true,
    descricao:
      "Procura no catálogo de alimentos. O resultado traz o id e os valores por " +
      "porção. Se vier vazio, dá para acrescentar o alimento à refeição só pelo " +
      "nome — mas aí ele vai sem valor nutricional, e o total do dia não conta.",
    permissao: "diets.view",
    schema: {
      type: "object",
      properties: {
        termo: { type: "string" },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["termo"],
    },
    async executar(app, user, args) {
      const { rows } = await app.api.food.list({
        search: String(args.termo || ""),
        limit: Math.min(50, Number(args.limite) || 10),
        page: 1,
      });

      return {
        ok: true,
        alimentos: rows.map((f) => ({
          id: String(f._id),
          nome: f.name,
          categoria: f.category || "",
          porcao: f.portion ?? null,
          kcal: f.kcal ?? null,
          proteina: f.protein ?? null,
          carboidrato: f.carbs ?? null,
          gordura: f.fat ?? null,
        })),
      };
    },
  },

  {
    nome: "refeicao_alimento_adicionar",
    naVoz: true,
    descricao:
      "Põe um alimento numa refeição. Prefira o alimentoId vindo de " +
      "alimento_buscar: os valores nutricionais são copiados dele e proporcionais " +
      "à quantidade. Sem id, entra só o nome — e o total do dia não conta esse item.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        refeicao: { type: "integer", minimum: 0, description: "A posição da refeição." },
        alimentoId: { type: "string" },
        nome: { type: "string", description: "Só quando não há alimentoId." },
        quantidade: { type: "number" },
        unidade: { type: "string", default: "g" },
      },
      required: ["dietaId", "refeicao"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const refeicao = lista[args.refeicao];
      if (!refeicao) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      let item;
      if (args.alimentoId) {
        const doCatalogo = await app.api.food.data(args.alimentoId);
        if (!doCatalogo) return erro("alimento_nao_encontrado");

        const quantidade = Number(args.quantidade) || doCatalogo.portion || 100;
        // Os valores do catálogo são por 100 g/ml. Copiá-los sem a regra de três
        // faria 30 g de azeite contar como 100 g — o dia inteiro sairia errado.
        const fator = quantidade / 100;
        const proporcional = (v) => (v === null || v === undefined ? null : Number((v * fator).toFixed(1)));

        item = {
          foodId: doCatalogo._id,
          name: doCatalogo.name,
          quantity: quantidade,
          unit: args.unidade || "g",
          kcal: proporcional(doCatalogo.kcal),
          protein: proporcional(doCatalogo.protein),
          carbs: proporcional(doCatalogo.carbs),
          fat: proporcional(doCatalogo.fat),
        };
      } else {
        const nome = String(args.nome || "").trim();
        if (!nome) return erro("sem_alimento", "Mande alimentoId ou nome.");

        item = { name: nome, quantity: args.quantidade ?? null, unit: args.unidade || "g" };
      }

      lista[args.refeicao] = { ...refeicao, foods: [...(refeicao.foods || []), item] };

      // O teto é por REFEIÇÃO, e é o da refeição que cresceu — não o da maior
      // do plano. Somar as duas leituras daria o mesmo número aqui, e daria
      // números diferentes no dia em que o modelo mandar duas de uma vez.
      const demais = await cabeNaEstrutura(
        app,
        "foodsPerMeal",
        lista[args.refeicao].foods.length
      );
      if (demais) return demais;

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${args.refeicao}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_alimento_remover",
    descricao: "Tira um alimento de uma refeição, pelas duas posições.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        refeicao: { type: "integer", minimum: 0 },
        alimento: { type: "integer", minimum: 0 },
      },
      required: ["dietaId", "refeicao", "alimento"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const refeicao = lista[args.refeicao];
      if (!refeicao) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      const alimentos = [...(refeicao.foods || [])];
      const alvo = alimentos[args.alimento];
      if (!alvo) {
        return erro("alimento_inexistente", `A refeição tem ${alimentos.length} alimentos.`);
      }

      alimentos.splice(args.alimento, 1);
      lista[args.refeicao] = { ...refeicao, foods: alimentos };

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        removido: alvo.name,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${args.refeicao}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },
  // ── Financeiro ───────────────────────────────────────────────────────────
  //
  // Cobrança e pagamento são coisas SEPARADAS, e as ferramentas repetem essa
  // separação de propósito: a cobrança é o que a pessoa deve, o pagamento é o
  // que entrou. Uma ferramenta só, de "registrar dinheiro", não saberia
  // responder quem está devendo — que é metade do que se pergunta ao
  // financeiro.
  //
  // Valor entra como a pessoa fala: 250, "250", "250,00" ou "R$ 250,00". Quem
  // converte para centavos é o mesmo código da tela.

  {
    nome: "financeiro_ver",
    naVoz: true,
    descricao:
      "O financeiro de uma pessoa: cobrado, recebido, a receber, e as cobranças " +
      "e pagamentos com os ids.",
    permissao: "finance.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const moeda = (await app.api.tenant.currencyOfInstance())?.currency;
      const saldo = await app.api.finance.balanceOf(args.pessoaId, moeda);
      const pagoPor = await app.api.finance.paidByCharge(args.pessoaId);
      const cobrancas = await app.api.finance.listCharges(args.pessoaId);
      const pagamentos = await app.api.finance.listPayments(args.pessoaId);

      return {
        ok: true,
        saldo,
        cobrancas: cobrancas.map((c) => cobrancaPublica(c, pagoPor[String(c._id)] || 0)),
        pagamentos: pagamentos.map(pagamentoPublico),
        alvo: { rota: rotaDoFinanceiro(args.pessoaId) },
      };
    },
  },

  {
    nome: "cobranca_criar",
    descricao:
      "O que a pessoa DEVE. Não registra dinheiro entrando — isso é " +
      "pagamento_registrar.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        valor: { type: "string", description: 'Ex.: "250,00".' },
        descricao: { type: "string" },
        vencimento: { type: "string", description: "AAAA-MM-DD. Sem isso, hoje." },
        moeda: { type: "string", description: "BRL, USD, EUR… Sem isso, a da conta." },
      },
      required: ["pessoaId", "valor"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const moeda = await moedaDoLancamento(app, args.moeda);
      if (!moeda) return erro("moeda_desconhecida");

      const id = await app.api.finance.insertCharge(
        args.pessoaId,
        { amount: args.valor, description: args.descricao, dueDate: args.vencimento },
        user._id,
        moeda
      );

      const criada = await app.api.finance.chargeData(id);
      if (!criada.amount) {
        await app.api.finance.deleteCharge(id);
        return erro("valor_invalido");
      }

      return {
        ok: true,
        cobranca: cobrancaPublica(criada, 0),
        alvo: {
          rota: rotaDoFinanceiro(args.pessoaId),
          destacar: `charge:${id}`,
          recarregar: `finance:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "cobranca_editar",
    descricao:
      'Muda valor, descrição, vencimento ou situação ("open" ou "canceled"). ' +
      '"paid" NÃO se marca: ela acontece quando os pagamentos cobrem o valor.',
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        cobrancaId: { type: "string" },
        valor: { type: "string" },
        descricao: { type: "string" },
        vencimento: { type: "string" },
        situacao: { type: "string", enum: ["open", "canceled"] },
      },
      required: ["cobrancaId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.finance.chargeData(args.cobrancaId);
      if (!atual) return erro("cobranca_nao_encontrada");
      if (!(await app.api.user.dataStudent(user._id, atual.student))) {
        return erro("cobranca_nao_encontrada");
      }

      await app.api.finance.updateCharge(args.cobrancaId, {
        amount: args.valor === undefined ? atual.amount : args.valor,
        description: args.descricao === undefined ? atual.description : args.descricao,
        dueDate: args.vencimento === undefined ? atual.dueDate : args.vencimento,
        status: args.situacao === undefined ? atual.status : args.situacao,
      });

      const depois = await app.api.finance.chargeData(args.cobrancaId);
      const pagoPor = await app.api.finance.paidByCharge(atual.student);

      return {
        ok: true,
        cobranca: cobrancaPublica(depois, pagoPor[String(args.cobrancaId)] || 0),
        alvo: {
          rota: rotaDoFinanceiro(atual.student),
          destacar: `charge:${args.cobrancaId}`,
          recarregar: `finance:${atual.student}`,
        },
      };
    },
  },

  {
    nome: "cobranca_excluir",
    descricao:
      "Apaga a cobrança. Os pagamentos dela viram avulsos — o dinheiro entrou.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: { cobrancaId: { type: "string" } },
      required: ["cobrancaId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.finance.chargeData(args.cobrancaId);
      if (!alvo) return erro("cobranca_nao_encontrada");
      if (!(await app.api.user.dataStudent(user._id, alvo.student))) {
        return erro("cobranca_nao_encontrada");
      }

      await app.api.finance.deleteCharge(args.cobrancaId);

      return {
        ok: true,
        removida: alvo.description || "",
        alvo: {
          rota: rotaDoFinanceiro(alvo.student),
          recarregar: `finance:${alvo.student}`,
        },
      };
    },
  },

  {
    nome: "pagamento_registrar",
    naVoz: true,
    descricao:
      "O dinheiro que ENTROU. Com `cobrancaId` abate dela, que vira quitada " +
      "sozinha ao ser coberta; sem ele é avulso (adiantamento, venda).",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        valor: { type: "string" },
        forma: { type: "string", description: "pix, cash, credit…" },
        data: { type: "string", description: "AAAA-MM-DD, com hora ou sem" },
        cobrancaId: { type: "string" },
        observacao: { type: "string" },
        situacao: { type: "string", enum: ["paid", "pending", "refunded"] },
        moeda: { type: "string", description: "BRL, USD, EUR… Sem isso, a da conta." },
      },
      required: ["pessoaId", "valor"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      // A forma tem de existir no catálogo DESTA conta: uma chave inventada
      // viraria uma coluna de relatório que não é forma de pagamento nenhuma.
      if (args.forma) {
        const chaves = await app.api.paymentMethod.keys();
        if (!chaves.includes(args.forma)) return erro("forma_desconhecida");
      }

      const moeda = await moedaDoLancamento(app, args.moeda);
      if (!moeda) return erro("moeda_desconhecida");

      const id = await app.api.finance.insertPayment(
        args.pessoaId,
        {
          amount: args.valor,
          method: args.forma || "other",
          date: args.data,
          charge: args.cobrancaId,
          note: args.observacao,
          status: args.situacao,
        },
        user._id,
        moeda
      );

      const criado = await app.api.finance.paymentData(id);
      if (!criado.amount) {
        await app.api.finance.deletePayment(id);
        return erro("valor_invalido");
      }

      const saldo = await app.api.finance.balanceOf(args.pessoaId, moeda);

      return {
        ok: true,
        pagamento: pagamentoPublico(criado),
        saldo,
        alvo: {
          rota: rotaDoFinanceiro(args.pessoaId),
          destacar: `payment:${id}`,
          recarregar: `finance:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "pagamento_excluir",
    descricao: "Apaga um pagamento. A cobrança que ele quitava volta a ficar em aberto.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: { pagamentoId: { type: "string" } },
      required: ["pagamentoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.finance.paymentData(args.pagamentoId);
      if (!alvo) return erro("pagamento_nao_encontrado");
      if (!(await app.api.user.dataStudent(user._id, alvo.student))) {
        return erro("pagamento_nao_encontrado");
      }

      await app.api.finance.deletePayment(args.pagamentoId);

      return {
        ok: true,
        alvo: {
          rota: rotaDoFinanceiro(alvo.student),
          recarregar: `finance:${alvo.student}`,
        },
      };
    },
  },
  // ── Agenda ───────────────────────────────────────────────────────────────
  //
  // O compromisso é de UM profissional, e por padrão é de quem está operando.
  // Marcar no horário de um colega exige `schedule.team` — sem ela o pedido é
  // ignorado e o compromisso fica com quem marcou, que é a mesma regra da tela.
  //
  // Marcar um serviço com valor cria a COBRANÇA sozinho, com vencimento no dia
  // do atendimento. Isso acontece na rota da tela, não aqui — e por isso a
  // ferramenta chama a mesma função dela.

  {
    nome: "servico_listar",
    descricao:
      "Os serviços, com duração e preço. É daqui que sai o `servicoId`, e é ele " +
      "que decide o valor da cobrança.",
    permissao: "schedule.view",
    schema: { type: "object", properties: {}, required: [] },
    async executar(app) {
      const rows = await app.api.service.list({ apenasAtivos: true });

      return {
        ok: true,
        servicos: rows.map((s) => ({
          id: String(s._id),
          nome: s.name,
          minutos: s.minutes,
          valor: dinheiro(s.price, s.currency),
        })),
      };
    },
  },

  {
    nome: "agenda_ver",
    naVoz: true,
    descricao:
      "Os compromissos de um período — sem datas, os próximos sete dias. É daqui " +
      "que sai o `compromissoId`.",
    permissao: "schedule.view",
    schema: {
      type: "object",
      properties: {
        de: { type: "string", description: "AAAA-MM-DD" },
        ate: { type: "string", description: "AAAA-MM-DD" },
        pessoaId: { type: "string", description: "Só os desta pessoa." },
      },
      required: [],
    },
    async executar(app, user, args) {
      const de = args.de ? new Date(args.de) : new Date();
      const ate = args.ate ? new Date(args.ate) : new Date(de.getTime() + 7 * 86400000);
      if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) return erro("data_invalida");

      const rows = await app.api.appointment.between([user._id], de, ate);
      const filtrados = args.pessoaId
        ? rows.filter((a) => String(a.student) === String(args.pessoaId))
        : rows;

      const nomes = await app.api.user.briefByIds(filtrados.map((a) => a.student));

      return {
        ok: true,
        compromissos: filtrados.map((a) => compromissoPublico(a, nomes)),
        alvo: { rota: "/agenda" },
      };
    },
  },

  {
    nome: "compromisso_criar",
    naVoz: true,
    descricao:
      "Marca um atendimento. Serviço com valor gera a cobrança sozinho.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        quando: { type: "string", description: "AAAA-MM-DDTHH:mm" },
        minutos: { type: "integer", minimum: 5, maximum: 480 },
        servicoId: { type: "string" },
        titulo: { type: "string" },
        observacao: { type: "string" },
      },
      required: ["pessoaId", "quando"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const inicio = new Date(args.quando);
      if (Number.isNaN(inicio.getTime())) return erro("data_invalida");

      const servico = args.servicoId ? await app.api.service.data(args.servicoId) : null;
      const minutos = args.minutos || servico?.minutes || 60;

      // O MESMO aviso da tela: o horário já ocupado não é recusado, mas é dito.
      // Recusar impediria o encaixe combinado por telefone; calar faria a
      // sobreposição aparecer só quando as duas pessoas chegassem.
      const cruzam = await app.api.appointment.conflicts([user._id], inicio, minutos);

      const cheio = await cabeNoPlano(app, "schedule", limiteDoPlano.contarNa(app, "appointments"));
      if (cheio) return cheio;

      const id = await app.api.appointment.insert(
        user._id,
        args.pessoaId,
        {
          date: inicio,
          minutes: minutos,
          service: args.servicoId,
          title: args.titulo,
          note: args.observacao,
        },
        user._id
      );

      const criado = await app.api.appointment.data([user._id], id);
      const nomes = await app.api.user.briefByIds([args.pessoaId]);

      return {
        ok: true,
        compromisso: compromissoPublico(criado, nomes),
        conflita: cruzam.length > 0,
        alvo: {
          rota: "/agenda",
          destacar: `appointment:${id}`,
          recarregar: `agenda:${inicio.toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  {
    nome: "compromisso_editar",
    descricao: "Remarca ou muda a duração, o serviço, o título ou a observação.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        compromissoId: { type: "string" },
        quando: { type: "string" },
        minutos: { type: "integer", minimum: 5, maximum: 480 },
        servicoId: { type: "string" },
        titulo: { type: "string" },
        observacao: { type: "string" },
      },
      required: ["compromissoId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.appointment.data([user._id], args.compromissoId);
      if (!atual) return erro("compromisso_nao_encontrado");

      const quando = args.quando === undefined ? atual.date : new Date(args.quando);
      if (Number.isNaN(new Date(quando).getTime())) return erro("data_invalida");

      await app.api.appointment.update([user._id], args.compromissoId, {
        date: quando,
        minutes: args.minutos === undefined ? atual.minutes : args.minutos,
        service: args.servicoId === undefined ? atual.service : args.servicoId,
        title: args.titulo === undefined ? atual.title : args.titulo,
        note: args.observacao === undefined ? atual.note : args.observacao,
        status: atual.status,
      });

      const depois = await app.api.appointment.data([user._id], args.compromissoId);
      const nomes = await app.api.user.briefByIds([depois.student]);

      return {
        ok: true,
        compromisso: compromissoPublico(depois, nomes),
        alvo: {
          rota: "/agenda",
          destacar: `appointment:${args.compromissoId}`,
          recarregar: `agenda:${new Date(depois.date).toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  {
    nome: "compromisso_situacao",
    naVoz: true,
    descricao:
      "Marca presença. Faltou e desmarcado são coisas diferentes: um é falta da " +
      "pessoa, o outro foi combinado.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        compromissoId: { type: "string" },
        situacao: { type: "string", enum: ["scheduled", "done", "missed", "canceled"] },
      },
      required: ["compromissoId", "situacao"],
    },
    async executar(app, user, args) {
      const ok = await app.api.appointment.setStatus(
        [user._id],
        args.compromissoId,
        args.situacao
      );
      if (!ok) return erro("compromisso_nao_encontrado");

      const depois = await app.api.appointment.data([user._id], args.compromissoId);
      const nomes = await app.api.user.briefByIds([depois.student]);

      return {
        ok: true,
        compromisso: compromissoPublico(depois, nomes),
        alvo: {
          rota: "/agenda",
          destacar: `appointment:${args.compromissoId}`,
          recarregar: `agenda:${new Date(depois.date).toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  {
    nome: "compromisso_excluir",
    descricao:
      "Apaga o compromisso. Para dizer que não aconteceu sem perder o registro, " +
      "use compromisso_situacao.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: { compromissoId: { type: "string" } },
      required: ["compromissoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.appointment.data([user._id], args.compromissoId);
      if (!alvo) return erro("compromisso_nao_encontrado");

      await app.api.appointment.delete([user._id], args.compromissoId);

      return {
        ok: true,
        alvo: {
          rota: "/agenda",
          recarregar: `agenda:${new Date(alvo.date).toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  // ── Avaliação física ─────────────────────────────────────────────────────
  //
  // O que se guarda são as MEDIDAS; percentual de gordura, massa magra e IMC
  // são derivados, calculados na tela a partir do método e do protocolo. Por
  // isso as ferramentas não recebem resultado nenhum: mandar "18% de gordura"
  // gravaria um número que a próxima conta contradiz.

  {
    nome: "avaliacao_listar",
    descricao: "As avaliações de uma pessoa, da mais recente para a mais antiga.",
    permissao: "assessments.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const rows = await app.api.assessment.list(user._id, args.pessoaId);

      return {
        ok: true,
        avaliacoes: rows.map(avaliacaoPublica),
        alvo: { rota: rotaDaAvaliacao(args.pessoaId) },
      };
    },
  },

  {
    nome: "avaliacao_criar",
    naVoz: true,
    descricao:
      "Lança uma medida. Gordura e IMC NÃO se mandam: são calculados.",
    permissao: "assessments.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        data: { type: "string", description: "AAAA-MM-DD. Sem isso, hoje." },
        peso: { type: "number", description: "Em kg." },
        altura: { type: "number", description: "Em cm ou em metros — os dois servem." },
        dobras: { type: "object", description: "mm: triceps, subscapular, suprailiac, abdominal, thigh, chest, midaxillary" },
        circunferencias: { type: "object", description: "cm: waist, hip, chest, arm, thigh, calf, neck, shoulder" },
        observacao: { type: "string" },
      },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const cheio = await cabeNoPlano(app, "assessments", limiteDoPlano.contarNa(app, "assessments"));
      if (cheio) return cheio;

      const id = await app.api.assessment.insert(user._id, args.pessoaId, {
        date: args.data,
        weight: args.peso,
        height: args.altura,
        skinfolds: args.dobras,
        circumferences: args.circunferencias,
        note: args.observacao,
        // Nasce PRONTA, e não rascunho: o rascunho existe para a tela gravar
        // campo a campo enquanto se digita, e aqui a medida chega inteira.
        draft: false,
      });

      const criada = await app.api.assessment.data(user._id, id);

      return {
        ok: true,
        avaliacao: avaliacaoPublica(criada),
        alvo: {
          rota: rotaDaAvaliacao(args.pessoaId),
          destacar: `assessment:${id}`,
          recarregar: `assessment:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "avaliacao_editar",
    descricao: "Corrige uma medida já lançada. Só o que vier muda.",
    permissao: "assessments.manage",
    schema: {
      type: "object",
      properties: {
        avaliacaoId: { type: "string" },
        data: { type: "string" },
        peso: { type: "number" },
        altura: { type: "number" },
        dobras: { type: "object" },
        circunferencias: { type: "object" },
        observacao: { type: "string" },
      },
      required: ["avaliacaoId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.assessment.data(user._id, args.avaliacaoId);
      if (!atual) return erro("avaliacao_nao_encontrada");

      await app.api.assessment.update(user._id, args.avaliacaoId, {
        ...atual,
        date: args.data === undefined ? atual.date : args.data,
        weight: args.peso === undefined ? atual.weight : args.peso,
        height: args.altura === undefined ? atual.height : args.altura,
        skinfolds: args.dobras === undefined ? atual.skinfolds : args.dobras,
        circumferences:
          args.circunferencias === undefined ? atual.circumferences : args.circunferencias,
        note: args.observacao === undefined ? atual.note : args.observacao,
      });

      const depois = await app.api.assessment.data(user._id, args.avaliacaoId);

      return {
        ok: true,
        avaliacao: avaliacaoPublica(depois),
        alvo: {
          rota: rotaDaAvaliacao(depois.student),
          destacar: `assessment:${args.avaliacaoId}`,
          recarregar: `assessment:${depois.student}`,
        },
      };
    },
  },

  {
    nome: "avaliacao_excluir",
    descricao: "Apaga uma avaliação, com as fotos dela.",
    permissao: "assessments.manage",
    schema: {
      type: "object",
      properties: { avaliacaoId: { type: "string" } },
      required: ["avaliacaoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.assessment.data(user._id, args.avaliacaoId);
      if (!alvo) return erro("avaliacao_nao_encontrada");

      await app.api.assessment.delete(user._id, args.avaliacaoId);

      return {
        ok: true,
        alvo: {
          rota: rotaDaAvaliacao(alvo.student),
          recarregar: `assessment:${alvo.student}`,
        },
      };
    },
  },

  // ── Unidades ─────────────────────────────────────────────────────────────
  //
  // Os lugares onde a casa atende. Entraram no MCP em 19/09/2026, junto com as
  // aulas coletivas e o cardápio de planos: o produto ganhou três menus e o
  // assistente não sabia que existiam — pedir "cadastra a unidade de Paraty"
  // voltava "não tenho ferramenta para isso".
  //
  // LER é `people.view` e MEXER é `users.manage`, exatamente como na tela:
  // escolher a unidade de alguém é rotina de quem atende; abrir filial é
  // decisão de quem administra.
  {
    nome: "unidade_listar",
    descricao:
      "Lista as unidades (filiais, estúdios, salas) da conta. Use para pegar o id antes " +
      "de vincular alguém a uma unidade ou de dizer em qual unidade uma aula acontece.",
    permissao: "people.view",
    schema: {
      type: "object",
      properties: {
        comContagem: {
          type: "boolean",
          description:
            "Traz quantas pessoas estão em cada unidade. Custa uma consulta por unidade — " +
            "peça só quando a pergunta for sobre o número.",
        },
      },
    },
    async executar(app, user, args) {
      const linhas = await app.api.unit.list();

      const unidades = [];
      for (const u of linhas) {
        const base = unidadePublica(u);
        if (args.comContagem) base.pessoas = await app.api.unit.quantasPessoas(u._id);
        unidades.push(base);
      }

      return { ok: true, unidades };
    },
  },

  {
    nome: "unidade_criar",
    descricao:
      "Cadastra uma unidade. Só o nome é obrigatório. O endereço vai em PARTES (cep, " +
      "logradouro, numero, bairro, cidade, uf) e não numa linha só — é delas que sai o " +
      "ponto no mapa. A linha de endereço que aparece na tela é montada sozinha.",
    permissao: "users.manage",
    schema: {
      type: "object",
      properties: {
        nome: { type: "string", minLength: 2 },
        frase: { type: "string", description: 'Frase curta: "Ao lado do metrô".' },
        cep: { type: "string" },
        logradouro: { type: "string" },
        numero: { type: "string" },
        complemento: { type: "string" },
        bairro: { type: "string" },
        cidade: { type: "string" },
        uf: { type: "string" },
        telefone: { type: "string" },
        whatsapp: { type: "string" },
        email: { type: "string" },
        ativa: { type: "boolean", default: true },
      },
      required: ["nome"],
    },
    async executar(app, user, args) {
      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto", "O nome precisa de ao menos 2 letras.");

      // O mesmo teto da rota da tela. Ele não é burocracia: a unidade é o que
      // entra no mapa de parceiros do nosso site, e sem teto quem quisesse
      // aparecer trinta vezes na mesma cidade só precisaria cadastrar trinta.
      const cheio = await cabeNoPlano(app, "units", limiteDoPlano.contarNa(app, "units"));
      if (cheio) return cheio;

      const id = await app.api.unit.insert(camposDaUnidade(args, { name: nome }));
      if (!id) return erro("dados_invalidos");

      return {
        ok: true,
        unidade: unidadePublica(await app.api.unit.data(id)),
        alvo: { rota: ROTA_DAS_UNIDADES, destacar: `unit:${id}` },
      };
    },
  },

  {
    nome: "unidade_editar",
    descricao:
      "Muda uma unidade. Mande SÓ o que deve mudar. Para tirar do ar sem apagar, " +
      'mande ativa: false — ela some das listas e ninguém perde o vínculo.',
    permissao: "users.manage",
    schema: {
      type: "object",
      properties: {
        unidadeId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        frase: { type: "string" },
        cep: { type: "string" },
        logradouro: { type: "string" },
        numero: { type: "string" },
        complemento: { type: "string" },
        bairro: { type: "string" },
        cidade: { type: "string" },
        uf: { type: "string" },
        telefone: { type: "string" },
        whatsapp: { type: "string" },
        email: { type: "string" },
        ativa: { type: "boolean" },
      },
      required: ["unidadeId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.unit.data(args.unidadeId);
      if (!atual) return erro("unidade_nao_encontrada");

      // O modelo grava CAMPO A CAMPO o que vier, e o que não vier fica. Mandar
      // o documento inteiro de volta apagaria a foto e o ponto do mapa, que
      // esta ferramenta não sabe escrever.
      await app.api.unit.update(args.unidadeId, camposDaUnidade(args));

      return {
        ok: true,
        unidade: unidadePublica(await app.api.unit.data(args.unidadeId)),
        alvo: { rota: ROTA_DAS_UNIDADES, destacar: `unit:${args.unidadeId}` },
      };
    },
  },

  {
    nome: "unidade_excluir",
    descricao:
      "Apaga uma unidade. RECUSA quando ainda há gente vinculada a ela, e diz quantas " +
      "são — nesse caso o caminho é desativar (unidade_editar com ativa: false) ou mover " +
      "as pessoas antes.",
    permissao: "users.manage",
    schema: {
      type: "object",
      properties: { unidadeId: { type: "string" } },
      required: ["unidadeId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.unit.data(args.unidadeId);
      if (!alvo) return erro("unidade_nao_encontrada");

      const quantas = await app.api.unit.quantasPessoas(args.unidadeId);
      if (quantas > 0) {
        return erro(
          "unidade_com_gente",
          `${quantas} pessoa(s) ainda estão nesta unidade. Desative-a ou mova as pessoas.`
        );
      }

      await app.api.unit.remove(args.unidadeId);

      return { ok: true, alvo: { rota: ROTA_DAS_UNIDADES, recarregar: "units" } };
    },
  },

  // ── Aulas coletivas ──────────────────────────────────────────────────────
  //
  // Duas telas, e por isso duas famílias de ferramenta:
  //
  //   a GRADE   (`aula_coletiva_listar/criar/editar/excluir`) é o que se repete
  //             toda semana. Mora em Configurações e muda uma vez por mês.
  //   o DIA     (`aula_coletiva_hoje`, `..._inscritos`, `..._inscrever`,
  //             `..._presenca`, `..._fechar`) é a lista de presença da recepção.
  //             Zera à meia-noite.
  //
  // Misturar as duas numa ferramenta só seria misturar "que aulas existem" com
  // "quem está na das 7" — e é a segunda que se pergunta o dia inteiro.
  {
    nome: "aula_coletiva_listar",
    descricao:
      "A GRADE de aulas coletivas: o que se repete toda semana, com dias, horários e " +
      "vagas. Use para pegar o id de uma aula. Para saber quem está inscrito HOJE, use " +
      "aula_coletiva_hoje.",
    permissao: "people.view",
    schema: {
      type: "object",
      properties: {
        incluirInativas: { type: "boolean", default: false },
      },
    },
    async executar(app, user, args) {
      const linhas = args.incluirInativas
        ? await app.api.groupClass.list()
        : await app.api.groupClass.listActive();

      return { ok: true, aulas: linhas.map(aulaColetivaPublica) };
    },
  },

  {
    nome: "aula_coletiva_hoje",
    naVoz: true,
    descricao:
      "As aulas coletivas de HOJE, horário a horário, com quantos já se inscreveram, se o " +
      "check-in está aberto e se o horário foi fechado ou lotou. Use sempre que a pergunta " +
      "for sobre o dia de hoje — ela já traz o `dia` e o `inicioMinutos` que as outras " +
      "ferramentas do dia pedem.",
    permissao: "people.view",
    schema: { type: "object", properties: {} },
    async executar(app, user) {
      // O DIA e a JANELA são do servidor, no fuso da CONTA. O relógio de quem
      // pergunta não entra na conta: uma conta feita nos dois lugares diverge.
      const fuso = await app.api.tenant.timezoneOfInstance();
      const agora = new Date();

      const comEstado = (await app.api.groupClass.listActive())
        .map((a) => ({ aula: a, estado: app.api.groupClass.estadoAgora(a, agora, fuso) }))
        .filter((x) => x.estado.hoje);

      const dia =
        comEstado[0]?.estado?.data ||
        app.api.groupClass.estadoAgora({ dias: [] }, agora, fuso).data;

      const [contagem, fechadas] = comEstado.length
        ? await Promise.all([
            app.api.groupClassCheckin.contagemDoDia(dia),
            app.api.groupClassSession.fechadasDoDia(dia),
          ])
        : [{}, new Set()];

      return {
        ok: true,
        dia,
        aulas: comEstado.map(({ aula, estado }) => ({
          id: String(aula._id),
          nome: aula.name,
          sala: aula.sala || "",
          vagas: aula.seats || 0,
          horarios: estado.horarios.map((h, i) => {
            const inicio = aula.horarios[i]?.inicio;
            const chave = `${aula._id}:${inicio}`;
            const inscritos = contagem[chave] || 0;

            return {
              inicio: h.inicio,
              fim: h.fim,
              inicioMinutos: inicio,
              inscritos,
              checkinAberto: h.aberta,
              abreAs: h.abreEm,
              fechaAs: h.fechaEm,
              // Fechada, lotada e "fora da janela" são TRÊS coisas, e o
              // conserto de cada uma é outro: clicar, abrir vaga, esperar.
              fechada: fechadas.has(chave),
              lotada: aula.seats > 0 && inscritos >= aula.seats,
            };
          }),
        })),
      };
    },
  },

  {
    nome: "aula_coletiva_criar",
    descricao:
      "Cria uma aula coletiva na grade. Precisa de nome, dias da semana e ao menos um " +
      'horário com início e fim ("07:00"–"07:50"). Os dias são 0=domingo a 6=sábado. ' +
      "Sem unidades, a aula vale em todas.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        nome: { type: "string", minLength: 2 },
        descricao: { type: "string" },
        sala: { type: "string", description: 'Onde é DENTRO da unidade: "Sala 2", "Piscina".' },
        dias: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 6 },
          description: "0=domingo, 1=segunda… 6=sábado.",
        },
        horarios: {
          type: "array",
          items: {
            type: "object",
            properties: {
              inicio: { type: "string", description: 'Relógio de parede: "07:00".' },
              fim: { type: "string" },
            },
            required: ["inicio", "fim"],
          },
        },
        vagas: { type: "integer", minimum: 0, description: "0 é sem limite." },
        unidadeIds: { type: "array", items: { type: "string" } },
        checkinAbre: {
          type: "integer",
          description: "Minutos ANTES do início em que o check-in abre. Padrão 30.",
        },
        checkinFecha: {
          type: "integer",
          description: "Minutos DEPOIS do início em que ele fecha. Padrão 15.",
        },
        variosHorarios: {
          type: "boolean",
          description:
            "true deixa a mesma pessoa entrar em mais de um horário no mesmo dia. " +
            "O padrão é false — uma vez por dia.",
        },
      },
      required: ["nome", "dias", "horarios"],
    },
    async executar(app, user, args) {
      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto");

      const cheio = await cabeNoPlano(
        app,
        "groupClasses",
        limiteDoPlano.contarNa(app, "group_classes")
      );
      if (cheio) return cheio;

      const id = await app.api.groupClass.insert(camposDaAula(args, { name: nome }));
      // Sem nome, sem dia ou sem horário válido não existe aula: ela nunca
      // aconteceria. O modelo devolve nada, e o motivo é sempre um dos três.
      if (!id) {
        return erro(
          "aula_incompleta",
          "A aula precisa de nome, ao menos um dia da semana e um horário com fim depois do início."
        );
      }

      return {
        ok: true,
        aula: aulaColetivaPublica(await app.api.groupClass.data(id)),
        alvo: { rota: rotaDaAulaColetiva(id), destacar: `groupClass:${id}` },
      };
    },
  },

  {
    nome: "aula_coletiva_editar",
    descricao:
      "Muda uma aula da grade. Mande SÓ o que deve mudar. `dias` e `horarios` substituem " +
      "a lista inteira quando vêm — não são acréscimos.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        aulaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        descricao: { type: "string" },
        sala: { type: "string" },
        dias: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
        horarios: {
          type: "array",
          items: {
            type: "object",
            properties: { inicio: { type: "string" }, fim: { type: "string" } },
            required: ["inicio", "fim"],
          },
        },
        vagas: { type: "integer", minimum: 0 },
        unidadeIds: { type: "array", items: { type: "string" } },
        checkinAbre: { type: "integer" },
        checkinFecha: { type: "integer" },
        variosHorarios: { type: "boolean" },
        ativa: { type: "boolean" },
      },
      required: ["aulaId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.groupClass.data(args.aulaId);
      if (!atual) return erro("aula_nao_encontrada");

      const ok = await app.api.groupClass.update(args.aulaId, camposDaAula(args));
      if (!ok) return erro("aula_incompleta");

      return {
        ok: true,
        aula: aulaColetivaPublica(await app.api.groupClass.data(args.aulaId)),
        alvo: { rota: rotaDaAulaColetiva(args.aulaId), destacar: `groupClass:${args.aulaId}` },
      };
    },
  },

  {
    nome: "aula_coletiva_excluir",
    descricao:
      "Apaga uma aula da grade, com os check-ins e os fechamentos dela. Para tirá-la do ar " +
      "sem perder o histórico, use aula_coletiva_editar com ativa: false.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: { aulaId: { type: "string" } },
      required: ["aulaId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.groupClass.data(args.aulaId);
      if (!alvo) return erro("aula_nao_encontrada");

      await app.api.groupClass.remove(args.aulaId);
      // O check-in não tem vida própria: sem a aula, nenhuma tela o alcança e
      // nada o apagaria. É o que a rota da tela faz, na mesma ordem.
      await app.api.groupClassCheckin.removeAllOf(args.aulaId);
      await app.api.groupClassSession.removeAllOf(args.aulaId);

      return { ok: true, alvo: { rota: ROTA_DA_GRADE, recarregar: "groupClasses" } };
    },
  },

  {
    nome: "aula_coletiva_inscritos",
    naVoz: true,
    descricao:
      "Quem está inscrito num horário, com o estado de cada um (inscrito, presente, " +
      "faltou). Pegue `dia` e `inicioMinutos` em aula_coletiva_hoje. Sem `dia`, é hoje.",
    permissao: "people.view",
    schema: {
      type: "object",
      properties: {
        aulaId: { type: "string" },
        inicioMinutos: {
          type: "integer",
          description: "O horário, em minutos desde a meia-noite. 07:00 é 420.",
        },
        dia: { type: "string", description: "AAAA-MM-DD. Sem ele, hoje." },
      },
      required: ["aulaId", "inicioMinutos"],
    },
    async executar(app, user, args) {
      const aula = await app.api.groupClass.data(args.aulaId);
      if (!aula) return erro("aula_nao_encontrada");

      const dia = await diaDaAula(app, args.dia);
      const linhas = await app.api.groupClassCheckin.inscritos(
        args.aulaId,
        dia,
        args.inicioMinutos
      );

      return {
        ok: true,
        dia,
        fechada: await app.api.groupClassSession.estaFechada(args.aulaId, dia, args.inicioMinutos),
        inscritos: linhas.map(inscritoPublico),
      };
    },
  },

  {
    nome: "aula_coletiva_inscrever",
    naVoz: true,
    descricao:
      "Põe alguém num horário à mão, como a recepção faz pelo balcão. RECUSA quando o " +
      "horário está lotado, quando foi fechado, ou quando a pessoa já entrou numa aula hoje " +
      "e a aula é de um horário por dia — as mesmas três regras do aplicativo.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        aulaId: { type: "string" },
        pessoaId: { type: "string" },
        inicioMinutos: { type: "integer" },
        dia: { type: "string", description: "AAAA-MM-DD. Sem ele, hoje." },
      },
      required: ["aulaId", "pessoaId", "inicioMinutos"],
    },
    async executar(app, user, args) {
      const aula = await app.api.groupClass.data(args.aulaId);
      if (!aula) return erro("aula_nao_encontrada");

      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const dia = await diaDaAula(app, args.dia);
      const inicio = Number(args.inicioMinutos);

      if (await app.api.groupClassSession.estaFechada(args.aulaId, dia, inicio)) {
        return erro("aula_fechada", "Este horário foi fechado para inscrições.");
      }

      if (aula.seats > 0) {
        const dentro = await app.api.groupClassCheckin.inscritos(args.aulaId, dia, inicio);
        if (dentro.length >= aula.seats) {
          return erro("aula_lotada", `As ${aula.seats} vagas deste horário já foram ocupadas.`);
        }
      }

      const r = await app.api.groupClassCheckin.entrar(args.aulaId, dia, pessoa._id, {
        inicio,
        variosHorarios: aula.variosHorarios === true,
      });

      if (!r.ok) {
        return r.erro === "ja_entrou_hoje"
          ? erro("ja_entrou_hoje", "Esta aula é de um horário por dia, e a pessoa já está em outro.")
          : erro("dados_invalidos");
      }

      return {
        ok: true,
        novo: r.novo,
        alvo: { rota: rotaDoDia(args.aulaId, inicio), recarregar: `groupClassDay:${args.aulaId}` },
      };
    },
  },

  {
    nome: "aula_coletiva_tirar",
    descricao:
      "Tira uma inscrição da lista, pelo id do CHECK-IN (o campo `id` de " +
      "aula_coletiva_inscritos). É para desfazer uma inscrição errada — quem não veio se " +
      "marca com presenca: faltou, que fica no histórico.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: { checkinId: { type: "string" } },
      required: ["checkinId"],
    },
    async executar(app, user, args) {
      const ok = await app.api.groupClassCheckin.remover(args.checkinId);
      if (!ok) return erro("inscricao_nao_encontrada");

      return { ok: true, alvo: { rota: ROTA_DO_DIA, recarregar: "groupClassDay" } };
    },
  },

  {
    nome: "aula_coletiva_presenca",
    naVoz: true,
    descricao:
      "Marca PRESENTE ou FALTOU numa inscrição, pelo id do check-in. `inscrito` desfaz a " +
      "marcação. Só isso: são três estados, e `faltou` não é a ausência de `presente` — " +
      "enquanto a aula não acontece, ninguém faltou ainda.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        checkinId: { type: "string" },
        presenca: { type: "string", enum: ["presente", "faltou", "inscrito"] },
      },
      required: ["checkinId", "presenca"],
    },
    async executar(app, user, args) {
      const ok = await app.api.groupClassCheckin.marcarPresenca(args.checkinId, args.presenca);
      if (!ok) return erro("inscricao_nao_encontrada");

      return { ok: true, alvo: { rota: ROTA_DO_DIA, recarregar: "groupClassDay" } };
    },
  },

  {
    nome: "aula_coletiva_fechar",
    naVoz: true,
    descricao:
      "Fecha (ou reabre) um horário do DIA para novas inscrições. É do dia, não da aula: " +
      "amanhã ela nasce aberta de novo. Para tirar a aula do ar de vez, use " +
      "aula_coletiva_editar com ativa: false.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        aulaId: { type: "string" },
        inicioMinutos: { type: "integer" },
        dia: { type: "string", description: "AAAA-MM-DD. Sem ele, hoje." },
        fechada: { type: "boolean", default: true, description: "false reabre." },
      },
      required: ["aulaId", "inicioMinutos"],
    },
    async executar(app, user, args) {
      const aula = await app.api.groupClass.data(args.aulaId);
      if (!aula) return erro("aula_nao_encontrada");

      const dia = await diaDaAula(app, args.dia);
      const ok = await app.api.groupClassSession.fechar(
        args.aulaId,
        dia,
        args.inicioMinutos,
        args.fechada !== false,
        user._id
      );
      if (!ok) return erro("dados_invalidos");

      return {
        ok: true,
        dia,
        fechada: args.fechada !== false,
        alvo: {
          rota: rotaDoDia(args.aulaId, args.inicioMinutos),
          recarregar: `groupClassDay:${args.aulaId}`,
        },
      };
    },
  },

  {
    nome: "pessoa_aulas_historico",
    descricao:
      "As aulas coletivas em que uma pessoa entrou, da mais recente para a mais antiga, " +
      "com presente/faltou em cada uma. Use para responder 'ela tem vindo?'.",
    permissao: "people.view",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        limite: { type: "integer", minimum: 1, maximum: 200, default: 60 },
      },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const linhas = await app.api.groupClassCheckin.daPessoa(args.pessoaId, {
        limite: Math.min(200, Number(args.limite) || 60),
      });

      // O NOME da aula, resolvido aqui: "Spinning, 18/09, presente" é a
      // resposta, e uma segunda chamada para traduzir ids em nomes faria o
      // modelo gastar um turno com o que já está na mão.
      const nomes = new Map(
        (await app.api.groupClass.list()).map((a) => [String(a._id), a.name])
      );

      return {
        ok: true,
        aulas: linhas.map((l) => ({
          // Aula apagada continua no histórico, sem nome: a presença
          // aconteceu, e sumir com ela seria reescrever o passado da pessoa.
          aula: nomes.get(String(l.class)) || "",
          dia: l.dia,
          hora: horaDeMinutos(l.inicio),
          presenca: l.presenca || "inscrito",
        })),
      };
    },
  },

  // ── Planos (o cardápio que a casa VENDE) ─────────────────────────────────
  //
  // Atenção ao nome, porque este produto tem três coisas chamadas "plano" e
  // duas delas são ferramentas daqui:
  //
  //   `plano_*`   a MENSALIDADE que a academia vende ao aluno — este bloco.
  //   `dieta_*`   o plano ALIMENTAR de uma pessoa.
  //   (nenhuma)   o plano que a academia paga para NÓS. Ele mora na central, e
  //               não se mexe por aqui de propósito.
  {
    nome: "plano_listar",
    descricao:
      "O cardápio de planos/mensalidades que a casa vende (não é plano alimentar — para " +
      "esse, dieta_listar). Traz preço, cadência e se é o plano em destaque.",
    permissao: "finance.view",
    schema: {
      type: "object",
      properties: { incluirInativos: { type: "boolean", default: false } },
    },
    async executar(app, user, args) {
      const linhas = args.incluirInativos
        ? await app.api.membership.list()
        : await app.api.membership.listActive();

      return { ok: true, planos: linhas.map(planoPublico) };
    },
  },

  {
    nome: "plano_criar",
    descricao:
      "Cria um plano de mensalidade. O valor vai como a pessoa fala (149.90) e a cadência " +
      "diz de quanto em quanto tempo ele é cobrado. Só um plano pode estar em destaque: " +
      "marcar um tira o destaque do anterior.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        nome: { type: "string", minLength: 2 },
        frase: { type: "string", description: "Uma linha curta abaixo do nome." },
        descricao: { type: "string" },
        valor: { type: "number", description: "Em reais: 149.90. Não mande centavos." },
        cadencia: {
          type: "string",
          enum: ["weekly", "biweekly", "monthly", "bimonthly", "quarterly", "semiannual", "annual"],
          default: "monthly",
        },
        fidelidadeMeses: { type: "integer", minimum: 0, maximum: 120 },
        unidadeIds: {
          type: "array",
          items: { type: "string" },
          description: "Onde o plano é vendido. Vazio é em todas.",
        },
        destaque: { type: "boolean" },
        ativo: { type: "boolean", default: true },
      },
      required: ["nome"],
    },
    async executar(app, user, args) {
      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto");

      const cheio = await cabeNoPlano(app, "memberships", limiteDoPlano.contarNa(app, "memberships"));
      if (cheio) return cheio;

      // A MOEDA é a da conta, gravada no plano. É a mesma razão do lançamento:
      // "149" em real e "149" em dólar são preços diferentes, e um cardápio sem
      // moeda é um cardápio que mente quando a conta muda de país.
      const conta = await app.api.tenant.currencyOfInstance();
      const id = await app.api.membership.insert(
        camposDoPlano(args, { name: nome }),
        conta?.currency || "BRL"
      );

      return {
        ok: true,
        plano: planoPublico(await app.api.membership.data(id)),
        alvo: { rota: rotaDoPlano(id), destacar: `membership:${id}` },
      };
    },
  },

  {
    nome: "plano_editar",
    descricao:
      "Muda um plano de mensalidade. Mande SÓ o que deve mudar. Para tirar do cardápio sem " +
      "apagar (e sem mexer em quem já assinou), mande ativo: false.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        planoId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        frase: { type: "string" },
        descricao: { type: "string" },
        valor: { type: "number" },
        cadencia: {
          type: "string",
          enum: ["weekly", "biweekly", "monthly", "bimonthly", "quarterly", "semiannual", "annual"],
        },
        fidelidadeMeses: { type: "integer", minimum: 0, maximum: 120 },
        unidadeIds: { type: "array", items: { type: "string" } },
        destaque: { type: "boolean" },
        ativo: { type: "boolean" },
      },
      required: ["planoId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.membership.data(args.planoId);
      if (!atual) return erro("plano_nao_encontrado");

      await app.api.membership.update(args.planoId, camposDoPlano(args));

      return {
        ok: true,
        plano: planoPublico(await app.api.membership.data(args.planoId)),
        alvo: { rota: rotaDoPlano(args.planoId), destacar: `membership:${args.planoId}` },
      };
    },
  },

  {
    nome: "plano_excluir",
    descricao:
      "Apaga um plano do cardápio. Não mexe nas cobranças já feitas nem em quem assinou — " +
      "só tira a linha de venda. Na dúvida, prefira ativo: false.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: { planoId: { type: "string" } },
      required: ["planoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.membership.data(args.planoId);
      if (!alvo) return erro("plano_nao_encontrado");

      await app.api.membership.remove(args.planoId);

      return { ok: true, alvo: { rota: ROTA_DOS_PLANOS, recarregar: "memberships" } };
    },
  },

  // ── Aulões ───────────────────────────────────────────────────────────────
  //
  // O EVENTO, e não a grade: "27/09 às 08:00, no Parque". Tem data, acaba, e a
  // lista de inscritos fecha. A diferença para a aula coletiva é o tempo, e é
  // ela que decide qual ferramenta usar.
  {
    nome: "aulao_listar",
    descricao:
      "Os aulões (eventos com data marcada), com quantos se inscreveram em cada um. Por " +
      "padrão só os que ainda vão acontecer.",
    permissao: "schedule.view",
    schema: {
      type: "object",
      properties: { passados: { type: "boolean", default: false } },
    },
    async executar(app, user, args) {
      const linhas = await app.api.aulao.list({ passados: args.passados === true });
      const contagem = await app.api.aulao.contagemDeTodos(linhas.map((a) => a._id));

      return {
        ok: true,
        auloes: linhas.map((a) => aulaoPublico(a, contagem?.[String(a._id)] || 0)),
      };
    },
  },

  {
    nome: "aulao_criar",
    descricao:
      "Cria um aulão. Precisa de nome e da data-hora de início (ISO 8601). Nasce NÃO " +
      "publicado: a página pública dele só existe depois de alguém publicar — criar por " +
      "aqui não expõe nada.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        nome: { type: "string", minLength: 2 },
        quando: { type: "string", description: "ISO 8601: 2026-09-27T08:00:00-03:00." },
        minutos: { type: "integer", minimum: 5, default: 60 },
        endereco: { type: "string" },
        descricao: { type: "string" },
        vagas: { type: "integer", minimum: 0, description: "0 é sem limite." },
        valor: { type: "number", description: "Em reais. 0 é gratuito." },
      },
      required: ["nome", "quando"],
    },
    async executar(app, user, args) {
      const quando = new Date(args.quando);
      if (Number.isNaN(quando.getTime())) return erro("data_invalida");

      // O teto conta os que ainda VÃO ACONTECER, e não a collection inteira: um
      // aulão que passou não pode ocupar vaga para sempre.
      const cheio = await cabeNoPlano(app, "aulaoes", async () => {
        const col = await app.api.aulao.collection();
        return col.countDocuments({ startsAt: { $gte: new Date() } });
      });
      if (cheio) return cheio;

      const r = await app.api.aulao.insert(user._id, {
        name: String(args.nome || "").trim(),
        startsAt: quando,
        minutes: args.minutos,
        address: args.endereco,
        description: args.descricao,
        seats: args.vagas,
        price: args.valor,
      });

      if (!r.ok) {
        return erro(r.erro === "sem_data" ? "data_invalida" : "nome_curto");
      }

      return {
        ok: true,
        aulao: { id: String(r.id), nome: String(args.nome || "").trim(), apelido: r.slug },
        alvo: { rota: ROTA_DOS_AULOES, destacar: `aulao:${r.id}` },
      };
    },
  },

  {
    nome: "aulao_inscrever",
    descricao:
      "Inscreve alguém que já está na lista de pessoas num aulão. RECUSA quando lotou, e " +
      "diz quando a pessoa já estava inscrita — as duas coisas são respostas, não falhas.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        aulaoId: { type: "string" },
        pessoaId: { type: "string" },
      },
      required: ["aulaoId", "pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const r = await app.api.aulao.inscrever(args.aulaoId, args.pessoaId, { origem: "interna" });

      if (!r.ok) {
        const motivo = { lotado: "aulao_lotado", ja_inscrito: "ja_inscrito" }[r.erro];
        return erro(motivo || "aulao_nao_encontrado");
      }

      // A COBRANÇA do aulão pago NÃO é criada aqui, e é de propósito: a rota da
      // tela faz isso com regras próprias (vencimento no dia do aulão, uma
      // cobrança por pessoa mesmo que ela saia e volte). Duplicá-las aqui seria
      // o caminho paralelo que este arquivo promete não ser — quem precisa
      // cobrar usa `cobranca_criar`, que é a ferramenta que existe para isso.
      return {
        ok: true,
        cobrancaCriada: false,
        alvo: { rota: ROTA_DOS_AULOES, recarregar: `aulao:${args.aulaoId}` },
      };
    },
  },

  {
    nome: "aulao_presenca",
    descricao:
      "Marca se uma pessoa compareceu ao aulão. Aqui são DOIS estados (veio ou não), " +
      "diferente da aula coletiva, que tem três — o aulão acontece uma vez, e a lista é " +
      "conferida depois que ele terminou.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        aulaoId: { type: "string" },
        pessoaId: { type: "string" },
        presente: { type: "boolean" },
      },
      required: ["aulaoId", "pessoaId", "presente"],
    },
    async executar(app, user, args) {
      const r = await app.api.aulao.marcarPresenca(
        args.aulaoId,
        args.pessoaId,
        args.presente === true
      );
      if (!r?.ok) return erro("inscricao_nao_encontrada");

      return { ok: true, alvo: { rota: ROTA_DOS_AULOES, recarregar: `aulao:${args.aulaoId}` } };
    },
  },

  // ── Anamnese ─────────────────────────────────────────────────────────────
  //
  // A conversa da primeira consulta, guardada: doenças, medicamentos, alergias,
  // hábitos. É o dado mais sensível da ficha depois da prescrição, e é por isso
  // que VER e PREENCHER são chaves separadas — a mesma separação da tela.
  //
  // Uma anamnese por pessoa, e não uma lista: ela é corrigida, não reemitida.
  // Por isso não há `anamnese_criar` — `anamnese_preencher` cria na primeira vez
  // e corrige nas outras, que é o que a tela faz com o mesmo botão.
  {
    nome: "anamnese_ver",
    descricao:
      "A anamnese de uma pessoa: queixa, doenças, medicamentos, alergias, cirurgias, " +
      "histórico familiar e hábitos. Responde 'ela tem alguma alergia?', 'toma algum " +
      "remédio?'. Devolve vazio quando ninguém preencheu ainda.",
    permissao: "anamnesis.view",
    naVoz: true,
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const doc = await app.api.anamnesis.data(user._id, args.pessoaId);
      // `preenchida: false` e não um erro: "nunca foi preenchida" é uma
      // resposta legítima, e a certa para quem acabou de cadastrar alguém.
      if (!doc) return { ok: true, preenchida: false, anamnese: null };

      return { ok: true, preenchida: true, anamnese: anamnesePublica(doc) };
    },
  },

  {
    nome: "anamnese_preencher",
    descricao:
      "Preenche ou corrige a anamnese. Mande SÓ os campos ditos — o que não vier fica " +
      "como está, e mandar um campo vazio o APAGA. Cada pessoa tem uma anamnese só: " +
      "chamar de novo corrige a mesma, não cria outra.",
    permissao: "anamnesis.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        queixaPrincipal: { type: "string", description: "Por que ela procurou." },
        doencas: { type: "string" },
        medicamentos: { type: "string" },
        alergias: { type: "string" },
        cirurgias: { type: "string" },
        historicoFamiliar: { type: "string" },
        atividade: { type: "string", description: "O que ela já pratica hoje." },
        preferencias: { type: "string" },
        aversoes: { type: "string" },
        restricoes: { type: "string", description: "Alimentares: vegetariana, sem lactose." },
        quemCozinha: { type: "string" },
        exames: { type: "string", description: "O que ela relatou de exames, em texto." },
        observacoes: { type: "string" },
        horasDeSono: { type: "number", minimum: 0, maximum: 24 },
        aguaLitros: { type: "number", minimum: 0, maximum: 20 },
        refeicoesPorDia: { type: "number", minimum: 0, maximum: 12 },
        qualidadeDoSono: { type: "string", enum: ["good", "fair", "poor"] },
        alcool: { type: "string", enum: ["never", "rarely", "weekly", "daily"] },
        fumo: { type: "string", enum: ["never", "former", "current"] },
        intestino: { type: "string", enum: ["regular", "constipated", "loose", "varies"] },
        estresse: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const mudanca = camposDaAnamnese(args);
      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      // ── O TETO SÓ VALE NA PRIMEIRA ──────────────────────────────────────
      //
      // Esta chamada é um upsert: preenche a primeira e corrige a décima.
      // Barrar sem distinguir trancaria a EDIÇÃO de uma anamnese que já existe
      // — e a pessoa perderia a correção por causa de um limite que ela não
      // estourou. É a mesma distinção que a rota da tela faz.
      const antes = await app.api.anamnesis.data(user._id, args.pessoaId);
      if (!antes) {
        const cheio = await cabeNoPlano(app, "anamnesis", limiteDoPlano.contarNa(app, "anamnesis"));
        if (cheio) return cheio;
      }

      await app.api.anamnesis.save(user._id, args.pessoaId, mudanca);
      const depois = await app.api.anamnesis.data(user._id, args.pessoaId);

      return {
        ok: true,
        criou: !antes,
        anamnese: anamnesePublica(depois),
        alvo: {
          rota: `/people/${args.pessoaId}?tab=anamnesis`,
          recarregar: `anamnesis:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "anamnese_apagar",
    descricao:
      "Apaga a anamnese inteira de uma pessoa. Para corrigir um campo, use " +
      "anamnese_preencher com o campo vazio — apagar tudo é outra coisa, e não tem volta.",
    permissao: "anamnesis.manage",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const apagou = await app.api.anamnesis.delete(user._id, args.pessoaId);
      if (!apagou) return erro("anamnese_nao_encontrada");

      return {
        ok: true,
        alvo: {
          rota: `/people/${args.pessoaId}?tab=anamnesis`,
          recarregar: `anamnesis:${args.pessoaId}`,
        },
      };
    },
  },

  // ── Exames ───────────────────────────────────────────────────────────────
  //
  // A peça que fecha o ciclo do acompanhamento: anamnese → conduta → exame →
  // ajuste. Separados da avaliação física porque são trabalhos diferentes — a
  // avaliação o profissional mede, o exame vem de um laboratório.
  {
    nome: "exame_marcadores",
    descricao:
      "O catálogo de marcadores que o sistema conhece (hemograma, tireoide, hormônios…), " +
      "com a chave de cada um. Use ANTES de lançar um exame: a chave é a identidade do " +
      'marcador, e "TGP", "ALT" e "Alt" digitados à mão viram três linhas que nenhum ' +
      "gráfico junta.",
    permissao: "exams.view",
    schema: {
      type: "object",
      properties: {
        busca: { type: "string", description: "Parte do nome, para encurtar a lista." },
      },
    },
    async executar(app, user, args) {
      const termo = String(args.busca || "").trim().toLowerCase();
      // A faixa de referência depende do sexo, e o catálogo pede um para
      // resolver. Aqui vai o masculino como base: quem lança o exame tem o
      // laudo na mão e manda a faixa junto — esta lista é para ACHAR A CHAVE,
      // não para prescrever a faixa.
      const grupos = examMarkers.catalogoPara("male");

      const marcadores = [];
      for (const g of grupos) {
        for (const m of g.markers || []) {
          if (termo && !m.key.toLowerCase().includes(termo)) continue;
          marcadores.push({ chave: m.key, unidade: m.unit || "", grupo: g.key });
        }
      }

      return { ok: true, marcadores };
    },
  },

  {
    nome: "exame_listar",
    descricao:
      "Os exames de uma pessoa, do mais recente para trás, com os marcadores e quais " +
      "estão fora da faixa. Use para pegar o id antes de editar ou excluir.",
    permissao: "exams.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const linhas = await app.api.exam.list(user._id, args.pessoaId);
      return { ok: true, exames: linhas.map(examePublico) };
    },
  },

  {
    nome: "exame_criar",
    descricao:
      "Lança um exame com os marcadores dele. Cada marcador vai com `chave` (do catálogo, " +
      "preferível) OU `nome` livre — nunca os dois, senão o mesmo marcador vira duas " +
      "identidades. `minimo` e `maximo` são a faixa de referência do laudo.",
    permissao: "exams.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        data: { type: "string", description: "Dia da coleta, AAAA-MM-DD." },
        laboratorio: { type: "string" },
        observacao: { type: "string" },
        marcadores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              chave: { type: "string", description: "Do catálogo — ver exame_marcadores." },
              nome: { type: "string", description: "Só quando não houver chave." },
              valor: { type: "number" },
              unidade: { type: "string" },
              minimo: { type: "number" },
              maximo: { type: "number" },
            },
            required: ["valor"],
          },
        },
      },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const cheio = await cabeNoPlano(app, "exams", limiteDoPlano.contarNa(app, "exams"));
      if (cheio) return cheio;

      const id = await app.api.exam.insert(user._id, args.pessoaId, camposDoExame(args));
      const criado = await app.api.exam.data(user._id, id);

      return {
        ok: true,
        exame: examePublico(criado),
        alvo: {
          rota: `/people/${args.pessoaId}?tab=exams`,
          destacar: `exam:${id}`,
          recarregar: `exam:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "exame_editar",
    descricao:
      "Muda um exame. `marcadores` SUBSTITUI a lista inteira quando vem — para acrescentar " +
      "um, leia com exame_listar e mande todos de volta com o novo no fim.",
    permissao: "exams.manage",
    schema: {
      type: "object",
      properties: {
        exameId: { type: "string" },
        data: { type: "string" },
        laboratorio: { type: "string" },
        observacao: { type: "string" },
        marcadores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              chave: { type: "string" },
              nome: { type: "string" },
              valor: { type: "number" },
              unidade: { type: "string" },
              minimo: { type: "number" },
              maximo: { type: "number" },
            },
            required: ["valor"],
          },
        },
      },
      required: ["exameId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.exam.data(user._id, args.exameId);
      if (!atual) return erro("exame_nao_encontrado");

      await app.api.exam.update(user._id, args.exameId, camposDoExame(args));
      const depois = await app.api.exam.data(user._id, args.exameId);

      return {
        ok: true,
        exame: examePublico(depois),
        alvo: {
          rota: `/people/${atual.student}?tab=exams`,
          destacar: `exam:${args.exameId}`,
          recarregar: `exam:${atual.student}`,
        },
      };
    },
  },

  {
    nome: "exame_excluir",
    descricao: "Apaga um exame lançado, com os marcadores dele.",
    permissao: "exams.manage",
    schema: {
      type: "object",
      properties: { exameId: { type: "string" } },
      required: ["exameId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.exam.data(user._id, args.exameId);
      if (!alvo) return erro("exame_nao_encontrado");

      await app.api.exam.delete(user._id, args.exameId);

      return {
        ok: true,
        alvo: { rota: `/people/${alvo.student}?tab=exams`, recarregar: `exam:${alvo.student}` },
      };
    },
  },

  // ── Suplementação ────────────────────────────────────────────────────────
  //
  // Separada da dieta de propósito, e a permissão também: numa clínica com
  // nutricionista e treinador, quem prescreve whey e creatina não é
  // necessariamente quem monta o plano alimentar.
  {
    nome: "suplemento_listar",
    descricao:
      "A suplementação de uma pessoa, com dose, momento do dia e período. Cada linha diz " +
      "se está valendo agora, se ainda vai começar ou se já terminou.",
    permissao: "supplements.view",
    naVoz: true,
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const linhas = await app.api.supplement.list(user._id, args.pessoaId);
      return { ok: true, suplementos: linhas.map(suplementoPublico) };
    },
  },

  {
    nome: "suplemento_criar",
    descricao:
      "Indica um suplemento. `momento` é quando no dia (wake, morning, preWorkout, " +
      "postWorkout, lunch, afternoon, dinner, night). Sem `diasDaSemana`, é todo dia; sem " +
      "`fim`, é por tempo indeterminado.",
    permissao: "supplements.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        marca: { type: "string", description: "O que está escrito no pote." },
        dose: { type: "number" },
        unidade: {
          type: "string",
          enum: ["g", "mg", "mcg", "ml", "UI", "cápsula", "comprimido", "scoop", "sachê", "dose"],
        },
        momento: {
          type: "string",
          enum: [
            "wake",
            "morning",
            "preWorkout",
            "postWorkout",
            "lunch",
            "afternoon",
            "dinner",
            "night",
          ],
        },
        diasDaSemana: {
          type: "array",
          items: {
            type: "string",
            enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
          },
        },
        observacao: { type: "string", description: '"com água", "afastado do café".' },
        inicio: { type: "string", description: "AAAA-MM-DD." },
        fim: { type: "string", description: "AAAA-MM-DD." },
      },
      required: ["pessoaId", "nome"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto");

      const cheio = await cabeNoPlano(app, "supplements", limiteDoPlano.contarNa(app, "supplements"));
      if (cheio) return cheio;

      const id = await app.api.supplement.insert(
        user._id,
        args.pessoaId,
        camposDoSuplemento(args, { name: nome })
      );
      const criado = await app.api.supplement.data(user._id, id);

      return {
        ok: true,
        suplemento: suplementoPublico(criado),
        alvo: {
          rota: `/people/${args.pessoaId}?tab=supplements`,
          destacar: `supplement:${id}`,
          recarregar: `supplement:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "suplemento_editar",
    descricao:
      "Muda um suplemento. Mande SÓ o que deve mudar. Para encerrar sem apagar o " +
      "histórico, ponha `fim` na data em que ele para — a linha continua na ficha, " +
      "marcada como terminada.",
    permissao: "supplements.manage",
    schema: {
      type: "object",
      properties: {
        suplementoId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        marca: { type: "string" },
        dose: { type: "number" },
        unidade: {
          type: "string",
          enum: ["g", "mg", "mcg", "ml", "UI", "cápsula", "comprimido", "scoop", "sachê", "dose"],
        },
        momento: {
          type: "string",
          enum: [
            "wake",
            "morning",
            "preWorkout",
            "postWorkout",
            "lunch",
            "afternoon",
            "dinner",
            "night",
          ],
        },
        diasDaSemana: { type: "array", items: { type: "string" } },
        observacao: { type: "string" },
        inicio: { type: "string" },
        fim: { type: "string" },
      },
      required: ["suplementoId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.supplement.data(user._id, args.suplementoId);
      if (!atual) return erro("suplemento_nao_encontrado");

      await app.api.supplement.update(user._id, args.suplementoId, camposDoSuplemento(args));
      const depois = await app.api.supplement.data(user._id, args.suplementoId);

      return {
        ok: true,
        suplemento: suplementoPublico(depois),
        alvo: {
          rota: `/people/${atual.student}?tab=supplements`,
          destacar: `supplement:${args.suplementoId}`,
          recarregar: `supplement:${atual.student}`,
        },
      };
    },
  },

  {
    nome: "suplemento_excluir",
    descricao:
      "Apaga um suplemento da ficha. Quem parou de tomar não se apaga: põe-se `fim` na " +
      "data, e a linha fica no histórico. Apagar é para o que foi lançado errado.",
    permissao: "supplements.manage",
    schema: {
      type: "object",
      properties: { suplementoId: { type: "string" } },
      required: ["suplementoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.supplement.data(user._id, args.suplementoId);
      if (!alvo) return erro("suplemento_nao_encontrado");

      await app.api.supplement.delete(user._id, args.suplementoId);

      return {
        ok: true,
        alvo: {
          rota: `/people/${alvo.student}?tab=supplements`,
          recarregar: `supplement:${alvo.student}`,
        },
      };
    },
  },

  // ── Prescrições ──────────────────────────────────────────────────────────
  //
  // A mais restrita das áreas clínicas, e por isso a última a ganhar
  // ferramenta: é documento assinado, com registro de conselho. Ver o que foi
  // prescrito é uma coisa (a recepção pode precisar reimprimir); EMITIR é
  // outra, e só quem assina.
  //
  // O que a ferramenta NÃO faz: imprimir, assinar digitalmente e mandar por
  // e-mail. Os três saem por rotas próprias, com o certificado e o cabeçalho da
  // casa — e um documento que sai por um caminho paralelo é um documento que
  // sai diferente do que a pessoa esperava assinar.
  {
    nome: "prescricao_listar",
    descricao:
      "As prescrições emitidas para uma pessoa, da mais recente para trás, com tipo, data " +
      "e quantos itens. Use para pegar o id antes de ver o conteúdo.",
    permissao: "prescriptions.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const linhas = await app.api.prescription.list(user._id, args.pessoaId);
      return { ok: true, prescricoes: linhas.map((p) => prescricaoPublica(p, false)) };
    },
  },

  {
    nome: "prescricao_ver",
    descricao: "Uma prescrição inteira, com todos os itens: nome, dose, posologia e duração.",
    permissao: "prescriptions.view",
    schema: {
      type: "object",
      properties: { prescricaoId: { type: "string" } },
      required: ["prescricaoId"],
    },
    async executar(app, user, args) {
      const doc = await app.api.prescription.data(user._id, args.prescricaoId);
      if (!doc) return erro("prescricao_nao_encontrada");

      return {
        ok: true,
        prescricao: prescricaoPublica(doc, true),
        alvo: {
          rota: `/people/${doc.student}?tab=prescriptions`,
          destacar: `prescription:${args.prescricaoId}`,
        },
      };
    },
  },

  {
    nome: "prescricao_criar",
    descricao:
      "Emite uma prescrição. Cada item tem nome, dose ('1 cápsula'), posologia ('1x ao " +
      "dia, em jejum') e duração ('60 dias') — tudo em texto, como se escreve no papel. " +
      "Item sem nome é descartado. Ela NÃO é assinada nem enviada por aqui: isso é na " +
      "tela, com o certificado da casa.",
    permissao: "prescriptions.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        tipo: {
          type: "string",
          enum: [
            "medication",
            "manipulated",
            "supplement",
            "exam",
            "referral",
            "certificate",
            "other",
          ],
          default: "medication",
        },
        titulo: { type: "string" },
        data: { type: "string", description: "AAAA-MM-DD. Sem ela, hoje." },
        valeAte: { type: "string", description: "AAAA-MM-DD." },
        itens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nome: { type: "string" },
              dose: { type: "string", description: "Quanto por vez: '1 comprimido'." },
              posologia: { type: "string", description: "Quando e como." },
              duracao: { type: "string" },
              observacao: { type: "string" },
            },
            required: ["nome"],
          },
        },
        observacoes: { type: "string", description: "O que não é de um item só." },
        conselho: {
          type: "string",
          description: "O registro de quem assina (CRN, CRM, CREF), como ele escreve.",
        },
      },
      required: ["pessoaId", "itens"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const itens = itensDaPrescricao(args.itens);
      // Receita sem item nenhum é uma folha em branco assinada. O modelo do
      // banco descarta o item sem nome em silêncio (a tela tem linha vazia no
      // fim); aqui, sobrar zero é motivo para não emitir.
      if (!itens.length) {
        return erro("prescricao_sem_itens", "Nenhum item tinha nome. Uma receita sem item não vale.");
      }

      const cheio = await cabeNoPlano(
        app,
        "prescriptions",
        limiteDoPlano.contarNa(app, "prescriptions")
      );
      if (cheio) return cheio;

      const id = await app.api.prescription.insert(user._id, args.pessoaId, {
        type: args.tipo,
        title: args.titulo,
        date: args.data,
        validUntil: args.valeAte,
        items: itens,
        notes: args.observacoes,
        council: args.conselho,
      });

      const criada = await app.api.prescription.data(user._id, id);

      return {
        ok: true,
        prescricao: prescricaoPublica(criada, true),
        alvo: {
          rota: `/people/${args.pessoaId}?tab=prescriptions`,
          destacar: `prescription:${id}`,
          recarregar: `prescription:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "prescricao_editar",
    descricao:
      "Corrige uma prescrição. `itens` SUBSTITUI a lista inteira quando vem — leia com " +
      "prescricao_ver e mande todos de volta. Corrigir um documento já entregue não " +
      "desfaz a cópia que a pessoa tem na mão: se ela já saiu, prefira emitir outra.",
    permissao: "prescriptions.manage",
    schema: {
      type: "object",
      properties: {
        prescricaoId: { type: "string" },
        tipo: {
          type: "string",
          enum: [
            "medication",
            "manipulated",
            "supplement",
            "exam",
            "referral",
            "certificate",
            "other",
          ],
        },
        titulo: { type: "string" },
        data: { type: "string" },
        valeAte: { type: "string" },
        itens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nome: { type: "string" },
              dose: { type: "string" },
              posologia: { type: "string" },
              duracao: { type: "string" },
              observacao: { type: "string" },
            },
            required: ["nome"],
          },
        },
        observacoes: { type: "string" },
        conselho: { type: "string" },
      },
      required: ["prescricaoId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.prescription.data(user._id, args.prescricaoId);
      if (!atual) return erro("prescricao_nao_encontrada");

      const mudanca = somenteOsDitos({
        type: args.tipo,
        title: args.titulo,
        date: args.data,
        validUntil: args.valeAte,
        notes: args.observacoes,
        council: args.conselho,
      });

      if (args.itens !== undefined) {
        const itens = itensDaPrescricao(args.itens);
        if (!itens.length) return erro("prescricao_sem_itens");
        mudanca.items = itens;
      }

      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      await app.api.prescription.update(user._id, args.prescricaoId, mudanca);
      const depois = await app.api.prescription.data(user._id, args.prescricaoId);

      return {
        ok: true,
        prescricao: prescricaoPublica(depois, true),
        alvo: {
          rota: `/people/${atual.student}?tab=prescriptions`,
          destacar: `prescription:${args.prescricaoId}`,
          recarregar: `prescription:${atual.student}`,
        },
      };
    },
  },

  {
    nome: "prescricao_excluir",
    descricao:
      "Apaga uma prescrição da ficha. Ela é um documento emitido: apagar tira o registro " +
      "de que foi emitida, e não recolhe a cópia que a pessoa levou.",
    permissao: "prescriptions.manage",
    schema: {
      type: "object",
      properties: { prescricaoId: { type: "string" } },
      required: ["prescricaoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.prescription.data(user._id, args.prescricaoId);
      if (!alvo) return erro("prescricao_nao_encontrada");

      await app.api.prescription.delete(user._id, args.prescricaoId);

      return {
        ok: true,
        alvo: {
          rota: `/people/${alvo.student}?tab=prescriptions`,
          recarregar: `prescription:${alvo.student}`,
        },
      };
    },
  },

  // ── Conversas ────────────────────────────────────────────────────────────
  //
  // A única área daqui que fala com ALGUÉM DE FORA. Todas as outras mexem em
  // dado que só o profissional lê; esta entrega texto no celular de uma pessoa,
  // com notificação, na hora, e sem desfazer.
  //
  // É por isso que enviar é `chat.send` e não `chat.view`, e por isso que a
  // descrição de `mensagem_enviar` avisa em voz alta o que ela faz: um modelo
  // que "testa" uma ferramenta de leitura não causa dano; um que testa esta
  // acorda o celular de alguém às onze da noite.
  {
    nome: "conversa_listar",
    descricao:
      "As conversas do profissional, com quem é a outra pessoa e quantas mensagens ele " +
      "ainda não leu. Use para pegar o id de uma conversa.",
    permissao: "chat.view",
    schema: {
      type: "object",
      properties: { limite: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
    },
    async executar(app, user, args) {
      const linhas = await app.api.chat.listOf(user._id, {
        limit: Math.min(50, Number(args.limite) || 20),
      });

      const outros = linhas.map((c) => app.api.chat.otherOf(c, user._id)).filter(Boolean);
      const nomes = await app.api.user.briefByIds(outros);

      return {
        ok: true,
        naoLidas: await app.api.chat.unreadTotal(user._id),
        conversas: linhas.map((c) => {
          const outro = app.api.chat.otherOf(c, user._id);
          return {
            id: String(c._id),
            pessoaId: outro ? String(outro) : null,
            pessoa: nomes?.[String(outro)]?.name || "",
            naoLidas: c.unread?.[String(user._id)] || 0,
            ultima: c.lastMessage || "",
            ultimaEm: c.lastAt ? new Date(c.lastAt).toISOString() : "",
          };
        }),
      };
    },
  },

  {
    nome: "conversa_mensagens",
    descricao:
      "As últimas mensagens de uma conversa, da mais antiga para a mais nova. Use para " +
      "saber o que já foi dito antes de responder — e não invente o que a pessoa escreveu.",
    permissao: "chat.view",
    schema: {
      type: "object",
      properties: {
        conversaId: { type: "string" },
        limite: { type: "integer", minimum: 1, maximum: 100, default: 40 },
      },
      required: ["conversaId"],
    },
    async executar(app, user, args) {
      const conversa = await app.api.chat.data(args.conversaId);
      // A MESMA regra de participação das rotas da tela: quem não é da conversa
      // não a lê, mesmo tendo o id dela.
      if (!conversa || !app.api.chat.isMember(conversa, user._id)) {
        return erro("conversa_nao_encontrada");
      }

      const linhas = await app.api.chat.messagesOf(args.conversaId, {
        limit: Math.min(100, Number(args.limite) || 40),
      });

      return {
        ok: true,
        mensagens: linhas.map((m) => ({
          de: String(m.from) === String(user._id) ? "eu" : "pessoa",
          texto: m.body || "",
          temAnexo: Boolean(m.file),
          quando: m.createdAt ? new Date(m.createdAt).toISOString() : "",
        })),
      };
    },
  },

  {
    nome: "mensagem_enviar",
    descricao:
      "ENVIA uma mensagem para a pessoa. Ela chega no celular dela na hora, com " +
      "notificação, e não dá para apagar depois. Abre a conversa se ainda não houver uma. " +
      "Use só quando o profissional pedir para mandar algo — nunca por iniciativa própria, " +
      "e nunca para testar se a ferramenta funciona.",
    permissao: "chat.send",
    naVoz: true,
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string", description: "Para quem. Use pessoa_buscar para achar." },
        texto: { type: "string", minLength: 1 },
      },
      required: ["pessoaId", "texto"],
    },
    async executar(app, user, args) {
      const texto = String(args.texto || "").trim();
      if (!texto) return erro("mensagem_vazia");

      // Conversa consigo mesmo não é conversa: os dois membros seriam o mesmo
      // id, e o contador de não lido não teria para quem subir.
      if (String(args.pessoaId) === String(user._id)) return erro("pessoa_nao_encontrada");

      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const conversa = await app.api.chat.openWith(user._id, args.pessoaId);
      const mensagem = await app.api.chat.send(conversa._id, user._id, texto);
      if (!mensagem) return erro("mensagem_vazia");

      // ── E O AVISO SAI, como na rota da tela ─────────────────────────────
      //
      // O WebSocket entrega na hora — para quem está com a conversa ABERTA.
      // Quem fechou o app não recebe nada, e mensagem que espera a pessoa
      // lembrar de abrir não é mensagem.
      //
      // Sem esta chamada, a ferramenta faria metade do que a tela faz e a
      // diferença só apareceria do lado de lá, em silêncio: o profissional
      // veria a mensagem enviada e a pessoa não saberia dela.
      avisarSemEsperar(app, "message", {
        para: args.pessoaId,
        de: user._id,
        lang: pessoa.lang,
        vars: { profissional: user.name, trecho: texto.slice(0, 120) },
      });

      return {
        ok: true,
        conversaId: String(conversa._id),
        alvo: { rota: `/chat?conversa=${conversa._id}`, recarregar: `chat:${conversa._id}` },
      };
    },
  },
];

const PORNOME = new Map(FERRAMENTAS.map((f) => [f.nome, f]));

function listar() {
  return FERRAMENTAS.map((f) => ({
    name: f.nome,
    description: f.descricao,
    inputSchema: f.schema,
  }));
}

function achar(nome) {
  return PORNOME.get(nome);
}

// As que a VOZ carrega. Ver `naVoz`, no cabeçalho do catálogo.
const NA_VOZ = FERRAMENTAS.filter((f) => f.naVoz === true);

module.exports = {
  FERRAMENTAS,
  NA_VOZ,
  listar,
  achar,
  erro,
  pessoaPublica,
  treinoPublico,
  ObjectId,
};
