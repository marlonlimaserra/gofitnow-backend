// OS ESTADOS DE UMA RECORRÊNCIA — a lista, num lugar só.
//
// Pedido do Marlon em 17/09/2026: *"a recorrencia pode ter status ativo ou
// cancelado e pode ter motivo do cancalamento etc..."*.
//
// ── POR QUE UM ESTADO, e não a caixinha que havia antes ──────────────────
//
// Havia `active: true/false`, e ela respondia "gera ou não gera". A pergunta que
// faltava é POR QUE parou — e um booleano não tem onde guardar isso.
//
// Um combinado que acabou tem história: a pessoa saiu, trocou de plano, ficou
// devendo, pediu pausa. Meses depois alguém abre a ficha e vê uma regra parada
// sem nenhuma explicação ao lado, e a pergunta vira conversa no WhatsApp.
//
// ── E VEM DO SERVIDOR pelo mesmo motivo dos status de cobrança ───────────
//
// *"coloque esse status, em uma variavel no backend, [{},{}] assim, se agente
// adicionar um status novo, a chamada ja traz, e não precisa mexer em nada do
// frontend."* O "etc..." do pedido é o que faz isto valer: "pausada" e
// "encerrada" são candidatas óbvias, e cada uma será uma linha aqui.
//
// `gera` é o que separa os estados de verdade: é ele que a geração consulta, e
// não o nome. Um estado novo que não deva cobrar nasce com `gera: false` e a
// rotina diária o respeita sem saber que ele existe.
const STATUS = [
  { id: "active", tom: "ok", rotulo: "finance.recurrenceStatus.active", gera: true },
  { id: "canceled", tom: "neutro", rotulo: "finance.recurrenceStatus.canceled", gera: false },
];

const IDS = STATUS.map((s) => s.id);
const PADRAO = "active";

// Os que continuam gerando cobrança. A geração pergunta a ESTA lista, e não a um
// `!== "canceled"` espalhado pelo código: assim o dia em que "pausada" entrar,
// ela para de gerar sem ninguém procurar os lugares.
const GERAM = STATUS.filter((s) => s.gera).map((s) => s.id);

// Os que PEDEM motivo. Hoje é só o cancelamento, e o motivo continua opcional —
// obrigá-lo faria alguém digitar "." para conseguir salvar.
const PEDEM_MOTIVO = STATUS.filter((s) => !s.gera).map((s) => s.id);

function existe(id) {
  return IDS.includes(String(id || ""));
}

function normalizar(id) {
  return existe(id) ? String(id) : PADRAO;
}

// O catálogo como a tela o recebe: id, rótulo já traduzido e o tom semântico.
//
// Tom e não classe de CSS — mesma razão do `statusDeCobranca`: o app, o painel e
// o papel pintam o mesmo estado de formas diferentes, e um `bg-emerald-50`
// viajando pela API amarraria os três ao Tailwind da web.
function paraTela(t) {
  return STATUS.map((s) => ({
    id: s.id,
    label: t ? t(s.rotulo) : s.rotulo,
    tom: s.tom,
    gera: s.gera,
    pedeMotivo: !s.gera,
  }));
}

module.exports = { STATUS, IDS, PADRAO, GERAM, PEDEM_MOTIVO, existe, normalizar, paraTela };
