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
