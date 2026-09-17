const test = require("node:test");
const assert = require("node:assert/strict");

const fila = require("../../lib/fila.js");
const redis = require("../../lib/redis.js");
const rotina = require("../../lib/rotinaDiaria.js");
const instanceContext = require("../../lib/instance.js");

// O TIQUE DIÁRIO — quem coloca a recorrência na fila.
//
// *"todo dia enviar um cron para rabbit, com o id da recorrência e instancia"*.
//
// O que estes casos seguram é o que só aparece em produção: a mensagem carrega
// ID e não cópia do documento, cada cliente é lido DENTRO do contexto dele, um
// cliente quebrado não cala os outros, e a falta de Redis não trava o dia.

function montar({ clientes, porInstancia, publicar }) {
  const app = {
    api: {
      center: { async list() { return clientes; } },
      recurrence: {
        async idsAtivos() {
          // Lê a instância do CONTEXTO, como todo modelo deste backend faz.
          // É o que prova que a rotina entrou nele: fora do contexto, isto
          // estoura.
          const nome = instanceContext.required();
          const resposta = porInstancia[nome];
          if (typeof resposta === "function") return resposta();
          return resposta || [];
        },
      },
    },
  };

  const publicadas = [];
  const originalPublicar = fila.publicar;
  const originalLigada = fila.ligada;

  fila.ligada = () => true;
  fila.publicar = async (msg) => {
    publicadas.push(msg);
    return publicar === undefined ? true : publicar;
  };

  const restaurar = () => {
    fila.publicar = originalPublicar;
    fila.ligada = originalLigada;
  };

  return { app, publicadas, restaurar };
}

test("uma mensagem por recorrência, com o id dela e o da instância", async (t) => {
  const { app, publicadas, restaurar } = montar({
    clientes: [{ instance: "marlon" }, { instance: "bruna" }],
    porInstancia: { marlon: ["r1", "r2"], bruna: ["r9"] },
  });
  t.after(restaurar);

  const r = await rotina.publicarRecorrencias(app);

  assert.equal(r.instancias, 2);
  assert.equal(r.mensagens, 3);
  assert.deepEqual(publicadas, [
    { instancia: "marlon", recorrencia: "r1" },
    { instancia: "marlon", recorrencia: "r2" },
    { instancia: "bruna", recorrencia: "r9" },
  ]);
});

test("a mensagem NÃO leva o documento — entre publicar e consumir cabe uma edição", async (t) => {
  const { app, publicadas, restaurar } = montar({
    clientes: [{ instance: "marlon" }],
    porInstancia: { marlon: ["r1"] },
  });
  t.after(restaurar);

  await rotina.publicarRecorrencias(app);

  // Valor, vencimento e cadência ficam de fora de propósito: uma cópia geraria
  // a cobrança do preço velho se alguém editasse a regra no meio.
  assert.deepEqual(Object.keys(publicadas[0]).sort(), ["instancia", "recorrencia"]);
});

test("cada cliente é lido DENTRO do contexto dele", async (t) => {
  // É a peça que não existia. Todo modelo deste backend lê o cliente do
  // contexto assíncrono, e `connectToServer()` estoura fora dele de propósito.
  // Sem `ctx.run`, o `required()` do dobro estouraria e a rotina publicaria
  // zero — calada, porque o erro é engolido por cliente.
  const vistos = [];
  const { app, restaurar } = montar({
    clientes: [{ instance: "marlon" }, { instance: "will" }],
    porInstancia: {
      marlon: () => {
        vistos.push(instanceContext.required());
        return ["r1"];
      },
      will: () => {
        vistos.push(instanceContext.required());
        return [];
      },
    },
  });
  t.after(restaurar);

  await rotina.publicarRecorrencias(app);

  assert.deepEqual(vistos, ["marlon", "will"]);
});

