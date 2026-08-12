// Limite de chamadas por chave de API.
//
// Janela DESLIZANTE, não fixa: com janela fixa de um minuto, 60 chamadas às
// 10:00:59 e mais 60 às 10:01:00 passam — 120 em dois segundos, que é o dobro
// do que o limite promete. Aqui guardo os horários das chamadas recentes e
// conto quantas caem nos últimos 60 segundos.
//
// EM MEMÓRIA, e há UM contador só — mesmo com o cluster ligado.
//
// Com vários processos, um Map por worker faria o limite de 60 valer 60 × número
// de workers, e ninguém perceberia: cada processo acha que está limitando certo.
// Em vez de mover o histórico para o Mongo, quem decide é sempre o PRIMÁRIO, e os
// workers perguntam a ele pelo canal do cluster (`checkShared`). O primário não
// atende requisição, então está livre para isso, e a ida e volta é entre
// processos da mesma máquina — sem rede, sem banco.
//
// O que continua valendo: o contador zera quando o processo reinicia, e não é
// compartilhado entre MÁQUINAS. No dia em que houver um segundo servidor, o
// histórico precisa ir para o Mongo ou um Redis — o contrato não muda, só o lugar
// onde ele mora.
const cluster = require("node:cluster");

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

// ── Atravessando o cluster ─────────────────────────────────────────────────
//
// `check` acima decide olhando o Map deste processo. `checkShared` é o que as
// rotas chamam: no worker ela pergunta ao primário; fora do cluster ela decide
// aqui mesmo, porque o Map deste processo é o único que existe.
const PEDIDO = "rateLimit:check";
const RESPOSTA = "rateLimit:resultado";

// Quanto esperar a resposta do primário antes de desistir.
const PRAZO_MS = 1000;

let sequencia = 0;
const pendentes = new Map();

function checkShared(chave, limite = LIMITE_PADRAO) {
  if (!cluster.isWorker || typeof process.send !== "function") {
    return Promise.resolve(check(chave, limite));
  }

  return new Promise((resolve) => {
    const id = ++sequencia;
    pendentes.set(id, resolve);
    process.send({ tipo: PEDIDO, id, chave, limite });

    // Se o primário não responder, DEIXA PASSAR.
    //
    // Falhar aberto é a escolha certa aqui: um problema de comunicação interna
    // não pode virar 429 ou 500 para quem não fez nada de errado. O limite existe
    // para conter abuso, não para ser o motivo de a API parar. `degraded` vai no
    // resultado para o caso aparecer em log em vez de passar em silêncio.
    setTimeout(() => {
      if (!pendentes.delete(id)) return;
      console.error(`[rateLimit] primário não respondeu em ${PRAZO_MS}ms — deixando passar`);
      resolve({ allowed: true, limit: limite, remaining: limite, retryAfter: 0, degraded: true });
    }, PRAZO_MS).unref();
  });
}

if (cluster.isWorker) {
  process.on("message", (msg) => {
    if (!msg || msg.tipo !== RESPOSTA) return;
    const resolver = pendentes.get(msg.id);
    if (!resolver) return; // chegou depois do prazo
    pendentes.delete(msg.id);
    resolver(msg.resultado);
  });
}

// Chamado pelo primário para cada worker que nasce (ver lib/cluster.js).
function atenderWorker(worker) {
  worker.on("message", (msg) => {
    if (!msg || msg.tipo !== PEDIDO) return;
    // `worker.send` pode falhar se ele morreu entre o pedido e a resposta.
    try {
      worker.send({ tipo: RESPOSTA, id: msg.id, resultado: check(msg.chave, msg.limite) });
    } catch (error) {
      // Nada a fazer: quem perguntou já não existe.
    }
  });
}

// Só para os testes: sem isto um caso vaza contagem para o seguinte.
function reset() {
  historico.clear();
  ultimaLimpeza = Date.now();
  pendentes.clear();
}

module.exports = { check, checkShared, atenderWorker, reset, JANELA_MS, LIMITE_PADRAO };
