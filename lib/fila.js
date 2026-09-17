const amqp = require("amqplib");

// A FILA — RabbitMQ, para o trabalho que não pode depender de alguém abrir a
// tela.
//
// Nasceu da recorrência: *"todo dia enviar um cron para rabbit, com o id da
// recorrência e instancia, ai essa mensagem passaria pela funcao que verifica se
// deve gerar a cobrança ou não"*. É o desenho dele, e ele está certo no ponto
// que importa — a cobrança da mensalidade não pode existir só quando alguém
// lembra de abrir o financeiro.
//
// ── OPCIONAL POR CONSTRUÇÃO ──────────────────────────────────────────────
//
// Sem `AMQP_URL`, tudo aqui vira função que não faz nada e diz que não fez. Isso
// não é defensividade: a máquina de desenvolvimento não tem broker, os testes
// não sobem um, e a geração da cobrança CONTINUA acontecendo na leitura da tela
// — a fila é a garantia, não o único caminho.
//
// O dia em que o broker cair, o sistema perde a pontualidade e não perde
// dinheiro. Foi por isso que a geração preguiçosa ficou.
//
// ── A TOPOLOGIA É DECLARADA AQUI, e não criada à mão ─────────────────────
//
// `assertExchange`/`assertQueue` são idempotentes: rodar de novo não muda nada,
// e uma máquina nova se conserta sozinha no primeiro boot. Criar as filas por
// linha de comando faria a topologia existir só onde alguém lembrou de digitar.
//
// Convenção escolhida por mim, e é bom dizer: o Marlon pediu "igual fazemos no
// SprintHub", e a regra dele é não mexer em nada do SprintHub — então não fui
// olhar. Se divergir do que vocês usam lá, é aqui que se acerta.
//
//   vhost      vafit
//   exchange   vafit            direct, durável
//   fila       vafit.recorrencias        rota "recorrencias"
//   fila       vafit.mortas              para onde vai o que falhou
//
// ── A FILA DE MORTAS EXISTE PARA NÃO PERDER E NÃO GIRAR ──────────────────
//
// Mensagem que falha volta para a fila por padrão, e uma que falha SEMPRE — id
// que não existe mais, instância apagada — giraria para sempre consumindo CPU.
// Aqui ela é recusada sem reenfileirar e cai em `vafit.mortas`, onde fica
// parada, contável e legível. Um número crescendo ali é um defeito para olhar;
// um laço infinito é um defeito que esconde.
const EXCHANGE = "vafit";
const FILA_RECORRENCIAS = "vafit.recorrencias";
const ROTA_RECORRENCIAS = "recorrencias";
const EXCHANGE_MORTAS = "vafit.mortas";
const FILA_MORTAS = "vafit.mortas";

// Quantas mensagens um consumidor segura por vez.
//
// UMA. O trabalho de cada mensagem é uma conta e, quando há o que gerar, uma
// inserção — rápido, mas com ida ao banco. Sem prefetch, o RabbitMQ despeja a
// fila inteira num consumidor e os outros ficam ociosos; com 1, quem terminar
// pega a próxima, que é o balanceamento que se quer.
const PREFETCH = 1;

const ESPERA_PARA_RELIGAR_MS = 5000;

let conexao = null;
let canal = null;
let ligando = null;
let desistiu = false;

// ── O CONSUMIDOR PRECISA SER LEMBRADO PARA PODER VOLTAR ──────────────────
//
// Guardar a função é o que permite reassinar depois de o broker cair. Sem isto,
// a conexão se refazia e ninguém voltava a ouvir a fila: um
// `systemctl restart rabbitmq-server` deixava a geração parada até o próximo
// deploy do backend, calada.
//
// Achei reiniciando o broker depois de aumentar a máquina — `list_queues`
// mostrou `consumers 0` e nenhum erro em log nenhum. O comentário que estava
// aqui dizia que o consumidor tinha o próprio religar. Não tinha.
let aoReceberAtual = null;
let religarMarcado = false;

function ligada() {
  return Boolean(process.env.AMQP_URL);
}

function reclamar(erro) {
  console.error("[fila]", erro?.message || erro);
}

