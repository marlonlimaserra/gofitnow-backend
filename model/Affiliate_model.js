const instanceContext = require("../lib/instance.js");

// O PROGRAMA DE AFILIADO visto pelo profissional — o lado de dentro da conta.
//
// ── A ARMADILHA deste arquivo ─────────────────────────────────────────────
//
// Tudo aqui mora no CENTRAL (`centralDb()`), e não no banco do cliente
// (`connectToServer()`). Três collections, todas de lá:
//
//   instances    o código de afiliado, e quem indicou quem
//   settings     a porcentagem e o número de fatias
//   commissions  o que se deve
//
// Trocar `centralDb()` por `connectToServer()` aqui não daria erro: criaria
// collections vazias dentro do banco do cliente, e a tela mostraria zero para todo
// mundo. É o mesmo tropeço documentado em `UserCategory_model` — e a razão de o
// nome do banco estar escrito em cada função abaixo.
//
// ── Por que o app não grava nada disto ────────────────────────────────────
//
// Porque o programa é um acordo entre nós e o profissional: quanto ele ganha, quem
// ele trouxe e quanto já saiu são decisões e registros nossos. Aqui é LEITURA. A
// única coisa que o app precisa fazer é mostrar o código dele e a conta.
function Affiliate_model(app) {
  this.app = app;
}

Affiliate_model.prototype.instancesCollection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("instances");
};

Affiliate_model.prototype.settingsCollection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("settings");
};

Affiliate_model.prototype.commissionsCollection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("commissions");
};

// A REGRA do programa: ligado, porcentagem, quantas fatias.
Affiliate_model.prototype.regra = async function () {
  const col = await this.settingsCollection();
  const docs = await col
    .find({ key: { $in: ["affiliate.enabled", "affiliate.percent", "affiliate.slices"] } })
    .toArray();

  const valores = Object.fromEntries(docs.map((d) => [d.key, d.value]));

  return {
    // Ligado por omissão: toda conta nasce com código, e um programa desligado por
    // padrão faria os códigos existirem sem servir para nada.
    enabled: valores["affiliate.enabled"] !== false,
    percent: Number(valores["affiliate.percent"] || 0),
    slices: Number(valores["affiliate.slices"] || 0),
  };
};

// O PAINEL desta conta. Tudo o que a tela do profissional mostra.
Affiliate_model.prototype.painel = async function (instance) {
  const nome = instanceContext.normalize(instance || instanceContext.current());
  if (!nome) return undefined;

  const instances = await this.instancesCollection();
  const registro = await instances.findOne({ instance: nome });
  if (!registro) return undefined;

  const [regra, indicadas, comissoes] = await Promise.all([
    this.regra(),
    // Quem esta conta trouxe. Sem `email` de propósito: a lista serve para o
    // profissional saber quem ele indicou, não para prospectar os clientes dos
    // outros.
    instances
      .find(
        { indicadoPorInstance: nome },
        { projection: { instance: 1, name: 1, active: 1, indicadoEm: 1 } }
      )
      .sort({ indicadoEm: -1 })
      .toArray(),
    this.comissoes(nome),
  ]);

  return {
    alias: registro.alias || "",
    // Quem indicou ESTA conta. O profissional pode ver de quem ele veio — é ele
    // que decidiu digitar aquele código.
    indicadoPor: registro.indicadoPor || null,
    programa: regra,
    // Só o que ele precisa saber de cada indicado: quem é e se ainda está ativo.
    // Cliente desligado continua na lista porque é ele que explica por que a
    // comissão parou.
    indicadas: indicadas.map((i) => ({
      name: i.name || i.instance,
      active: i.active !== false,
      desde: i.indicadoEm || null,
    })),
    comissoes,
  };
};

// O DINHEIRO desta conta, somado pelo banco.
//
// Por `afiliado.instance` e não por `afiliado.alias`: o alias pode ter sido trocado
// no painel, e as comissões antigas ficaram gravadas com o antigo. A instância nunca
// muda — é o nome do banco.
Affiliate_model.prototype.comissoes = async function (instance) {
  const nome = instanceContext.normalize(instance || instanceContext.current());
  if (!nome) return { aPagarCents: 0, pagoCents: 0, quantas: 0 };

  const col = await this.commissionsCollection();

  const linhas = await col
    .aggregate([
      { $match: { "afiliado.instance": nome } },
      { $group: { _id: "$status", cents: { $sum: "$valorCents" }, n: { $sum: 1 } } },
    ])
    .toArray();

  const porStatus = Object.fromEntries(linhas.map((l) => [l._id, { cents: l.cents, n: l.n }]));

  return {
    aPagarCents: porStatus.a_pagar?.cents || 0,
    pagoCents: porStatus.pago?.cents || 0,
    // Cancelada NÃO entra na contagem que o profissional vê: para ele são
    // comissões que não existem, e mostrá-las abriria uma conversa sobre cada uma.
    quantas: (porStatus.a_pagar?.n || 0) + (porStatus.pago?.n || 0),
  };
};

module.exports = Affiliate_model;
