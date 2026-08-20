const test = require("node:test");
const assert = require("node:assert/strict");

const Affiliate_model = require("../../model/Affiliate_model.js");
const AffiliateController = require("../../controllers/Affiliate.js");
const { fakeApp, call } = require("../helpers/harness.js");
const instanceContext = require("../../lib/instance.js");

// O programa de afiliado visto pelo profissional.
//
// A armadilha que estes testes guardam é a do BANCO: tudo aqui mora no central, e
// ler o banco do cliente por engano não daria erro — criaria collections vazias e a
// tela mostraria zero para todo mundo.
function monta({ instances = [], settings = [], commissions = [] } = {}) {
  const abertos = [];

  const cols = {
    instances: colecao(instances),
    settings: colecao(settings),
    commissions: colecao(commissions),
  };

  const app = {
    mongodb: {
      async centralDb() {
        abertos.push("central");
        return { collection: (nome) => cols[nome] };
      },
      // Se alguém trocar `centralDb` por este, o teste acusa em vez de passar com
      // uma collection vazia.
      async connectToServer() {
        abertos.push("cliente");
        return { collection: () => colecao([]) };
      },
    },
  };

  return { model: new Affiliate_model(app), abertos };
}

function colecao(docs) {
  return {
    docs,
    async findOne(query) {
      return docs.find((d) => casa(d, query));
    },
    find(query) {
      const achados = docs.filter((d) => casa(d, query));
      return {
        sort: () => ({ toArray: async () => achados }),
        toArray: async () => achados,
      };
    },
    aggregate(etapas) {
      const match = etapas.find((e) => e.$match)?.$match || {};
      const achados = docs.filter((d) => casa(d, match));
      const grupos = new Map();

      for (const d of achados) {
        const atual = grupos.get(d.status) || { _id: d.status, cents: 0, n: 0 };
        atual.cents += d.valorCents || 0;
        atual.n += 1;
        grupos.set(d.status, atual);
      }

      return { toArray: async () => [...grupos.values()] };
    },
  };
}

function casa(doc, query) {
  return Object.entries(query).every(([chave, valor]) => {
    if (valor && typeof valor === "object" && "$in" in valor) return valor.$in.includes(doc[chave]);
    // Caminho com ponto: "afiliado.instance".
    const lido = chave.split(".").reduce((o, parte) => (o == null ? o : o[parte]), doc);
    return lido === valor;
  });
}

test("o painel lê o CENTRAL, e nunca o banco do cliente", async () => {
  // Este é o teste mais importante do arquivo. `connectToServer()` aqui não
  // estouraria: criaria `instances` vazia dentro de `gofitnow_will` e a tela diria
  // "nenhum indicado" para quem tem dez.
  const { model, abertos } = monta({ instances: [{ instance: "will", alias: "wil" }] });

  await model.painel("will");

  assert.ok(abertos.length > 0, "não abriu banco nenhum");
  assert.ok(!abertos.includes("cliente"), "abriu o banco do cliente");
  assert.deepEqual([...new Set(abertos)], ["central"]);
});

test("o painel traz o código, a regra e quem foi indicado", async () => {
  const { model } = monta({
    instances: [
      { instance: "will", alias: "wil" },
      { instance: "nova", name: "Clínica Nova", indicadoPorInstance: "will", active: true },
      { instance: "velha", name: "Antiga", indicadoPorInstance: "will", active: false },
      { instance: "outra", name: "De outro", indicadoPorInstance: "bruna" },
    ],
    settings: [
      { key: "affiliate.percent", value: 20 },
      { key: "affiliate.slices", value: 3 },
    ],
  });

  const p = await model.painel("will");

  assert.equal(p.alias, "wil");
  assert.equal(p.programa.percent, 20);
  assert.equal(p.programa.slices, 3);
  assert.equal(p.indicadas.length, 2, "trouxe indicado de outro afiliado");
  // O desligado continua na lista: é ele que explica por que a comissão parou.
  assert.equal(p.indicadas.find((i) => i.name === "Antiga").active, false);
});

test("a lista de indicados não devolve e-mail nem nome de banco", async () => {
  // Ela serve para o profissional saber quem ele trouxe — não para prospectar os
  // clientes dos outros, e não para descobrir o nome do banco de ninguém.
  const { model } = monta({
    instances: [
      { instance: "will", alias: "wil" },
      { instance: "nova", name: "Clínica Nova", email: "dono@nova.com", indicadoPorInstance: "will" },
    ],
  });

  const p = await model.painel("will");

  // Os campos são declarados um por um, e o teste confere a LISTA de campos: assim
  // um `...i` escrito com pressa lá dentro quebra aqui, em vez de vazar calado.
  assert.deepEqual(Object.keys(p.indicadas[0]).sort(), ["active", "desde", "name"]);
});

