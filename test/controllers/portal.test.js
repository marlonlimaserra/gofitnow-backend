const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const PortalController = require("../../controllers/Portal.js");
const rateLimit = require("../../lib/rateLimit.js");

// O que esta rota tem de fazer, e o que ela NÃO pode fazer.
//
// Ela é a única rota do sistema que responde "de qual cliente é esta pessoa"
// sem sessão nenhuma. Então metade dos testes aqui é sobre a função e a outra
// metade é sobre o vazamento: a instância não pode sair na resposta, e enumerar
// e-mails tem de ficar caro.
function monta(destinos = []) {
  return fakeApp({
    api: {
      portal: {
        chamadas: [],
        async destinosParaEmail(email) {
          this.chamadas.push(email);
          if (destinos instanceof Error) throw destinos;
          return destinos;
        },
      },
    },
  });
}

test.beforeEach(() => rateLimit.reset());

test("acha o cliente pelo e-mail e devolve o endereço", async () => {
  const app = monta([{ host: "bruna.gofitnow.fit", name: "Bruna" }]);
  PortalController(app);

  const r = await call(app, "post", "/public/portal/lookup", {
    body: { email: "brunasampaio1611@gmail.com" },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.deepEqual(r.body.destinations, [{ host: "bruna.gofitnow.fit", name: "Bruna" }]);
});

// A resposta leva HOST, não instância. É a mesma decisão do /public/theme, que
// recusa dizer de quem é um endereço: o nome da instância é identificador
// interno, e numa rota aberta ele viraria o mapa "quem é cliente de quem".
test("a resposta não contém o nome da instância", async () => {
  const app = monta([{ host: "marlon.gofitnow.fit", name: "Marlon" }]);
  PortalController(app);

  const r = await call(app, "post", "/public/portal/lookup", {
    body: { email: "marlon@sprinthub.com" },
  });

  assert.ok(!JSON.stringify(r.body).includes("instance"));
});

// 200 e não 404: a requisição foi respondida, e a tela precisa desenhar a
// própria mensagem. Com 404 ela teria de separar este caso de "rota não existe".
test("e-mail que não é de ninguém responde 200 com found falso", async () => {
  const app = monta([]);
  PortalController(app);

  const r = await call(app, "post", "/public/portal/lookup", {
    body: { email: "ninguem@exemplo.com" },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.found, false);
  assert.deepEqual(r.body.destinations, []);
});

// A mesma pessoa pode ser aluna de uma academia E paciente de uma clínica. Se a
// rota devolvesse só a primeira, o segundo cliente ficaria inalcançável pelo
// portal sem ninguém perceber.
test("e-mail em dois clientes devolve os dois", async () => {
  const app = monta([
    { host: "marlon.gofitnow.fit", name: "Marlon" },
    { host: "bruna.gofitnow.fit", name: "Bruna" },
  ]);
  PortalController(app);

  const r = await call(app, "post", "/public/portal/lookup", {
    body: { email: "pessoa@exemplo.com" },
  });

  assert.equal(r.body.destinations.length, 2);
});

test("e-mail em branco é 400", async () => {
  const app = monta([]);
  PortalController(app);

  const r = await call(app, "post", "/public/portal/lookup", { body: { email: "  " } });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "missing_email");
});

// Formato inválido NÃO ganha resposta própria. Se "abc" respondesse diferente de
// um e-mail bem formado que não existe, quem enumera separaria os dois casos.
test("e-mail malformado responde como não encontrado, e não como erro", async () => {
  const app = monta([]);
  PortalController(app);

  const r = await call(app, "post", "/public/portal/lookup", { body: { email: "abc" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.found, false);
});

// O limite é a metade do trabalho desta rota. Sem ele, ela é uma máquina de
// descobrir quem usa o sistema e de qual clínica — que é dado de saúde.
test("passa de 10 tentativas por minuto e vira 429 com Retry-After", async () => {
  const app = monta([]);
  PortalController(app);

  for (let i = 0; i < 10; i++) {
    const ok = await call(app, "post", "/public/portal/lookup", {
      body: { email: `p${i}@exemplo.com` },
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    assert.equal(ok.status, 200, `a ${i + 1}ª devia passar`);
  }

  const barrado = await call(app, "post", "/public/portal/lookup", {
    body: { email: "p11@exemplo.com" },
    headers: { "x-forwarded-for": "9.9.9.9" },
  });

  assert.equal(barrado.status, 429);
  assert.equal(barrado.body.code, "too_many_requests");
  assert.ok(Number(barrado.headers["retry-after"]) > 0);
});

// O limite é POR IP. Um só contador global faria dez pessoas entrando ao mesmo
// tempo trancarem a porta uma da outra.
test("o limite de um IP não afeta outro", async () => {
  const app = monta([]);
  PortalController(app);

  for (let i = 0; i < 10; i++) {
    await call(app, "post", "/public/portal/lookup", {
      body: { email: `a${i}@exemplo.com` },
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
  }

  const outro = await call(app, "post", "/public/portal/lookup", {
    body: { email: "outro@exemplo.com" },
    headers: { "x-forwarded-for": "2.2.2.2" },
  });

  assert.equal(outro.status, 200);
});

// Banco fora do ar não pode virar "seu e-mail não existe": a pessoa passaria a
// tarde tentando cadastrar uma conta que já tem.
test("falha na busca é 503, e não found falso", async () => {
  const app = monta(new Error("mongo caiu"));
  PortalController(app);

  const r = await call(app, "post", "/public/portal/lookup", {
    body: { email: "alguem@exemplo.com" },
  });

  assert.equal(r.status, 503);
  assert.equal(r.body.code, "lookup_failed");
});
