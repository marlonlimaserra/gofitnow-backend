// QUANTAS VEZES ESTA PESSOA ERROU A SENHA.
//
// Serve a uma coisa só: decidir quando o login passa a EXIGIR o desafio
// (Turnstile). Pedido do Marlon: *"se a pessoa errar x vezes o login algo do tipo
// aí obriga"*.
//
// ── Por que não é um limite de chamadas ───────────────────────────────────
//
// `lib/rateLimit.js` responde "chega, volte depois" — 429. Aqui a resposta é
// outra: "continue, mas prove que é gente". A diferença importa, porque quem
// erra a senha três vezes normalmente é o dono da conta, e trancá-lo fora por
// quinze minutos é punir o caso comum para conter o raro.
//
// ── Duas chaves, e as duas são necessárias ────────────────────────────────
//
// Por E-MAIL: contém quem martela uma conta específica.
// Por IP: contém quem varre muitas contas a partir de um lugar — esse não faz a
//         contagem de e-mail nenhum subir, e sem a segunda chave passaria batido.
//
// Basta uma das duas estourar.
//
// ── Em memória, e UM contador só mesmo com cluster ────────────────────────
//
// Mesma escolha e mesma mecânica do `rateLimit`: com um Map por worker, um
// limiar de 3 viraria 3 × número de workers, e ninguém perceberia. Quem conta é
// sempre o PRIMÁRIO; os workers perguntam pelo canal do cluster.
//
// O que continua valendo: zera quando o processo reinicia, e não atravessa
// máquinas. Para este uso é aceitável — reiniciar o servidor devolve algumas
// tentativas sem desafio a um atacante, o que é bem menos grave do que o mesmo
// buraco num limite de cobrança. No dia do segundo servidor, isto vai para o
// Mongo ou um Redis e o contrato não muda.
const cluster = require("node:cluster");

// Quinze minutos: longo o bastante para cobrir uma sequência de tentativas, e
// curto o bastante para o dono da conta não carregar o desafio pelo resto do dia
// depois de finalmente entrar.
const JANELA_MS = 15 * 60 * 1000;

// chave → array de horários das falhas, do mais antigo para o mais novo.
const historico = new Map();

const LIMPEZA_MS = 5 * 60 * 1000;
let ultimaLimpeza = Date.now();

function limparVelhos(agora) {
  if (agora - ultimaLimpeza < LIMPEZA_MS) return;
  ultimaLimpeza = agora;

  for (const [k, marcas] of historico) {
    if (!marcas.length || agora - marcas[marcas.length - 1] > JANELA_MS) historico.delete(k);
  }
}

function contarUma(chave, agora) {
  const marcas = (historico.get(chave) || []).filter((t) => agora - t < JANELA_MS);
  if (marcas.length) historico.set(chave, marcas);
  else historico.delete(chave);
  return marcas.length;
}

// ── As três operações, na visão de quem tem o Map ─────────────────────────

function contar(chaves) {
  const agora = Date.now();
  limparVelhos(agora);
  // O MAIOR entre as chaves: basta uma estourar.
  return Math.max(0, ...(chaves || []).map((c) => contarUma(c, agora)));
}

function registrar(chaves) {
  const agora = Date.now();
  limparVelhos(agora);

  for (const chave of chaves || []) {
    const marcas = (historico.get(chave) || []).filter((t) => agora - t < JANELA_MS);
    marcas.push(agora);
    historico.set(chave, marcas);
  }
}

// Entrou: some com a contagem.
//
// Sem isto, quem errou duas vezes, acertou, e voltou dez minutos depois pegaria o
// desafio sem ter errado nada nessa visita.
function limpar(chaves) {
  for (const chave of chaves || []) historico.delete(chave);
}

// ── Atravessando o cluster ─────────────────────────────────────────────────
const PEDIDO = "tentativas:contar";
const RESPOSTA = "tentativas:resultado";
const AVISO = "tentativas:evento";
const PRAZO_MS = 1000;

let sequencia = 0;
const pendentes = new Map();

const noWorker = () => cluster.isWorker && typeof process.send === "function";

// Registrar e limpar não esperam resposta: ninguém depende do retorno, e uma ida
// e volta a mais no caminho do login não paga nada.
function registrarFalha(chaves) {
  if (noWorker()) process.send({ tipo: AVISO, acao: "registrar", chaves });
  else registrar(chaves);
}

function limparFalhas(chaves) {
  if (noWorker()) process.send({ tipo: AVISO, acao: "limpar", chaves });
  else limpar(chaves);
}

function contarFalhas(chaves) {
  if (!noWorker()) return Promise.resolve(contar(chaves));

  return new Promise((resolve) => {
    const id = ++sequencia;
    pendentes.set(id, resolve);
    process.send({ tipo: PEDIDO, id, chaves });

    // Primário mudo: responde ZERO, ou seja, NÃO exige o desafio.
    //
    // Falhar aberto, como no `rateLimit`. Um problema de comunicação interna não
    // pode virar um captcha que ninguém consegue resolver na tela de entrada — e
    // o desafio é uma segunda camada, não a que guarda a senha.
    setTimeout(() => {
      if (!pendentes.delete(id)) return;
      console.error(`[tentativas] primário não respondeu em ${PRAZO_MS}ms — sem desafio`);
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
    resolver(msg.total);
  });
}

// Chamado pelo primário para cada worker que nasce (ver app.js).
function atenderWorker(worker) {
  worker.on("message", (msg) => {
    if (!msg) return;

    if (msg.tipo === AVISO) {
      if (msg.acao === "registrar") registrar(msg.chaves);
      else if (msg.acao === "limpar") limpar(msg.chaves);
      return;
    }

    if (msg.tipo !== PEDIDO) return;
    try {
      worker.send({ tipo: RESPOSTA, id: msg.id, total: contar(msg.chaves) });
    } catch (error) {
      // Quem perguntou já não existe.
    }
  });
}

// As chaves de uma tentativa. O e-mail normalizado como o login o normaliza —
// senão "A@b.com" e "a@b.com" contariam separado, e alternar a caixa das letras
// zeraria o contador.
function chavesDe(email, ip) {
  const chaves = [];
  const e = String(email || "").trim().toLowerCase();
  if (e) chaves.push("email:" + e);
  if (ip) chaves.push("ip:" + ip);
  return chaves;
}

function reset() {
  historico.clear();
  ultimaLimpeza = Date.now();
  pendentes.clear();
}

module.exports = {
  chavesDe,
  contarFalhas,
  registrarFalha,
  limparFalhas,
  atenderWorker,
  reset,
  JANELA_MS,
};
