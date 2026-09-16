const test = require("node:test");
const assert = require("node:assert/strict");

const { melhorHost } = require("../../lib/enderecoDaInstancia.js");
const dominio = require("../../lib/domain.js");

// ── QUAL ENDEREÇO A GENTE MOSTRA (15/09/2026) ─────────────────────────────
//
// Este helper monta o link do e-mail de recuperação de senha, o do convite de
// anamnese, o retorno do checkout e o "voltar" do portal da Stripe.
//
// Ele lia `hosts[0]`, e isso quebrou calado no dia em que o domínio oficial
// virou `vafit.app`: o registro de TODO cliente foi escrito quando o oficial era
// `gofitnow.fit`, então o primeiro host de todos continua sendo o antigo.
//
// O defeito não derrubava nada — o curinga atende os três domínios — e por isso
// levou dois dias para aparecer. Apareceu no portal da Stripe, que é o único
// desses lugares que escreve o nome da marca ao lado do botão: "Voltar para
// VAFIT" levando para `marlon.gofitnow.fit`.

test("com só o host ANTIGO registrado, mostra o domínio de hoje", async () => {
  // O caso de todos os clientes vivos hoje. A migração de dados pode vir ou não
  // vir; o endereço mostrado tem de estar certo de qualquer jeito.
  assert.equal(melhorHost(["marlon.gofitnow.fit"], "marlon"), "marlon." + dominio.BASE_DOMAIN);
});

test("com os dois, escolhe o de hoje e não o primeiro da lista", async () => {
  assert.equal(
    melhorHost(["marlon.gofitnow.fit", "marlon." + dominio.BASE_DOMAIN], "marlon"),
    "marlon." + dominio.BASE_DOMAIN
  );
});

test("a ordem no registro NÃO decide", async () => {
  // É a diferença entre a regra nova e a velha: antes, quem estivesse na frente
  // ganhava, e a frente é histórica.
  assert.equal(
    melhorHost(["marlon." + dominio.BASE_DOMAIN, "marlon.gofitnow.fit"], "marlon"),
    "marlon." + dominio.BASE_DOMAIN
  );
});

test("o DOMÍNIO PRÓPRIO do cliente ganha de todos", async () => {
  // É a marca dele, e é para isso que ele paga o plano que a habilita. Mandar
  // um cliente com domínio próprio para `<nome>.vafit.app` seria entregar a
  // nossa marca no e-mail que ele manda para os alunos dele.
  assert.equal(
    melhorHost(["marlon.gofitnow.fit", "app.academia-x.com.br"], "marlon"),
    "app.academia-x.com.br"
  );
});

test("o domínio próprio ganha até do host oficial", async () => {
  assert.equal(
    melhorHost(["marlon." + dominio.BASE_DOMAIN, "app.academia-x.com.br"], "marlon"),
    "app.academia-x.com.br"
  );
});

test("sem host nenhum, monta pelo nome", async () => {
  // Cliente recém-criado, antes de o registro de endereço existir.
  assert.equal(melhorHost([], "marlon"), "marlon." + dominio.BASE_DOMAIN);
  assert.equal(melhorHost(undefined, "marlon"), "marlon." + dominio.BASE_DOMAIN);
});

test("host com espaço ou caixa alta não vira endereço quebrado", async () => {
  assert.equal(melhorHost(["  App.Academia-X.com.BR  "], "marlon"), "app.academia-x.com.br");
});

test("sem host e sem nome, devolve nada em vez de um endereço inventado", async () => {
  // `https://undefined.vafit.app` num e-mail é pior que não mandar o link.
  assert.equal(melhorHost([], ""), null);
});

test("os OUTROS domínios nossos não são domínio próprio", async () => {
  // `shapeapp.fit` é nosso, e a regra do domínio próprio não pode capturá-lo —
  // senão um cliente antigo do ShapeApp seria mandado para lá para sempre.
  for (const base of dominio.BASE_DOMAINS) {
    assert.equal(
      melhorHost([`marlon.${base}`], "marlon"),
      "marlon." + dominio.BASE_DOMAIN,
      base
    );
  }
});