test("o dinheiro é somado por INSTÂNCIA, não pelo alias", async () => {
  // O alias pode ter sido trocado no painel, e as comissões antigas ficaram com o
  // antigo. Somar por alias deixaria o profissional vendo menos do que se deve a
  // ele — e ninguém acusa uma soma pequena.
  const { model } = monta({
    instances: [{ instance: "will", alias: "novo-codigo" }],
    commissions: [
      { afiliado: { alias: "codigo-antigo", instance: "will" }, status: "a_pagar", valorCents: 3000 },
      { afiliado: { alias: "novo-codigo", instance: "will" }, status: "a_pagar", valorCents: 2000 },
      { afiliado: { alias: "novo-codigo", instance: "will" }, status: "pago", valorCents: 5000 },
      { afiliado: { alias: "bru", instance: "bruna" }, status: "a_pagar", valorCents: 9999 },
    ],
  });

  const p = await model.painel("will");

  assert.equal(p.comissoes.aPagarCents, 5000, "não somou a comissão do alias antigo");
  assert.equal(p.comissoes.pagoCents, 5000);
});

test("comissão cancelada não aparece para o profissional", async () => {
  // Para ele são comissões que não existem. Mostrá-las abriria uma conversa sobre
  // cada uma, e a decisão de cancelar já foi tomada e registrada com motivo.
  const { model } = monta({
    instances: [{ instance: "will", alias: "wil" }],
    commissions: [
      { afiliado: { instance: "will" }, status: "a_pagar", valorCents: 1000 },
      { afiliado: { instance: "will" }, status: "cancelada", valorCents: 7777 },
    ],
  });

  const p = await model.painel("will");

  assert.equal(p.comissoes.aPagarCents, 1000);
  assert.equal(p.comissoes.quantas, 1);
  assert.ok(!JSON.stringify(p.comissoes).includes("7777"), "somou uma cancelada");
});

test("o programa nasce LIGADO quando ninguém configurou nada", async () => {
  // Toda conta nasce com código de afiliado. Um programa desligado por omissão faria
  // os códigos existirem sem servir para nada, e ninguém saberia por quê.
  const { model } = monta({ instances: [{ instance: "will", alias: "wil" }] });
  const p = await model.painel("will");

  assert.equal(p.programa.enabled, true);
  assert.equal(p.programa.percent, 0);
});

test("desligado explicitamente fica desligado", async () => {
  const { model } = monta({
    instances: [{ instance: "will", alias: "wil" }],
    settings: [{ key: "affiliate.enabled", value: false }],
  });

  assert.equal((await model.painel("will")).programa.enabled, false);
});

test("conta que não está no central devolve nada — e a rota mostra o esqueleto", async () => {
  // É o caso do desenvolvimento local e de um cliente criado à mão. A tela abre
  // dizendo que ainda não há código, o que é melhor que uma tela de erro sobre algo
  // que a pessoa não pode resolver.
  const { model } = monta({ instances: [] });
  assert.equal(await model.painel("fantasma"), undefined);

  const app = fakeApp({
    api: {
      affiliate: {
        async painel() {
          return undefined;
        },
        async regra() {
          return { enabled: true, percent: 20, slices: 3 };
        },
      },
    },
    helpers: { ReqProtected: { async can() { return { _id: "u1" }; } } },
  });
  AffiliateController(app);

  const r = await call(app, "get", "/me/affiliate");
  assert.equal(r.status, 200);
  assert.equal(r.body.alias, "");
  assert.equal(r.body.programa.percent, 20);
  assert.deepEqual(r.body.indicadas, []);
});

test("a rota pede users.manage — não é para quem só atende", async () => {
  // Isto é dinheiro da CONTA. Uma secretária com acesso à agenda não precisa saber
  // quanto o dono ganha de indicação.
  const pedidas = [];
  const app = fakeApp({
    api: { affiliate: { async painel() { return { alias: "wil" }; } } },
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidas.push(permissao);
          return { _id: "u1" };
        },
      },
    },
  });
  AffiliateController(app);

  await call(app, "get", "/me/affiliate");
  assert.deepEqual(pedidas, ["users.manage"]);
});

test("sem permissão, nada volta", async () => {
  let leu = false;
  const app = fakeApp({
    api: {
      affiliate: {
        async painel() {
          leu = true;
          return { alias: "wil" };
        },
      },
    },
    helpers: {
      ReqProtected: {
        async can(req, res) {
          res.status(403).send({ msg: "forbidden" });
          return false;
        },
      },
    },
  });
  AffiliateController(app);

  const r = await call(app, "get", "/me/affiliate");
  assert.equal(r.status, 403);
  assert.equal(leu, false, "leu o painel mesmo sem permissão");
});

test("sem instância no contexto, o painel não inventa uma", async () => {
  // `painel()` sem argumento usa a instância da requisição. Fora de uma
  // requisição não há nenhuma — e cair no padrão leria a conta de outro cliente.
  const { model } = monta({ instances: [{ instance: "will", alias: "wil" }] });

  await instanceContext.run("will", async () => {
    assert.equal((await model.painel()).alias, "wil");
  });
});
