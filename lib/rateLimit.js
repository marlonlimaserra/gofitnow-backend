// Limite de chamadas por chave de API.
//
// Janela DESLIZANTE, não fixa: com janela fixa de um minuto, 60 chamadas às
// 10:00:59 e mais 60 às 10:01:00 passam — 120 em dois segundos, que é o dobro
// do que o limite promete. Aqui guardo os horários das chamadas recentes e
// conto quantas caem nos últimos 60 segundos.
//
// EM MEMÓRIA, e isso é uma limitação consciente: o contador zera quando o
// processo reinicia e não é compartilhado entre processos. Hoje o GoFitNow roda
// um processo só (systemd, `node app.js`), então o limite é exato. No dia em
// que houver mais de um, isto precisa ir para o Mongo ou para um Redis — o
// contrato da função não muda, só o lugar onde o histórico mora.
const JANELA_MS = 60 * 1000;
const LIMITE_PADRAO = 60;

// chave → array de timestamps, do mais antigo para o mais novo.
const historico = new Map();

// Sem isto, uma chave usada uma vez e nunca mais ficaria na memória para
// sempre. Roda de vez em quando, não a cada chamada.
const LIMPEZA_MS = 5 * 60 * 1000;
let ultimaLimpeza = Date.now();

function limpar(agora) {
  if (agora - ultimaLimpeza < LIMPEZA_MS) return;
  ultimaLimpeza = agora;

  for (const [k, marcas] of historico) {
    if (!marcas.length || agora - marcas[marcas.length - 1] > JANELA_MS) historico.delete(k);
  }
}

// Devolve o que os cabeçalhos padrão de limite precisam saber. `allowed: false`
// quando estourou, com `retryAfter` em segundos.
function check(chave, limite = LIMITE_PADRAO) {
  const agora = Date.now();
  limpar(agora);

  const marcas = (historico.get(chave) || []).filter((t) => agora - t < JANELA_MS);

  if (marcas.length >= limite) {
    // Quando a mais antiga sai da janela, abre uma vaga.
    const liberaEm = marcas[0] + JANELA_MS - agora;
    historico.set(chave, marcas);
    return {
      allowed: false,
      limit: limite,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil(liberaEm / 1000)),
    };
  }

  marcas.push(agora);
  historico.set(chave, marcas);

  return {
    allowed: true,
    limit: limite,
    remaining: limite - marcas.length,
    retryAfter: 0,
  };
}

// Só para os testes: sem isto um caso vaza contagem para o seguinte.
function reset() {
  historico.clear();
  ultimaLimpeza = Date.now();
}

module.exports = { check, reset, JANELA_MS, LIMITE_PADRAO };
