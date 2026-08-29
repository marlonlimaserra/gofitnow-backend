const cluster = require("node:cluster");

// A TRAVA DE ENVIO — uma mesma coisa não sai duas vezes em cinco minutos.
//
// Pedido do Marlon: *"nas chamadas que enviam e-mail, coloque uma trava de 5
// minutos, para evitar de alguém flodar a chamada"*.
//
// ── Por que não serve o `rateLimit` que já existe ─────────────────────────
//
// Aquele conta CHAMADAS por chave de API, numa janela de um minuto, e responde
// "chega, volte depois". Aqui a unidade é outra: não é quantas vezes a rota foi
// chamada, é quantas vezes AQUELE documento foi mandado para AQUELA pessoa. Dez
// profissionais mandando dez documentos diferentes no mesmo minuto é uso normal;
// o mesmo documento dez vezes é dedo nervoso ou abuso.
//
// ── O que a trava protege, e é mais do que incômodo ───────────────────────
//
// Cada envio custa cota da Resend e reputação do domínio. Um botão apertado
// vinte vezes enche a caixa de um cliente com o mesmo PDF — e quem recebe marca
// como spam, o que estraga a entrega para todos os outros.
//
// ── Em memória, e UM contador só mesmo com cluster ────────────────────────
//
// Mesma mecânica do `rateLimit` e do contador de senha errada: com um Map por
// worker, a trava de 5 minutos valeria 5 minutos VEZES o número de workers de
// folga. Quem guarda é o PRIMÁRIO; os workers perguntam pelo canal do cluster.
//
// Zera no reinício — aceitável: reiniciar libera um reenvio adiantado, o que é
// bem menos grave do que um serviço que não sobe.
const JANELA_MS = 5 * 60 * 1000;

// chave → horário do último envio.
const ultimos = new Map();

const LIMPEZA_MS = 5 * 60 * 1000;
let ultimaLimpeza = Date.now();

function limparVelhos(agora) {
  if (agora - ultimaLimpeza < LIMPEZA_MS) return;
  ultimaLimpeza = agora;

  for (const [k, quando] of ultimos) {
    if (agora - quando > JANELA_MS) ultimos.delete(k);
  }
}

// Quantos SEGUNDOS faltam para poder mandar de novo. Zero quer dizer "pode".
function faltam(chave, janela) {
  const agora = Date.now();
  limparVelhos(agora);

  const ultimo = ultimos.get(chave);
  if (!ultimo) return 0;

  const restante = janela - (agora - ultimo);
  return restante > 0 ? Math.ceil(restante / 1000) : 0;
}

function marcar(chave) {
  limparVelhos(Date.now());
  ultimos.set(chave, Date.now());
}

// ── Atravessando o cluster ─────────────────────────────────────────────────
const PEDIDO = "trava:faltam";
const RESPOSTA = "trava:resultado";
const AVISO = "trava:marcar";
const PRAZO_MS = 1000;

let sequencia = 0;
const pendentes = new Map();

const noWorker = () => cluster.isWorker && typeof process.send === "function";

function marcarEnvio(chave) {
  if (noWorker()) process.send({ tipo: AVISO, chave });
  else marcar(chave);
}

function faltamSegundos(chave, janela = JANELA_MS) {
  if (!noWorker()) return Promise.resolve(faltam(chave, janela));

  return new Promise((resolve) => {
    const id = ++sequencia;
    pendentes.set(id, resolve);
    process.send({ tipo: PEDIDO, id, chave, janela });

    // Primário mudo: DEIXA PASSAR.
    //
    // Falhar aberto, como no limite de chamadas. Um problema de comunicação
    // interna não pode virar "não consigo mandar a recuperação de senha" — a
    // trava existe contra abuso, não para ser o motivo de o sistema parar.
    setTimeout(() => {
      if (!pendentes.delete(id)) return;
      console.error(`[trava] primário não respondeu em ${PRAZO_MS}ms — deixando passar`);
      resolve(0);
    }, PRAZO_MS).unref();
  });
}

if (cluster.isWorker) {
  process.on("message", (msg) => {
    if (!msg || msg.tipo !== RESPOSTA) return;
    const resolver = pendentes.get(msg.id);
    if (!resolver) return;
    pendentes.delete(msg.id);
    resolver(msg.faltam);
  });
}

// Chamado pelo primário para cada worker que nasce (ver app.js).
function atenderWorker(worker) {
  worker.on("message", (msg) => {
    if (!msg) return;

    if (msg.tipo === AVISO) return marcar(msg.chave);
    if (msg.tipo !== PEDIDO) return;

    try {
      worker.send({ tipo: RESPOSTA, id: msg.id, faltam: faltam(msg.chave, msg.janela) });
    } catch (error) {
      // Quem perguntou já não existe.
    }
  });
}

function reset() {
  ultimos.clear();
  ultimaLimpeza = Date.now();
  pendentes.clear();
}

// ── LIGADA OU NÃO, E POR QUANTO TEMPO — decidido na central ──────────────
//
// Pedido do Marlon: *"bote essa configuração na central para eu poder ativar e
// desativar e também configurar o tempo, pois como estou testando devo desativar
// por enquanto"*.
//
// Ele tem razão, e o motivo é maior que a conveniência: uma proteção que não se
// desliga vira o motivo de alguém tirá-la do código. Desligável, ela sobrevive.
//
// Mesma collection `settings` do banco central que guarda a chave da Resend e a
// do desafio anti-robô — sem chamada HTTP entre os dois serviços.
//
// LIGADA por omissão. Uma casa nova está protegida sem ninguém configurar nada;
// quem quiser testar desmarca.
const NOMES = ["email.throttleEnabled", "email.throttleMinutes"];

async function configuracao(app) {
  try {
    const db = await app.mongodb.centralDb();
    const docs = await db.collection("settings").find({ key: { $in: NOMES } }).toArray();
    const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));

    // ── `null` NÃO É ZERO ────────────────────────────────────────────
    //
    // `Number(null)` é 0, e 0 desliga a trava. Uma chave gravada como nula — o
    // que acontece quando alguém limpa o campo — desligaria a proteção em
    // silêncio, sem ninguém ter pedido.
    //
    // Zero explícito continua desligando: é uma escolha legítima, e está escrita
    // na tela. O que não pode é "ausente" virar "desligado".
    const cru = v["email.throttleMinutes"];
    const temValor = typeof cru === "number" || (typeof cru === "string" && cru.trim() !== "");
    const minutos = temValor ? Number(cru) : NaN;
    const janela = Number.isFinite(minutos) && minutos >= 0 ? minutos * 60 * 1000 : JANELA_MS;

    return {
      // `!== false` e não `Boolean(...)`: a chave AUSENTE tem de significar
      // ligada. Com `Boolean`, uma central que nunca foi configurada deixaria a
      // trava desligada — o oposto do padrão seguro.
      ligada: v["email.throttleEnabled"] !== false && janela > 0,
      janela,
    };
  } catch (erro) {
    // Central fora do ar: mantém a trava com a janela padrão. Aqui o lado certo
    // para errar é o conservador — o custo é um reenvio adiado, não um envio
    // impedido para sempre.
    console.error("[trava] não consegui ler a configuração:", erro.message);
    return { ligada: true, janela: JANELA_MS };
  }
}

module.exports = { faltamSegundos, marcarEnvio, atenderWorker, reset, configuracao, JANELA_MS };
