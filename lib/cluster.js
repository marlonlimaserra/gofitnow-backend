const cluster = require("node:cluster");
const os = require("node:os");

// Subir a API em vários processos.
//
// O Node roda JavaScript num núcleo só. Numa máquina de vários núcleos, um
// processo único deixa os outros parados: cada requisição que gasta CPU (hash de
// senha, PDF, imagem) bloqueia todas as demais enquanto roda. O cluster resolve
// isso abrindo um processo por núcleo, todos ouvindo a MESMA porta — quem
// distribui é o sistema operacional.
//
// O que ele NÃO resolve: nada aqui deixa o código mais rápido por si. Se a
// máquina tem um núcleo, um worker é o certo, e forkar quatro só faz os quatro
// disputarem o mesmo núcleo — fica mais lento, não mais rápido.
//
// A consequência que morde é outra: com mais de um processo, TODO estado em
// memória passa a ter uma cópia por worker. O contador de limite de chamadas é o
// caso — quatro cópias fariam o limite de 60/min valer 240, e cada worker acharia
// que está limitando certo. Por isso `lib/rateLimit.js` mantém UM contador, no
// primário, e os workers perguntam a ele pelo canal do cluster. É o que tornou
// seguro passar de um processo para vários.

// Quantos processos servem.
//
// Padrão: um por núcleo. `WORKERS` no ambiente manda quando existe.
//
// O `npm start` (desenvolvimento) fixa WORKERS=1 de propósito: nesta máquina
// `availableParallelism()` dá 15, e quinze processos com nodemon em cima é log
// embaralhado e depurador que não sabe em quem parar. Em produção a variável não
// existe e vale o número de núcleos.
function quantos() {
  const pedido = Number(process.env.WORKERS);
  if (Number.isFinite(pedido) && pedido >= 1) return Math.floor(pedido);

  if (typeof os.availableParallelism === "function") return os.availableParallelism();
  return os.cpus().length || 1;
}

// Prazo para as requisições em curso terminarem antes de o processo ser morto à
// força. Menor que o `TimeoutStopSec` do systemd, senão quem mata é ele e a
// parada graciosa nunca acontece.
const PRAZO_MS = 10 * 1000;

// Um worker: serve no próprio processo, sem forkar.
//
// Não é uma otimização, é legibilidade: em desenvolvimento o nodemon e o
// depurador falam com UM processo, e um erro de boot aparece onde se está
// olhando em vez de num filho que morreu calado. Como o padrão é um por núcleo,
// máquina de um núcleo cai aqui naturalmente.
async function sozinho({ nome, preparar, servir }) {
  await preparar();
  const server = await servir();
  pararComGraca(nome, server);
  return server;
}

// SIGTERM é o que o systemd manda no `restart` e no `stop`. Sem tratar, o
// processo morre no meio das requisições em curso e quem estava esperando recebe
// conexão cortada.
function pararComGraca(nome, server) {
  let parando = false;

  const parar = (sinal) => {
    if (parando) return;
    parando = true;
    console.log(`[${nome}] ${process.pid} recebeu ${sinal}, terminando o que já começou`);

    // Para de aceitar conexão nova e espera as abertas fecharem.
    if (server && typeof server.close === "function") {
      server.close(() => process.exit(0));
    }

    // Rede pendurada não pode impedir a parada para sempre. `unref` para este
    // timer não ser o único motivo de o processo continuar vivo.
    setTimeout(() => {
      console.error(`[${nome}] ${process.pid} passou do prazo, saindo à força`);
      process.exit(1);
    }, PRAZO_MS).unref();
  };

  process.on("SIGTERM", () => parar("SIGTERM"));
  process.on("SIGINT", () => parar("SIGINT"));
}

