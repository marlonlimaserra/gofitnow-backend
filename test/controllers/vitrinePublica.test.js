const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const MembershipController = require("../../controllers/Membership.js");

// A VITRINE PÚBLICA — a rota que o site do cliente embute num iframe.
//
// Ela é a única desta casa que responde sem sessão e para quem não é nosso
// usuário, e por isso o que ela NÃO manda importa tanto quanto o que manda.

const PLANOS = [
  {
    _id: "m1",
    name: "Black",
    tagline: "Treine em qualquer lugar",
    description: "Todas as unidades.",
    amount: 15990,
    currency: "BRL",
    cadencia: "monthly",
    fidelidadeMeses: 12,
    destaque: true,
    beneficios: ["b1", "b2", "b3", "b4", "b5", "b6"],
    corFundo: "#dc2626",
    corTexto: "#ffffff",
    botaoTexto: "Matricule-se",
    botaoIconeSvg: "<path/>",
    // Campos que NÃO podem sair daqui.
    createdBy: "u1",
    order: 0,
    rascunho: false,
  },
];

const BENEFICIOS = Array.from({ length: 6 }, (_, i) => ({
  _id: "b" + (i + 1),
  name: "Benefício " + (i + 1),
  active: true,
}));

function monta({ planos = PLANOS, beneficios = BENEFICIOS } = {}) {
  const app = fakeApp({
    api: {
      center: {
        async byHost() {
          return { instance: "marlon", active: true };
        },
      },
      membership: {
        async listActive() {
          return planos;
        },
      },
      membershipBenefit: {
        async listActive() {
          return beneficios;
        },
      },
      // A vitrine passou a oferecer a escolha da unidade, então ela pergunta
      // por elas também — ver os casos no fim do arquivo.
      unit: {
        async listActive() {
          return [];
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL" };
        },
      },
      membershipImage: {},
    },
    helpers: { ReqProtected: { async can() { return { _id: "u1" }; } } },
  });

  MembershipController(app);
  return app;
}

const pedir = () => call(monta(), "get", "/public/memberships", { query: { host: "x.vafit.app" } });

test("TODOS os benefícios ativos saem — não há corte", async () => {
  // *"parece que só aparece 3 benefícios, mesmo eu tendo colocado mais"*. Os
  // seis estavam no banco e seis saíam daqui; o que a tela mostrava era a
  // resposta guardada de um minuto antes. Este caso é o que prova de que lado
  // o defeito NÃO estava.
  const r = await pedir();

  assert.equal(r.body.beneficios.length, 6);
  assert.equal(r.body.planos[0].beneficios.length, 6);
});

test("a resposta é REVALIDADA, nunca servida velha", async () => {
  // Era `max-age=60`. Um minuto é pouco em teoria e é tudo na prática: o fluxo
  // é editar no painel e olhar a vitrine em seguida, e nessa janela ela mente.
  // Quem editou não desconfia do cache — desconfia do que acabou de salvar.
  const r = await pedir();

  assert.match(r.headers["cache-control"], /max-age=0/);
  assert.match(r.headers["cache-control"], /must-revalidate/);
});

test("o benefício que um plano marcou mas que saiu do ar não vaza", async () => {
  // Desativar uma linha tira ela da tabela E do cartão: deixá-la faria o
  // cartão prometer algo que a comparação nem lista.
  const app = monta({ beneficios: BENEFICIOS.slice(0, 2) });
  const r = await call(app, "get", "/public/memberships", { query: { host: "x.vafit.app" } });

  assert.deepEqual(r.body.planos[0].beneficios, ["b1", "b2"]);
});

test("só os campos do CARTÃO — o documento inteiro não sai", async () => {
  // Montado à mão, e não `...plano`: uma vitrine que devolve o documento
  // inteiro vaza o próximo campo que alguém acrescentar sem pensar nisto.
  const r = await pedir();
  const plano = r.body.planos[0];

  for (const proibido of ["createdBy", "order", "rascunho", "_id", "cover"]) {
    assert.ok(!(proibido in plano), `vazou ${proibido}`);
  }
  assert.equal(plano.id, "m1");
});

test("as cores e o botão vão junto, porque é deles que o cartão se pinta", async () => {
  const r = await pedir();
  const plano = r.body.planos[0];

  assert.equal(plano.corFundo, "#dc2626");
  assert.equal(plano.botaoTexto, "Matricule-se");
  // Mesmo SEM link: o cartão sem botão é um cartão incompleto, e quem ainda
  // não pôs o link vê o botão e entende o que falta.
  assert.equal(plano.botaoLink, "");
  assert.equal(plano.botaoIconeSvg, "<path/>");
});

