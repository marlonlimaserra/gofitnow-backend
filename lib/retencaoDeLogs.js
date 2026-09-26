// POR QUANTOS DIAS O SISTEMA GUARDA O QUE FOI FEITO.
//
// *"na central, cadastre em Configuração mais uma rota chamada retenção de
// logs, para a gente definir quantos dias vamos reter esses logs; por enquanto
// só teremos esse padrão, 6 meses"* (25/09/2026).
//
// Era uma constante no `schema.js` — mudar a retenção era mudar uma linha e
// fazer deploy. Agora é uma decisão de quem administra o produto, tomada numa
// tela.
//
// ── ONDE O NÚMERO MORA, e por que não aqui dentro ────────────────────────
//
// No banco do PAINEL (`settings`, chave `logs.retentionDays`), porque a decisão
// é do produto e não de um cliente: a poda é uma só para todos os bancos, e o
// índice TTL do Mongo — que é quem apaga — não sabe o que é uma instância.
//
// Este arquivo é a régua compartilhada: o valor padrão, os limites e a leitura.
// Três lugares precisam dela — o schema no boot, a rota interna que reaplica, e
// a aba Histórico da ficha, que diz em voz alta quanto tempo a casa guarda. Sem
// um lugar só, os três divergiriam no primeiro ajuste.
const CHAVE = "logs.retentionDays";

// ── E QUANTO TEMPO O BRUTO DA META FICA ──────────────────────────────────
//
// *"salve o bruto numa collection do MongoDB, coloque na central
// /configuracao/retencao"* (26/09/2026).
//
// Número SEPARADO do histórico de ações, e de propósito: são dados de
// naturezas diferentes. O histórico é auditoria — quem mexeu no quê, guardado
// por meses porque alguém vai perguntar. O bruto da Meta é registro de
// PASSAGEM: serve para depurar a integração e para não perder o que ela não
// reenvia. Um número só faria a primeira mudança mexer no dado errado.
const CHAVE_EVENTOS = "meta.eventRetentionDays";

// Trinta dias. Tempo de sobra para achar "por que aquela mensagem não chegou?"
// sem a collection virar um depósito.
const PADRAO_EVENTOS = 30;

// Mínimo de um dia: abaixo disso não dá para depurar nada — o evento some antes
// de alguém abrir o painel. Máximo de um ano, que é onde deixa de ser registro
// de passagem e vira histórico com outro nome.
const MIN_EVENTOS = 1;
const MAX_EVENTOS = 365;

// SEIS MESES. É o que já valia quando o número era constante, então nada muda
// para quem nunca abrir a tela.
const PADRAO = 180;

// ── Os limites, e por que existem os dois ────────────────────────────────
//
// O mínimo protege a auditoria: uma retenção de dois dias transforma o
// histórico em enfeite, e quem a digitasse por engano só descobriria quando
// precisasse do registro que já foi apagado — tarde demais, por definição.
//
// O máximo protege o banco: dez anos de auditoria numa collection que só
// escreve é um custo que cresce para sempre. Quem precisar de mais que isso
// precisa de arquivo morto, não de TTL.
const MIN = 30;
const MAX = 3650;

function normalizarEventos(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n)) return PADRAO_EVENTOS;
  if (n < MIN_EVENTOS || n > MAX_EVENTOS) return PADRAO_EVENTOS;
  return n;
}

async function lerEventosDoCentral(central) {
  try {
    const doc = await central.collection("settings").findOne({ key: CHAVE_EVENTOS });
    if (doc == null || doc.value == null) return PADRAO_EVENTOS;
    return normalizarEventos(doc.value);
  } catch (erro) {
    return PADRAO_EVENTOS;
  }
}

function normalizar(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n)) return PADRAO;
  if (n < MIN || n > MAX) return PADRAO;
  return n;
}

// Lê do banco do painel. NUNCA estoura: um painel fora do ar não pode impedir
// este backend de subir — cai no padrão, que é o que valia antes de a tela
// existir.
async function lerDoCentral(central) {
  try {
    const doc = await central.collection("settings").findOne({ key: CHAVE });
    if (doc == null || doc.value == null) return PADRAO;
    return normalizar(doc.value);
  } catch (erro) {
    return PADRAO;
  }
}

module.exports = {
  CHAVE,
  PADRAO,
  MIN,
  MAX,
  normalizar,
  lerDoCentral,
  // O bruto da Meta, com número próprio.
  CHAVE_EVENTOS,
  PADRAO_EVENTOS,
  MIN_EVENTOS,
  MAX_EVENTOS,
  normalizarEventos,
  lerEventosDoCentral,
};
