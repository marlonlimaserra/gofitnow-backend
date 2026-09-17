const fila = require("./fila.js");
const redis = require("./redis.js");
const instanceContext = require("./instance.js");

// O TIQUE DIÁRIO — quem coloca trabalho na fila.
//
// Desenho do Marlon: *"todo dia enviar um cron para rabbit, com o id da
// recorrência e instancia, ai essa mensagem passaria pela funcao que verifica se
// deve gerar a cobrança ou não"*.
//
// Uma mensagem POR RECORRÊNCIA, com o id dela e o da instância — como ele pediu.
// Eu tinha sugerido uma por instância, porque a maioria das mensagens de um dia
// qualquer não tem nada a fazer; ele preferiu por recorrência, e nesta escala a
// diferença é irrelevante. O dia em que for, o lugar de mudar é uma linha aqui.
//
// ── A MENSAGEM LEVA ID, E NÃO O DOCUMENTO ────────────────────────────────
//
// Entre publicar e consumir cabe uma edição: o valor muda, a regra é desativada,
// a pessoa é apagada. Uma mensagem com a cópia do valor geraria a cobrança do
// preço velho, e ninguém entenderia de onde saiu. O consumidor relê.
//
// ── E O CONSUMIDOR NÃO DECIDE NADA ───────────────────────────────────────
//
// Ele chama `recurrence.gerar({ recurrence })` — a MESMA função que a leitura da
// tela chama. Um segundo caminho que decidisse por conta própria divergiria do
// primeiro na primeira regra nova, e divergiria calado: ninguém compara o que a
// fila gerou com o que a tela geraria.

// De quanto em quanto tempo o primário acorda para ver se já é hora.
//
// Trinta minutos, e não um alarme marcado para as 3h: um alarme perde o dia se o
// processo estiver reiniciando naquele minuto. Acordando de meia em meia hora, o
// pior caso de um deploy no horário é meia hora de atraso — e a trava do dia
// garante que acordar 48 vezes publica uma vez só.
const INTERVALO_MS = 30 * 60 * 1000;

// ── A TRAVA É CHAVEADA PELO DIA, e não por uma duração ───────────────────
//
// A primeira versão usava uma chave fixa com prazo de 23h, e ela DERIVA: publica
// às 03:00, a chave morre às 02:00 do dia seguinte, o tique das 02:00 publica de
// novo — e o horário anda para trás meia hora por dia até cruzar a meia-noite,
// quando um dia do calendário recebe dois tiques e outro, nenhum.
//
// Com o dia na chave, cada data tem a sua e não há o que derivar. O prazo passa
// a ser só faxina: 25h garante que a chave de hoje ainda esteja viva no último
// tique de hoje, e ela some sozinha depois.
//
// UTC, e não o fuso da conta: a chave é do PROCESSO, não de um cliente. São
// vários fusos numa instalação só, e "o dia" aqui precisa ser um só.
const TRAVA_MS = 25 * 60 * 60 * 1000;

function chaveDoDia(hoje = new Date()) {
  return `rotinaDiaria:recorrencias:${hoje.toISOString().slice(0, 10)}`;
}

// ── QUEM PUBLICA ─────────────────────────────────────────────────────────
//
// Uma volta por instância, dentro do contexto dela. É a parte que não existia:
// tudo neste backend lê o cliente do contexto assíncrono, e `connectToServer()`
// estoura de propósito fora dele (`lib/instanceGate.js`). Trabalho de fundo
// precisa ENTRAR no contexto, e é isto aqui.
async function publicarRecorrencias(app) {
  if (!fila.ligada()) return { instancias: 0, mensagens: 0 };

  let instancias = 0;
  let mensagens = 0;

  const clientes = await app.api.center.list();

  for (const cliente of clientes) {
    const nome = cliente.instance;
    if (!nome) continue;

    try {
      const ids = await instanceContext.run(nome, () => app.api.recurrence.idsAtivos());
      instancias++;

      for (const id of ids) {
        // A instância viaja NA MENSAGEM porque o consumidor não tem
        // requisição de onde tirá-la. É o par (instância, recorrência) que
        // identifica a regra num banco só com todos os clientes dentro.
        const ok = await fila.publicar({ instancia: nome, recorrencia: id });
        if (ok) mensagens++;
      }
    } catch (erro) {
      // Um cliente com problema não pode calar os outros: a volta continua, e o
      // que faltou sai amanhã. O log diz qual foi.
      console.error(`[rotina] ${nome}:`, erro?.message || erro);
    }
  }

  return { instancias, mensagens };
}

// ── UMA VEZ POR DIA, mesmo com dois workers e duas máquinas ──────────────
//
// `SET NX PX` no Redis: quem grava primeiro é o dono do dia.
//
// Sem Redis a função devolve `null`, e aí a rotina SEGUE em vez de travar. A
// consequência é publicar duas vezes, e ela é inofensiva: o consumidor relê o
// estado e o índice único recusa a cobrança repetida. Travar por falta de Redis
// — que é opcional nesta instalação — seria trocar um problema que não existe
// por um que existe.
async function tentarHoje(app, hoje = new Date()) {
  const livre = await redis.marcarSeLivre(chaveDoDia(hoje), TRAVA_MS);
  if (livre === false) return null;

  const r = await publicarRecorrencias(app);
  console.log(`[rotina] recorrências publicadas: ${r.mensagens} (${r.instancias} cliente(s))`);
  return r;
}

// Liga o tique. Chamado SÓ no primário do cluster — um por worker publicaria N
// vezes o mesmo dia, e a trava do Redis existe para as outras máquinas, não para
// consertar isso aqui.
function ligar(app) {
  if (!fila.ligada()) {
    console.log("[rotina] sem AMQP_URL — a cobrança continua nascendo na leitura da tela");
    return null;
  }

  // A primeira volta não é imediata: o boot já tem o que fazer, e o primeiro
  // minuto de um processo novo é o pior momento para somar trabalho.
  const primeira = setTimeout(() => {
    tentarHoje(app).catch((erro) => console.error("[rotina]", erro?.message || erro));
  }, 60 * 1000);
  primeira.unref?.();

  const relogio = setInterval(() => {
    tentarHoje(app).catch((erro) => console.error("[rotina]", erro?.message || erro));
  }, INTERVALO_MS);

  // `unref` para o tique não segurar o processo de pé na hora de parar.
  relogio.unref?.();

  console.log("[rotina] tique diário ligado");
  return relogio;
}

module.exports = { ligar, tentarHoje, publicarRecorrencias, chaveDoDia, INTERVALO_MS, TRAVA_MS };
