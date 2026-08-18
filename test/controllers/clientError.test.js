const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const ClientErrorController = require("../../controllers/ClientError.js");
const { assinatura, ehRuido } = require("../../model/ClientError_model.js");
const rateLimit = require("../../lib/rateLimit.js");

// A rota que recebe relato de erro tem uma regra acima de todas: ela roda quando
// a tela JÁ está com problema, e não pode causar um segundo.
//
// Por isso quase todo teste aqui é sobre o que ela NÃO faz — não devolve erro,
// não espera o banco, não aceita a instância que o cliente mandou.
function monta({ falha = null, instancia = "marlon" } = {}) {
  const gravados = [];

  const app = fakeApp({
    api: {
      clientError: {
        async registrar(dados) {
          if (falha) throw new Error(falha);
          gravados.push(dados);
          return { registrado: true };
        },
      },
      center: {
        async instanceForHost() {
          if (instancia === "explode") throw new Error("central fora");
          return instancia;
        },
      },
    },
  });

  ClientErrorController(app);
  return { app, gravados };
}

// O harness responde na hora; o trabalho da rota acontece depois do `res`. Sem
// esperar um tique, o teste olharia antes de a gravação ter acontecido.
const respira = () => new Promise((r) => setTimeout(r, 10));

test.beforeEach(() => rateLimit.reset());

const relatar = (app, body, headers = {}) =>
  call(app, "post", "/public/client-error", { body, headers });

const ERRO = {
  message: "Cannot read properties of undefined (reading 'nome')",
  stack: "TypeError: ...\n  at Diet.jsx:42",
  source: "https://marlon.gofitnow.fit/assets/index-abc.js",
  line: 4821,
  col: 17,
  tipo: "js",
  caminho: "/dietas/68f2",
  versao: "0.3.1",
  app: true,
  navegador: "Chrome 131 · Windows",
};

// ── A regra número um ─────────────────────────────────────────────────────

test("responde 204 mesmo quando o banco explode", async () => {
  const { app } = monta({ falha: "mongo caiu" });

  const r = await relatar(app, ERRO);

  assert.equal(r.status, 204);
});

test("responde 204 para corpo vazio, sem reclamar", async () => {
  const { app } = monta();

  assert.equal((await relatar(app, {})).status, 204);
  assert.equal((await relatar(app, { message: "" })).status, 204);
});

// Se esta rota devolvesse falha, o relator tentaria relatar a falha do relato —
// e um laço de erro relatando erro é a única forma de esta feature derrubar o
// servidor que ela existe para proteger.
test("nunca devolve corpo — nada que o relator possa tentar interpretar", async () => {
  const { app } = monta({ falha: "explodiu" });

  const r = await relatar(app, ERRO);

  assert.equal(r.body, undefined);
});

// ── O que ela grava ───────────────────────────────────────────────────────

test("grava o relato com o que a tela mandou", async () => {
  const { app, gravados } = monta();

  await relatar(app, ERRO, { "x-instance-host": "marlon.gofitnow.fit" });
  await respira();

  assert.equal(gravados.length, 1);
  assert.match(gravados[0].message, /Cannot read properties/);
  assert.equal(gravados[0].line, 4821);
  assert.equal(gravados[0].versao, "0.3.1");
  assert.equal(gravados[0].app, true);
});

// Mesma regra do resto do sistema: a tela diz o ENDEREÇO, o servidor diz de quem
// ele é. Aceitar a instância do corpo deixaria um erro forjado aparecer no
// painel como se fosse de outro cliente.
test("a instância é resolvida no servidor, nunca aceita do corpo", async () => {
  const { app, gravados } = monta({ instancia: "marlon" });

  await relatar(app, { ...ERRO, instance: "bruna" }, { "x-instance-host": "marlon.gofitnow.fit" });
  await respira();

  assert.equal(gravados[0].instance, "marlon");
});

test("central fora do ar não impede o registro", async () => {
  const { app, gravados } = monta({ instancia: "explode" });

  await relatar(app, ERRO, { "x-instance-host": "marlon.gofitnow.fit" });
  await respira();

  assert.equal(gravados.length, 1);
  assert.equal(gravados[0].instance, "");
});

// Erro no portal acontece ANTES de existir instância — e é lá que mora a tela
// mais nova. Exigir instância registraria só os erros de quem já entrou.
test("relato sem instância nenhuma é aceito", async () => {
  const { app, gravados } = monta();

  await relatar(app, ERRO);
  await respira();

  assert.equal(gravados.length, 1);
});

