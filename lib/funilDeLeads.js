// O FUNIL DOS LEADS — de onde a pessoa veio, e em que pé ela está.
//
// *"crie uma nova rota chamada 'lead'. Esses leads vão ser os dados de pessoas
// que não pagam nada e nem são alunos"* (01/10/2026).
//
// ── POR QUE DUAS LISTAS FECHADAS, e não texto livre ──────────────────────
//
// É a mesma razão das categorias de conta a pagar: a tela existe para responder
// duas perguntas que só têm resposta se as linhas se agruparem.
//
//   ORIGEM  "o que me traz gente?"  — com campo livre, "Instagram", "insta",
//           "IG" e "instagram " viram quatro origens, e a resposta vira ruído.
//           É a pergunta que decide onde ele gasta dinheiro de anúncio.
//
//   ETAPA   "quem está esperando resposta minha?" — é ela que transforma uma
//           lista de contatos numa fila de trabalho. Sem etapa, um lead de
//           ontem e um de três meses atrás são a mesma linha.
//
// ── AS DUAS VÊM DO SERVIDOR, JÁ TRADUZIDAS ──────────────────────────────
//
// *"coloque esse status em uma variável no backend, assim se a gente adicionar
// um status novo, a chamada já traz, e não precisa mexer em nada do frontend"*.
// `icone` é nome de ícone do lucide, resolvido na tela.
const ORIGENS = [
  { id: "indicacao", icone: "Heart", rotulo: "leads.origin.indicacao", padrao: "Indicação" },
  { id: "instagram", icone: "Instagram", rotulo: "leads.origin.instagram", padrao: "Instagram" },
  { id: "facebook", icone: "Facebook", rotulo: "leads.origin.facebook", padrao: "Facebook" },
  { id: "whatsapp", icone: "MessageCircle", rotulo: "leads.origin.whatsapp", padrao: "WhatsApp" },
  { id: "site", icone: "Globe", rotulo: "leads.origin.site", padrao: "Site" },
  { id: "anuncio", icone: "Megaphone", rotulo: "leads.origin.anuncio", padrao: "Anúncio" },
  // QUEM PASSOU NA PORTA. Numa academia de rua é a maior origem de todas, e sem
  // uma linha própria ela se esconde dentro de "Outra" — que é onde as
  // respostas vão morrer.
  { id: "porta", icone: "DoorOpen", rotulo: "leads.origin.porta", padrao: "Passou na porta" },
  { id: "evento", icone: "PartyPopper", rotulo: "leads.origin.evento", padrao: "Evento" },
  { id: "outra", icone: "CircleHelp", rotulo: "leads.origin.outra", padrao: "Outra" },
];

// ── A ORDEM DAS ETAPAS É O FUNIL ─────────────────────────────────────────
//
// Elas são lidas de cima para baixo, e `ordem` existe para a tela poder
// agrupar e somar sem saber o que cada id significa. Os dois últimos são
// SAÍDAS — de lá não se volta no caminho normal — e por isso carregam `fim`.
const ETAPAS = [
  { id: "novo", ordem: 1, cor: "slate", icone: "Sparkles", rotulo: "leads.stage.novo", padrao: "Novo" },
  { id: "contato", ordem: 2, cor: "blue", icone: "PhoneCall", rotulo: "leads.stage.contato", padrao: "Em contato" },
  { id: "visita", ordem: 3, cor: "amber", icone: "CalendarCheck", rotulo: "leads.stage.visita", padrao: "Visita marcada" },
  { id: "proposta", ordem: 4, cor: "violet", icone: "FileText", rotulo: "leads.stage.proposta", padrao: "Proposta enviada" },
  // VIROU ALUNO. Hoje só se marca à mão — nada aqui cria a pessoa. É de
  // propósito: converter é um gesto com consequências (cobrança, acesso, app),
  // e ele merece a própria tela quando chegar a hora.
  { id: "convertido", ordem: 5, fim: true, cor: "emerald", icone: "CircleCheck", rotulo: "leads.stage.convertido", padrao: "Virou aluno" },
  { id: "perdido", ordem: 6, fim: true, cor: "red", icone: "CircleX", rotulo: "leads.stage.perdido", padrao: "Perdido" },
];

const ORIGEM_PADRAO = "outra";
const ETAPA_PADRAO = "novo";

const IDS_DE_ORIGEM = ORIGENS.map((o) => o.id);
const IDS_DE_ETAPA = ETAPAS.map((e) => e.id);

// As etapas que ainda esperam alguma coisa de alguém. É o recorte que a lista
// abre por padrão: um lead perdido em março não é trabalho de hoje.
const ETAPAS_ABERTAS = ETAPAS.filter((e) => !e.fim).map((e) => e.id);

function existeOrigem(id) {
  return IDS_DE_ORIGEM.includes(String(id || ""));
}

function existeEtapa(id) {
  return IDS_DE_ETAPA.includes(String(id || ""));
}

// O que não existe vira o padrão, e não vazio: um lead sem origem some do
// relatório por origem, que é o relatório inteiro. Mesma regra da categoria.
function normalizarOrigem(id) {
  return existeOrigem(id) ? String(id) : ORIGEM_PADRAO;
}

function normalizarEtapa(id) {
  return existeEtapa(id) ? String(id) : ETAPA_PADRAO;
}

// Os PEDIDOS da tela, em texto separado por vírgula. O que não existe cai fora:
// o valor entra num `$in`, e aceitar o que vier é deixar a tela escolher por
// qual chave o banco filtra.
function etapasPedidas(bruto) {
  return String(bruto || "")
    .split(",")
    .map((x) => x.trim())
    .filter(existeEtapa);
}

function origensPedidas(bruto) {
  return String(bruto || "")
    .split(",")
    .map((x) => x.trim())
    .filter(existeOrigem);
}

// `padrao` é o rótulo de quem não tem tradutor — o painel da central é interno
// e em português, e chamaria isto sem `t`. Mesma saída de `categoriasDeConta`:
// o catálogo carrega o texto de reserva em vez de existir uma segunda lista.
function paraTela(t) {
  return {
    origens: ORIGENS.map((o) => ({
      id: o.id,
      label: t ? t(o.rotulo) : o.padrao || o.rotulo,
      icone: o.icone,
    })),
    etapas: ETAPAS.map((e) => ({
      id: e.id,
      label: t ? t(e.rotulo) : e.padrao || e.rotulo,
      icone: e.icone,
      cor: e.cor,
      ordem: e.ordem,
      fim: Boolean(e.fim),
    })),
  };
}

module.exports = {
  ORIGENS,
  ETAPAS,
  ORIGEM_PADRAO,
  ETAPA_PADRAO,
  IDS_DE_ORIGEM,
  IDS_DE_ETAPA,
  ETAPAS_ABERTAS,
  existeOrigem,
  existeEtapa,
  normalizarOrigem,
  normalizarEtapa,
  etapasPedidas,
  origensPedidas,
  paraTela,
};
