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

module.exports = { CHAVE, PADRAO, MIN, MAX, normalizar, lerDoCentral };