test("um cliente com problema não cala os outros", async (t) => {
  const { app, publicadas, restaurar } = montar({
    clientes: [{ instance: "quebrado" }, { instance: "bom" }],
    porInstancia: {
      quebrado: () => {
        throw new Error("banco fora do ar");
      },
      bom: ["r1"],
    },
  });
  t.after(restaurar);

  const r = await rotina.publicarRecorrencias(app);

  assert.equal(r.mensagens, 1, "o que deu certo saiu");
  assert.deepEqual(publicadas, [{ instancia: "bom", recorrencia: "r1" }]);
});

test("cliente sem nome é pulado, e não vira mensagem para instância vazia", async (t) => {
  const { app, publicadas, restaurar } = montar({
    clientes: [{ instance: "" }, { instance: null }, { instance: "bom" }],
    porInstancia: { bom: ["r1"] },
  });
  t.after(restaurar);

  await rotina.publicarRecorrencias(app);
  assert.deepEqual(publicadas, [{ instancia: "bom", recorrencia: "r1" }]);
});

test("publicação recusada pelo broker não é contada como enviada", async (t) => {
  // O canal é de confirmação: `false` quer dizer que o broker NÃO gravou. Contar
  // como enviada faria o log dizer que o dia saiu quando não saiu.
  const { app, restaurar } = montar({
    clientes: [{ instance: "marlon" }],
    porInstancia: { marlon: ["r1", "r2"] },
    publicar: false,
  });
  t.after(restaurar);

  const r = await rotina.publicarRecorrencias(app);
  assert.equal(r.mensagens, 0);
});

test("sem AMQP_URL a rotina não publica nada — e isso não é falha", async (t) => {
  // A cobrança continua nascendo na leitura da tela. A fila é a garantia de
  // pontualidade, não o único caminho.
  const original = fila.ligada;
  fila.ligada = () => false;
  t.after(() => {
    fila.ligada = original;
  });

  const r = await rotina.publicarRecorrencias({});
  assert.deepEqual(r, { instancias: 0, mensagens: 0 });
});

test("a trava do dia impede a segunda máquina de publicar o mesmo dia", async (t) => {
  const original = redis.marcarSeLivre;
  redis.marcarSeLivre = async () => false;
  t.after(() => {
    redis.marcarSeLivre = original;
  });

  assert.equal(await rotina.tentarHoje({}), null, "quem perdeu a corrida não publica");
});

test("sem Redis a rotina SEGUE, em vez de travar", async (t) => {
  // Redis é opcional nesta instalação. Travar por falta dele trocaria um
  // problema que não existe (publicar duas vezes, que o índice único absorve)
  // por um que existe (não gerar nada).
  const original = redis.marcarSeLivre;
  redis.marcarSeLivre = async () => null;

  const { app, restaurar } = montar({
    clientes: [{ instance: "marlon" }],
    porInstancia: { marlon: ["r1"] },
  });
  t.after(() => {
    redis.marcarSeLivre = original;
    restaurar();
  });

  const r = await rotina.tentarHoje(app);
  assert.equal(r.mensagens, 1);
});

test("a trava é chaveada pelo DIA, e por isso não deriva", () => {
  // A primeira versão usava uma chave fixa com prazo de 23h. Ela derivava meia
  // hora por dia até cruzar a meia-noite — e aí um dia do calendário recebia
  // dois tiques e outro, nenhum. Este caso é o que impede a volta disso.
  const hoje = new Date("2026-09-17T03:00:00.000Z");
  const amanha = new Date("2026-09-18T02:00:00.000Z");

  assert.notEqual(rotina.chaveDoDia(hoje), rotina.chaveDoDia(amanha));
  assert.ok(rotina.chaveDoDia(hoje).endsWith("2026-09-17"));

  // A mesma data, em horas diferentes, é a MESMA chave — é o que faz 48 tiques
  // publicarem uma vez só.
  assert.equal(
    rotina.chaveDoDia(new Date("2026-09-17T03:00:00.000Z")),
    rotina.chaveDoDia(new Date("2026-09-17T23:59:00.000Z"))
  );

  // E o prazo passa do dia: a chave de hoje tem de estar viva no último tique
  // de hoje, senão ela mesma volta a permitir um segundo tique.
  assert.ok(rotina.TRAVA_MS > 24 * 60 * 60 * 1000);
});
