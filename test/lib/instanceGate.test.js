const test = require("node:test");
const assert = require("node:assert/strict");

const instanceGate = require("../../lib/instanceGate.js");

// O portão da instância.
//
// É o que separa "pediu uma instância" de "essa instância é de alguém". Antes
// dele, `bruna.gofitnow.fit` — um subdomínio apontado para nós e nunca cadastrado
// — resolvia a instância "bruna" e abria o banco `gofitnow_bruna`, que o Mongo
// cria na primeira escrita. Passava a existir um cliente que ninguém cadastrou.
//
// Testa o middleware DE VERDADE, o mesmo que o app.js monta. Reescrever a lógica
// aqui testaria a cópia, e é assim que um portão passa a existir só no teste.

function monta({ registradas = ["marlon"], hosts = {}, quebra = false } = {}) {
  const consultas = [];

  const app = {
    api: {
      center: {
        async isActive(instance) {
          consultas.push({ o_que: "isActive", instance });
          if (quebra) throw new Error("central fora do ar");
          return registradas.includes(instance);
        },
        async instanceForHost(host) {
          consultas.push({ o_que: "instanceForHost", host });
          if (quebra) throw new Error("central fora do ar");
          return hosts[host] || "";
        },
      },
    },
  };

  return { gate: instanceGate(app), consultas };
}

// Um req/res de mentira com a superfície que o middleware usa.
function chama(gate, { path = "/me", headers = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      path,
      headers,
      query,
      t: (chave) => chave, // o texto traduzido é testado no i18n
    };

    const res = {
      statusCode: 200,
      status(n) {
        this.statusCode = n;
        return this;
      },
      send(corpo) {
        resolve({ status: this.statusCode, body: corpo, passou: false, req });
      },
    };

    gate(req, res, () => resolve({ status: null, body: null, passou: true, req }));
  });
}

test("instância cadastrada passa, e a requisição sabe qual é", async () => {
  const { gate } = monta();
  const r = await chama(gate, { headers: { "x-instance": "marlon" } });

  assert.equal(r.passou, true);
  assert.equal(r.req.instance, "marlon");
});

test("subdomínio NUNCA cadastrado é recusado com 404", async () => {
  // O caso que motivou tudo: bruna.gofitnow.fit apontado para o Cloudflare e
  // nunca cadastrado do nosso lado.
  const { gate } = monta({ registradas: ["marlon"] });
  const r = await chama(gate, { headers: { host: "bruna.gofitnow.fit" } });

  assert.equal(r.passou, false, "não podia passar: essa instância não existe");
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "unknown_instance");
});

test("X-Instance forjado não escolhe banco", async () => {
  // O cabeçalho vem de fora: qualquer um escreve o que quiser nele. Ele diz o que
  // se PEDE, e o registro diz o que se TEM.
  const { gate } = monta({ registradas: ["marlon"] });
  const r = await chama(gate, { headers: { "x-instance": "inventada" } });

  assert.equal(r.passou, false);
  assert.equal(r.status, 404);
});

test("sem endereço nenhum é 400, não 404 — falta informação, não cliente", async () => {
  const { gate } = monta();
  const r = await chama(gate, { headers: {} });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "no_instance");
});

test("app.gofitnow.fit não vira instância", async () => {
  // A entrada genérica não tem como dizer QUAL banco conferiria a senha. Ela cai
  // em 400: não é que o cliente não existe, é que o endereço não seleciona nenhum.
  const { gate } = monta();
  for (const host of ["app.gofitnow.fit", "www.gofitnow.fit", "backend.gofitnow.fit"]) {
    const r = await chama(gate, { headers: { host } });
    assert.equal(r.passou, false, host);
    assert.equal(r.status, 400, host);
  }
});

test("as rotas abertas atravessam sem instância", async () => {
  // Elas existem ANTES de haver instância: a tela de login precisa do tema, e o
  // painel precisa provisionar um cliente que ainda não tem banco.
  const { gate, consultas } = monta();
  for (const path of ["/", "/public/theme", "/internal/instances/x/provision"]) {
    const r = await chama(gate, { path, headers: {} });
    assert.equal(r.passou, true, path);
  }
  assert.equal(consultas.length, 0, "rota aberta não devia nem consultar a central");
});

test.describe("o endereço da tela (X-Instance-Host)", () => {
  test("é resolvido no SERVIDOR, contra o registro", async () => {
    // O app é servido em marlon.gofitnow.fit e chama backend.gofitnow.fit, então o
    // subdomínio da tela não chega aqui sozinho. Ele manda o endereço; quem
    // traduz endereço em instância é o servidor.
    const { gate, consultas } = monta({
      registradas: ["marlon"],
      hosts: { "marlon.gofitnow.fit": "marlon" },
    });

    const r = await chama(gate, { headers: { "x-instance-host": "marlon.gofitnow.fit" } });

    assert.equal(r.passou, true);
    assert.equal(r.req.instance, "marlon");
    assert.equal(consultas[0].o_que, "instanceForHost", "quem resolve é a central, não o cliente");
  });

  test("funciona para domínio PRÓPRIO do cliente, que não tem rótulo para ler", async () => {
    const { gate } = monta({
      registradas: ["marlon"],
      hosts: { "treinos.meustudio.com.br": "marlon" },
    });

    const r = await chama(gate, { headers: { "x-instance-host": "treinos.meustudio.com.br" } });
    assert.equal(r.passou, true);
    assert.equal(r.req.instance, "marlon");
  });

  test("endereço que não é de ninguém não passa", async () => {
    const { gate } = monta({ registradas: ["marlon"], hosts: {} });
    const r = await chama(gate, { headers: { "x-instance-host": "bruna.gofitnow.fit" } });

    assert.equal(r.passou, false);
    assert.equal(r.status, 400, "não resolveu instância nenhuma: falta endereço válido");
  });

  test("X-Instance explícito tem precedência", async () => {
    const { gate, consultas } = monta({
      registradas: ["marlon"],
      hosts: { "outro.gofitnow.fit": "outro" },
    });

    const r = await chama(gate, {
      headers: { "x-instance": "marlon", "x-instance-host": "outro.gofitnow.fit" },
    });

    assert.equal(r.req.instance, "marlon");
    assert.ok(
      !consultas.some((c) => c.o_que === "instanceForHost"),
      "com X-Instance não precisa resolver host"
    );
  });
});

test("central fora do ar FECHA a porta com 503", async () => {
  // Deixar passar quando não se consegue conferir seria abrir exatamente no minuto
  // em que um subdomínio inventado funcionaria. E 503 é a verdade: o problema é
  // nosso, não de quem chamou.
  const { gate } = monta({ quebra: true });
  const r = await chama(gate, { headers: { "x-instance": "marlon" } });

  assert.equal(r.passou, false, "não podia passar sem conseguir conferir");
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "instance_check_failed");
});
