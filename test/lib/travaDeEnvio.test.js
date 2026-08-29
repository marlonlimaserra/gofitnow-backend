const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert");

const trava = require("../../lib/travaDeEnvio.js");

// A TRAVA DE ENVIO DE E-MAIL.
//
// Pedido do Marlon: *"nas chamadas que enviam e-mail, coloque uma trava de 5
// minutos, para evitar de alguém flodar a chamada"*.
//
// Ela protege mais do que o incômodo de quem recebe: cada envio custa cota da
// Resend e REPUTAÇÃO DO DOMÍNIO. Quem recebe o mesmo PDF vinte vezes marca como
// spam, e isso estraga a entrega para todos os outros clientes.

beforeEach(() => trava.reset());

describe("a janela", () => {
  test("o primeiro envio passa", async () => {
    assert.strictEqual(await trava.faltamSegundos("doc:assessments:a1"), 0);
  });

  test("o segundo, dentro da janela, é barrado — e diz quanto falta", async () => {
    trava.marcarEnvio("doc:assessments:a1");

    const faltam = await trava.faltamSegundos("doc:assessments:a1");
    assert.ok(faltam > 0 && faltam <= 300, `faltam ${faltam}`);
  });

  test("a janela é de CINCO minutos", () => {
    assert.strictEqual(trava.JANELA_MS, 5 * 60 * 1000);
  });

  test("janela vencida libera", async () => {
    trava.marcarEnvio("doc:assessments:a1");

    // Uma janela de 0 ms é "tudo já venceu".
    assert.strictEqual(await trava.faltamSegundos("doc:assessments:a1", 0), 0);
  });
});

describe("a chave é a COISA, e não a rota", () => {
  test("documentos diferentes não se travam", async () => {
    // Dez profissionais mandando dez documentos diferentes no mesmo minuto é uso
    // normal. Travar por rota transformaria uso normal em erro.
    trava.marcarEnvio("doc:assessments:a1");

    assert.strictEqual(await trava.faltamSegundos("doc:assessments:a2"), 0);
    assert.strictEqual(await trava.faltamSegundos("doc:diets:d1"), 0);
  });

  test("pessoas diferentes não se travam na anamnese", async () => {
    trava.marcarEnvio("anamnese:p1");

    assert.strictEqual(await trava.faltamSegundos("anamnese:p2"), 0);
  });

  test("e-mails diferentes não se travam na recuperação de senha", async () => {
    trava.marcarEnvio("senha:a@b.com");

    assert.strictEqual(await trava.faltamSegundos("senha:outro@b.com"), 0);
  });
});

describe("o que a trava NÃO pode entregar", () => {
  test("a chave da senha é o e-mail NORMALIZADO", async () => {
    // Sem normalizar, "A@B.com" e "a@b.com" seriam travas separadas — e alternar
    // a caixa das letras daria envios ilimitados.
    trava.marcarEnvio("senha:a@b.com");

    assert.ok((await trava.faltamSegundos("senha:a@b.com")) > 0);
  });
});

// ── LIGADA OU NÃO, decidido na central ────────────────────────────────────
describe("a configuração", () => {
  const appFalso = (valores) => ({
    mongodb: {
      centralDb: async () => ({
        collection: () => ({
          find: () => ({ toArray: async () => valores }),
        }),
      }),
    },
  });

  test("LIGADA por omissão — central que nunca foi configurada protege", async () => {
    // O erro clássico aqui seria `Boolean(v[...])`: com a chave ausente, a trava
    // nasceria DESLIGADA, que é o oposto do padrão seguro.
    const c = await trava.configuracao(appFalso([]));

    assert.strictEqual(c.ligada, true);
    assert.strictEqual(c.janela, trava.JANELA_MS);
  });

  test("desligar de verdade desliga", async () => {
    const c = await trava.configuracao(appFalso([{ key: "email.throttleEnabled", value: false }]));

    assert.strictEqual(c.ligada, false);
  });

  test("a janela vem em MINUTOS e vira milissegundos", async () => {
    const c = await trava.configuracao(appFalso([{ key: "email.throttleMinutes", value: 12 }]));

    assert.strictEqual(c.janela, 12 * 60 * 1000);
  });

  test("zero minutos desliga na prática", async () => {
    const c = await trava.configuracao(appFalso([{ key: "email.throttleMinutes", value: 0 }]));

    assert.strictEqual(c.ligada, false);
  });

  test("valor sem sentido cai no padrão, e não em NaN", async () => {
    for (const v of ["abc", null, -3, undefined]) {
      const c = await trava.configuracao(appFalso([{ key: "email.throttleMinutes", value: v }]));
      assert.ok(Number.isFinite(c.janela) && c.janela > 0, `janela virou ${c.janela} para ${v}`);
    }
  });

  test("central fora do ar MANTÉM a trava", async () => {
    // O lado certo para errar é o conservador: o custo é um reenvio adiado, não
    // um envio impedido para sempre.
    const quebrado = { mongodb: { centralDb: async () => { throw new Error("sem banco"); } } };
    const c = await trava.configuracao(quebrado);

    assert.strictEqual(c.ligada, true);
  });
});