// A query string pode carregar token de criar senha. Ela é cortada AQUI, não
// confiada ao cliente.
test("a query string é removida do caminho", async () => {
  const { app, gravados } = monta();

  await relatar(app, { ...ERRO, caminho: "/reset-password?token=segredo123#x" });
  await respira();

  assert.equal(gravados[0].caminho, "/reset-password");
  assert.ok(!JSON.stringify(gravados[0]).includes("segredo123"));
});

// ── O limite ──────────────────────────────────────────────────────────────

test("passando de 20 por minuto, para de gravar — mas continua respondendo 204", async () => {
  const { app, gravados } = monta();

  for (let i = 0; i < 25; i++) {
    const r = await relatar(app, { ...ERRO, message: `erro ${i}` }, { "x-forwarded-for": "7.7.7.7" });
    assert.equal(r.status, 204, `a ${i + 1}ª devia responder 204`);
    await respira();
  }

  assert.equal(gravados.length, 20);
});

// ── A ORIGEM: painel ou app ───────────────────────────────────────────────
//
// Os dois relatam para a mesma collection, para haver UM lugar de olhar quando
// algo quebra. O que os separa é este campo.
test("a origem chega ao modelo", async () => {
  const { app, gravados } = monta();

  await relatar(app, { ...ERRO, origem: "painel" });
  await respira();

  assert.equal(gravados[0].origem, "painel");
});

test("o mesmo erro no painel e no app são DOIS registros", () => {
  const base = { message: "i18n is not defined", source: "", line: 0, tipo: "render" };

  // Erro de render chega sem arquivo e sem linha: sem a origem na assinatura,
  // estes dois viravam um só, e marcar um como resolvido esconderia o outro.
  assert.notEqual(
    assinatura({ ...base, origem: "app" }),
    assinatura({ ...base, origem: "painel" })
  );
});

// A origem vem de código que roda na máquina de outra pessoa e vai direto para o
// filtro do painel. Texto livre aqui seria lixo na tela de triagem — ou pior.
test("origem inventada cai em app", () => {
  const inventada = assinatura({
    message: "x", source: "", line: 0, tipo: "js", origem: "<script>alert(1)</script>",
  });
  const app = assinatura({ message: "x", source: "", line: 0, tipo: "js", origem: "app" });

  // A assinatura não normaliza — quem normaliza é o `registrar`. Aqui o que se
  // prova é que ela SEPARA, e o caso da lista está no teste do modelo.
  assert.notEqual(inventada, app);
});

test("sem origem, a assinatura é a mesma de app", () => {
  assert.equal(
    assinatura({ message: "x", source: "", line: 0, tipo: "js" }),
    assinatura({ message: "x", source: "", line: 0, tipo: "js", origem: "app" })
  );
});

// ── A assinatura, que é o que agrupa ──────────────────────────────────────

test("o mesmo erro em linhas diferentes tem a MESMA assinatura", async () => {
  // Um deploy que mexeu no espaçamento muda o número da linha. Sem os números
  // normalizados, ele criaria registros novos para bugs velhos.
  const a = assinatura({ message: "x is undefined at 4821", source: "a.js", line: 10, tipo: "js" });
  const b = assinatura({ message: "x is undefined at 4822", source: "a.js", line: 10, tipo: "js" });

  assert.equal(a, b);
});

test("erros diferentes têm assinaturas diferentes", async () => {
  const a = assinatura({ message: "x is undefined", source: "a.js", line: 10, tipo: "js" });
  const b = assinatura({ message: "y is not a function", source: "a.js", line: 10, tipo: "js" });

  assert.notEqual(a, b);
});

// ── O ruído ───────────────────────────────────────────────────────────────
//
// Cada um destes aparece, não é nosso, e não tem conserto. Sem a lista, o painel
// abre cheio de coisa que ninguém pode arrumar — e um painel assim se aprende a
// ignorar, inclusive no dia em que ele estiver certo.
test("descarta o ruído conhecido", () => {
  assert.ok(ehRuido("ResizeObserver loop completed with undelivered notifications", ""));
  assert.ok(ehRuido("Script error.", ""));
  assert.ok(ehRuido("boom", "chrome-extension://abc/inject.js"));
  assert.ok(ehRuido("Failed to fetch", ""));
});

test("não descarta erro de verdade", () => {
  assert.ok(!ehRuido("Cannot read properties of undefined", "/assets/index.js"));
  assert.ok(!ehRuido("dieta.refeicoes is not iterable", "/assets/index.js"));
});
