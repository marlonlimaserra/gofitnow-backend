const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// O CONSUMIDOR TEM DE VOLTAR depois de o broker cair.
//
// Achado na mão: reiniciei o RabbitMQ depois de aumentar a máquina e
// `list_queues` mostrou `consumers 0`. Nenhum erro em log nenhum — a conexão se
// refazia e ninguém reassinava a fila. Um `systemctl restart rabbitmq-server`
// deixaria a geração da mensalidade parada até o próximo deploy do backend.
//
// O dobro do `amqplib` é montado à mão porque o que se quer exercitar é
// exatamente o que um broker de verdade faria: fechar a conexão embaixo de nós.

function dobrarAmqp() {
  const conexoes = [];

  const fabricarCanal = () => {
    const ouvintes = {};
    return {
      consumidores: 0,
      on(evento, fn) {
        ouvintes[evento] = fn;
      },
      disparar(evento) {
        ouvintes[evento]?.();
      },
      async assertExchange() {},
      async assertQueue() {},
      async bindQueue() {},
      async prefetch() {},
      async consume() {
        this.consumidores++;
      },
      async close() {},
    };
  };

  const conectar = async () => {
    const ouvintes = {};
    const canal = fabricarCanal();
    const c = {
      canal,
      on(evento, fn) {
        ouvintes[evento] = fn;
      },
      disparar(evento) {
        ouvintes[evento]?.();
      },
      async createConfirmChannel() {
        return canal;
      },
      async close() {},
    };
    conexoes.push(c);
    return c;
  };

  const original = Module.prototype.require;
  Module.prototype.require = function (nome) {
    if (nome === "amqplib") return { connect: conectar };
    return original.apply(this, arguments);
  };

  return {
    conexoes,
    restaurar() {
      Module.prototype.require = original;
    },
  };
}

// `fila.js` guarda estado de módulo, então cada caso precisa de uma cópia limpa.
function carregarFila(dobro) {
  delete require.cache[require.resolve("../../lib/fila.js")];
  return require("../../lib/fila.js");
}

// O religar é temporizado. Em vez de esperar 5 segundos de verdade, o teste
// adianta o relógio — `setTimeout` é trocado por execução imediata.
function adiantarRelogio() {
  const original = global.setTimeout;
  const pendentes = [];

  global.setTimeout = (fn) => {
    pendentes.push(fn);
    return { unref() {} };
  };

  return {
    async correr() {
      const lista = pendentes.splice(0);
      for (const fn of lista) await fn();
      // O callback do religar não DEVOLVE a promessa (setTimeout ignoraria), e
      // `consumir` é assíncrono: sem drenar a fila de microtarefas, o teste
      // afirmaria sobre um trabalho que ainda está no meio. Foi o que ele fez na
      // primeira versão — viu a reconexão e não viu a assinatura.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
    quantos: () => pendentes.length,
    restaurar() {
      global.setTimeout = original;
    },
  };
}

test("o consumidor volta depois de a conexão cair", async (t) => {
  process.env.AMQP_URL = "amqp://teste";
  const dobro = dobrarAmqp();
  const relogio = adiantarRelogio();
  const fila = carregarFila(dobro);

  t.after(() => {
    relogio.restaurar();
    dobro.restaurar();
    delete process.env.AMQP_URL;
    delete require.cache[require.resolve("../../lib/fila.js")];
  });

  const recebidas = [];
  await fila.consumir(async (m) => recebidas.push(m));

  assert.equal(dobro.conexoes.length, 1);
  assert.equal(dobro.conexoes[0].canal.consumidores, 1, "assinou na primeira vez");

  // O broker reinicia.
  dobro.conexoes[0].disparar("close");

  await relogio.correr();

  assert.equal(dobro.conexoes.length, 2, "reconectou");
  assert.equal(dobro.conexoes[1].canal.consumidores, 1, "e reassinou a fila");
});

test("uma queda NÃO cria dois consumidores no mesmo processo", async (t) => {
  // A queda dispara o evento do canal E o da conexão, e os dois chamam o
  // religar. Sem a trava, cada restart do broker dobraria o número de
  // consumidores — trabalho duplicado para sempre, e dobrando a cada queda.
  process.env.AMQP_URL = "amqp://teste";
  const dobro = dobrarAmqp();
  const relogio = adiantarRelogio();
  const fila = carregarFila(dobro);

  t.after(() => {
    relogio.restaurar();
    dobro.restaurar();
    delete process.env.AMQP_URL;
    delete require.cache[require.resolve("../../lib/fila.js")];
  });

  await fila.consumir(async () => {});

  dobro.conexoes[0].canal.disparar("close");
  dobro.conexoes[0].disparar("close");

  await relogio.correr();

  assert.equal(dobro.conexoes.length, 2, "uma reconexão, não duas");
});

test("quem nunca consumiu não ganha consumidor ao reconectar", async (t) => {
  // O primário só publica. Se a queda o fizesse virar consumidor, o tique
  // diário passaria a processar a própria fila.
  process.env.AMQP_URL = "amqp://teste";
  const dobro = dobrarAmqp();
  const relogio = adiantarRelogio();
  const fila = carregarFila(dobro);

  t.after(() => {
    relogio.restaurar();
    dobro.restaurar();
    delete process.env.AMQP_URL;
    delete require.cache[require.resolve("../../lib/fila.js")];
  });

  await fila.publicar({ instancia: "marlon", recorrencia: "r1" }).catch(() => {});
  dobro.conexoes[0].disparar("close");

  await relogio.correr();
  assert.equal(dobro.conexoes.length, 1, "não reabriu por conta própria");
});

test("sem AMQP_URL não se consome nada, e isso não é falha", async (t) => {
  delete process.env.AMQP_URL;
  const dobro = dobrarAmqp();
  const fila = carregarFila(dobro);

  t.after(() => {
    dobro.restaurar();
    delete require.cache[require.resolve("../../lib/fila.js")];
  });

  assert.equal(await fila.consumir(async () => {}), false);
  assert.equal(dobro.conexoes.length, 0);
});