// O primário: prepara o banco, forka, repõe quem morre e coordena a parada.
async function primario({ nome, preparar, quantidade, aoNascerWorker }) {
  // O banco é preparado UMA vez, aqui, antes de existir worker.
  //
  // Índice é idempotente, então N workers criando os mesmos índices não
  // corromperia nada — mas é o mesmo trabalho feito N vezes, no momento mais
  // sensível (o boot), e uma falha apareceria N vezes no log sem dizer que é a
  // mesma. Quando um worker sobe, o banco já está pronto.
  await preparar();

  // `aoNascerWorker` é como o primário assume trabalho que não pode ser feito em
  // N cópias — hoje, ser o dono do contador de limite de chamadas. Fica como
  // gancho e não escrito aqui dentro para este arquivo não precisar conhecer o
  // limitador: o central usa o mesmo cluster e não tem limitador nenhum.
  const nascer = () => {
    const w = cluster.fork();
    if (typeof aoNascerWorker === "function") aoNascerWorker(w);
    return w;
  };

  console.log(`[${nome}] primário ${process.pid} subindo ${quantidade} worker(s)`);
  for (let i = 0; i < quantidade; i++) nascer();

  // Freio de reposição.
  //
  // Repor quem morre é o ponto do cluster. Mas se o worker morre NO BOOT — falta
  // de variável de ambiente, arquivo com erro de sintaxe — repor sem freio vira
  // um laço de fork que come a máquina e enche o log, sem nunca subir. Morrer
  // rápido várias vezes seguidas é diagnóstico: o processo não está caindo, está
  // nascendo errado.
  const VIDA_CURTA_MS = 5000;
  const MAX_SEGUIDAS = 5;
  let seguidas = 0;
  const nascimento = new Map();

  let parando = false;

  cluster.on("online", (w) => nascimento.set(w.process.pid, Date.now()));

  cluster.on("exit", (w, code, signal) => {
    const viveu = Date.now() - (nascimento.get(w.process.pid) || Date.now());
    nascimento.delete(w.process.pid);

    if (parando) return;

    const motivo = signal ? `sinal ${signal}` : `código ${code}`;
    console.error(`[${nome}] worker ${w.process.pid} saiu (${motivo}) depois de ${viveu}ms`);

    if (viveu < VIDA_CURTA_MS) {
      seguidas += 1;
      if (seguidas >= MAX_SEGUIDAS) {
        console.error(
          `[${nome}] ${seguidas} workers morreram em menos de ${VIDA_CURTA_MS}ms cada. ` +
            "Isto é erro de boot, não queda — desistindo em vez de forkar em laço."
        );
        process.exit(1);
      }
    } else {
      // Viveu o suficiente: foi queda, não boot torto. O contador zera para uma
      // queda hoje e outra amanhã não somarem até a desistência.
      seguidas = 0;
    }

    nascer();
  });

  const parar = (sinal) => {
    if (parando) return;
    parando = true;
    console.log(`[${nome}] primário recebeu ${sinal}, pedindo parada aos workers`);

    for (const w of Object.values(cluster.workers || {})) w.kill("SIGTERM");

    // Quem não terminar no prazo é morto à força. Sem isto, um worker preso
    // deixaria o systemd esperando até o timeout dele.
    setTimeout(() => {
      for (const w of Object.values(cluster.workers || {})) w.kill("SIGKILL");
      process.exit(0);
    }, PRAZO_MS + 2000).unref();

    // Se todos saírem antes do prazo, sai na hora.
    const conferir = setInterval(() => {
      if (Object.keys(cluster.workers || {}).length === 0) {
        clearInterval(conferir);
        process.exit(0);
      }
    }, 200);
    conferir.unref();
  };

  process.on("SIGTERM", () => parar("SIGTERM"));
  process.on("SIGINT", () => parar("SIGINT"));
}

// `preparar` roda uma vez, no processo que coordena: conexão e schema.
// `servir` roda em cada processo que atende, e devolve o server do `listen`.
async function start({ nome, preparar, servir, aoNascerWorker }) {
  const quantidade = quantos();

  if (quantidade === 1) return sozinho({ nome, preparar, servir });

  if (cluster.isPrimary) return primario({ nome, preparar, quantidade, aoNascerWorker });

  // No worker. Não prepara o banco — já está pronto.
  const server = await servir();
  pararComGraca(nome, server);
  return server;
}

module.exports = { start, quantos, PRAZO_MS };