test("host desconhecido é 404 seco, sem mensagem traduzida", async () => {
  // Aqui não há sessão nem idioma, e ninguém lê mensagem dentro de um iframe
  // no site de outra pessoa.
  const app = fakeApp({
    api: { center: { async byHost() { return null; } } },
    helpers: { ReqProtected: { async can() { return { _id: "u1" }; } } },
  });
  MembershipController(app);

  const r = await call(app, "get", "/public/memberships", { query: { host: "ninguem.com" } });
  assert.equal(r.status, 404);
});

// ── A VITRINE POR UNIDADE ───────────────────────────────────────────────
//
// *"também posso escolher em qual unidade o plano vai estar disponível... na
// vitrine pública teria que ter um jeito de eu escolher a unidade, pois cada
// unidade pode ter planos e preços diferentes"*.
//
// A regra que atravessa tudo: **plano sem unidade vale em TODAS**. É o que
// mantém no ar cada plano cadastrado antes desta mudança — nenhum deles pode
// sumir da vitrine porque alguém cadastrou uma unidade.
const UNIDADES = [
  { _id: "un1", name: "Centro", active: true },
  { _id: "un2", name: "Paraty", active: true },
];

function comUnidades({ planos, unidades = UNIDADES } = {}) {
  const app = fakeApp({
    api: {
      center: { async byHost() { return { instance: "marlon", active: true }; } },
      membership: { async listActive() { return planos; } },
      membershipBenefit: { async listActive() { return BENEFICIOS; } },
      unit: { async listActive() { return unidades; } },
      tenant: { async currencyOfInstance() { return { currency: "BRL" }; } },
    },
    helpers: { ReqProtected: { async can() { return { _id: "u1" }; } } },
  });

  MembershipController(app);
  return app;
}

const PLANO_CENTRO = { ...PLANOS[0], _id: "m1", name: "Centro 100", units: ["un1"] };
const PLANO_PARATY = { ...PLANOS[0], _id: "m2", name: "Paraty 70", units: ["un2"] };
const PLANO_TODAS = { ...PLANOS[0], _id: "m3", name: "Vale em todas", units: [] };

const pedirUnidade = (app, unidade) =>
  call(app, "get", "/public/memberships", { query: { host: "x.vafit.app", unidade } });

test("sem escolher unidade, a vitrine mostra tudo", async () => {
  const app = comUnidades({ planos: [PLANO_CENTRO, PLANO_PARATY, PLANO_TODAS] });
  const r = await pedirUnidade(app);

  assert.equal(r.body.planos.length, 3);
});

test("escolhendo Paraty, só os planos de Paraty", async () => {
  const app = comUnidades({ planos: [PLANO_CENTRO, PLANO_PARATY, PLANO_TODAS] });
  const r = await pedirUnidade(app, "un2");

  assert.deepEqual(
    r.body.planos.map((p) => p.name).sort(),
    ["Paraty 70", "Vale em todas"]
  );
});

test("plano SEM unidade vale em todas — é o que mantém o cadastro antigo no ar", async () => {
  // Nenhum plano de hoje tem a lista preenchida. Se "sem unidade" quisesse
  // dizer "nenhuma", a vitrine de todo mundo esvaziaria no dia em que alguém
  // cadastrasse a primeira unidade.
  const app = comUnidades({ planos: [PLANO_TODAS] });

  assert.equal((await pedirUnidade(app, "un1")).body.planos.length, 1);
  assert.equal((await pedirUnidade(app, "un2")).body.planos.length, 1);
});

test("a vitrine devolve as unidades para o seletor", async () => {
  const app = comUnidades({ planos: [PLANO_CENTRO, PLANO_PARATY] });
  const r = await pedirUnidade(app);

  assert.deepEqual(r.body.unidades, [
    { id: "un1", name: "Centro" },
    { id: "un2", name: "Paraty" },
  ]);
});

test("unidade SEM plano nenhum não entra no seletor", async () => {
  // Uma opção que leva a uma página vazia é pior que opção nenhuma — e quem
  // abre a vitrine é um cliente em potencial, não alguém disposto a
  // investigar.
  const app = comUnidades({ planos: [PLANO_CENTRO] });
  const r = await pedirUnidade(app);

  assert.deepEqual(r.body.unidades, [{ id: "un1", name: "Centro" }]);
});

test("do seletor saem só id e nome — nada de telefone nem endereço", async () => {
  // Esta rota responde sem sessão para qualquer um. Ela devolve o que o CARTÃO
  // desenha, e nada além.
  const app = comUnidades({
    planos: [PLANO_TODAS],
    unidades: [{ ...UNIDADES[0], phone: "(21) 99999-0000", endereco: "Rua X", email: "a@b.c" }],
  });
  const r = await pedirUnidade(app);

  assert.deepEqual(Object.keys(r.body.unidades[0]).sort(), ["id", "name"]);
});