// ── A CONEXÃO É PREGUIÇOSA E SE REFAZ SOZINHA ────────────────────────────
//
// Preguiçosa porque nem todo processo publica ou consome, e abrir socket no boot
// para talvez nunca usar é conexão parada num broker com teto de memória.
//
// E ela se refaz porque o broker reinicia — num deploy, numa atualização de
// pacote. Sem religar, o primeiro `systemctl restart rabbitmq-server` deixaria a
// geração parada até o próximo deploy do backend, calada.
async function conectar() {
  if (!ligada() || desistiu) return null;
  if (canal) return canal;
  if (ligando) return ligando;

  ligando = (async () => {
    try {
      conexao = await amqp.connect(process.env.AMQP_URL);

      conexao.on("error", reclamar);
      conexao.on("close", () => {
        // Esquece o que morreu; a próxima chamada reabre. Quem PUBLICA não
        // precisa de mais que isso: o tique é diário e reabre na hora de
        // publicar. Quem CONSOME precisa ser reassinado — ver `religarConsumo`.
        conexao = null;
        canal = null;
        religarConsumo();
      });

      canal = await conexao.createConfirmChannel();
      canal.on("error", reclamar);
      canal.on("close", () => {
        canal = null;
        religarConsumo();
      });

      await canal.assertExchange(EXCHANGE, "direct", { durable: true });
      await canal.assertExchange(EXCHANGE_MORTAS, "direct", { durable: true });

      await canal.assertQueue(FILA_MORTAS, { durable: true });
      await canal.bindQueue(FILA_MORTAS, EXCHANGE_MORTAS, ROTA_RECORRENCIAS);

      await canal.assertQueue(FILA_RECORRENCIAS, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": EXCHANGE_MORTAS,
          "x-dead-letter-routing-key": ROTA_RECORRENCIAS,
        },
      });
      await canal.bindQueue(FILA_RECORRENCIAS, EXCHANGE, ROTA_RECORRENCIAS);

      return canal;
    } catch (erro) {
      reclamar(erro);
      conexao = null;
      canal = null;
      return null;
    } finally {
      ligando = null;
    }
  })();

  return ligando;
}

// Reassina a fila depois de a conexão cair.
//
// `religarMarcado` porque a queda dispara os DOIS eventos (o do canal e o da
// conexão) e os dois chamam aqui: sem a marca, um restart do broker criaria dois
// consumidores no mesmo processo, e cada mensagem seria processada em dobro.
// Não quebraria — o índice único absorve —, mas seria trabalho duplicado para
// sempre, dobrando a cada queda.
function religarConsumo() {
  if (!aoReceberAtual || desistiu || religarMarcado) return;

  religarMarcado = true;
  const t = setTimeout(() => {
    religarMarcado = false;
    consumir(aoReceberAtual).catch(reclamar);
  }, ESPERA_PARA_RELIGAR_MS);

  // `unref` para o religar não segurar o processo de pé na hora de parar.
  t.unref?.();
}

// Publica e ESPERA a confirmação do broker.
//
// Canal de confirmação (`createConfirmChannel`) e não o comum: sem ele,
// `publish` devolve true assim que o byte entra no socket, e uma queda entre o
// socket e o disco do broker some com a mensagem sem ninguém saber. Aqui o
// `true` quer dizer "o broker aceitou e gravou".
//
// `persistent` pelo mesmo motivo: mensagem não persistente morre no restart do
// broker, e o tique é diário — a próxima chance seria amanhã.
async function publicar(mensagem) {
  const c = await conectar();
  if (!c) return false;

  return new Promise((resolve) => {
    try {
      c.publish(
        EXCHANGE,
        ROTA_RECORRENCIAS,
        Buffer.from(JSON.stringify(mensagem)),
        { persistent: true, contentType: "application/json" },
        (erro) => {
          if (erro) reclamar(erro);
          resolve(!erro);
        }
      );
    } catch (erro) {
      reclamar(erro);
      resolve(false);
    }
  });
}

// ── CONSUMIR ─────────────────────────────────────────────────────────────
//
// `aoReceber` recebe o objeto já decodificado. Ele resolve → ack; ele estoura →
// a mensagem vai para `vafit.mortas` SEM voltar para a fila.
//
// Entrega é AT-LEAST-ONCE: um consumidor que insere e morre antes do ack recebe
// a mesma mensagem de novo. Isso aqui é seguro, e é bom saber POR QUE: o índice
// único em (recorrência, período) recusa a segunda inserção. Sem ele, esta linha
// seria uma máquina de cobrar a pessoa duas vezes pelo mesmo mês.
async function consumir(aoReceber) {
  if (!ligada()) return false;

  // Lembrado ANTES de conectar: se a conexão falhar agora, é esta referência que
  // o religar vai usar.
  aoReceberAtual = aoReceber;

  const c = await conectar();
  if (!c) {
    // Broker fora do ar no boot não pode impedir o servidor de subir: a tela
    // continua gerando na leitura. Tenta de novo daqui a pouco.
    religarConsumo();
    return false;
  }

  await c.prefetch(PREFETCH);

  await c.consume(FILA_RECORRENCIAS, async (msg) => {
    if (!msg) return;

    try {
      const corpo = JSON.parse(msg.content.toString());
      await aoReceber(corpo);
      c.ack(msg);
    } catch (erro) {
      reclamar(erro);
      // `false` no requeue: ver a nota da fila de mortas lá em cima.
      try {
        c.nack(msg, false, false);
      } catch (outro) {
        reclamar(outro);
      }
    }
  });

  console.log(`[fila] consumindo ${FILA_RECORRENCIAS}`);
  return true;
}

async function fechar() {
  desistiu = true;
  aoReceberAtual = null;
  try {
    if (canal) await canal.close();
    if (conexao) await conexao.close();
  } catch (erro) {
    // Fechar o que já caiu não é problema de ninguém.
  }
  canal = null;
  conexao = null;
}

module.exports = {
  ligada,
  publicar,
  consumir,
  conectar,
  fechar,
  EXCHANGE,
  FILA_RECORRENCIAS,
  FILA_MORTAS,
  ROTA_RECORRENCIAS,
  PREFETCH,
};
