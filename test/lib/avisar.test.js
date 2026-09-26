const { test, describe } = require("node:test");
const assert = require("node:assert");

const { avisar, EVENTOS } = require("../../lib/avisar.js");

// A CAMADA QUE DECIDE SE AVISA.
//
// `lib/push.js` sabe falar com o OneSignal e mais nada. As regras que impedem
// notificação idiota moram aqui, e são elas que este arquivo segura.

const appFalso = (valores) => ({
  mongodb: {
    centralDb: async () => ({
      collection: () => ({ find: () => ({ toArray: async () => valores }) }),
    }),
  },
});

const LIGADO = appFalso([
  { key: "push.enabled", value: true },
  { key: "push.oneSignalAppId", value: "app-1" },
  { key: "push.oneSignalApiKey", value: "chave" },
]);

describe("quando NÃO avisa", () => {
  test("ninguém é avisado do que ele mesmo fez", async () => {
    // O profissional que também é atendido — existe, e é comum: ele monta o
    // próprio treino — receberia "seu treino novo chegou" um segundo depois de
    // salvá-lo. É o aviso que ensina a pessoa a ignorar os avisos.
    const r = await avisar(LIGADO, "workout", { para: "u1", de: "u1" });

    assert.strictEqual(r.erro, "autor");
  });

  test("sem destino, não avisa", async () => {
    assert.strictEqual((await avisar(LIGADO, "diet", { para: null })).erro, "sem_destino");
  });

  test("desligado na central, não avisa", async () => {
    const desligado = appFalso([{ key: "push.enabled", value: false }]);
    assert.strictEqual((await avisar(desligado, "diet", { para: "u2" })).erro, "desligado");
  });

  test("ligado SEM chave conta como desligado", async () => {
    // Ligado sem chave faria cada dieta salva virar uma ida à rede que sempre
    // falha — e um erro no log a cada ação da casa.
    const semChave = appFalso([{ key: "push.enabled", value: true }]);
    assert.strictEqual((await avisar(semChave, "diet", { para: "u2" })).erro, "desligado");
  });

  test("evento que não existe não vira notificação vazia", async () => {
    const r = await avisar(LIGADO, "inventado", { para: "u2" });
    assert.strictEqual(r.erro, "evento_desconhecido");
  });

  test("quem desligou o assunto não recebe", async () => {
    // A escolha é por ASSUNTO: o mesmo "treino novo" que sai daqui em push sai
    // por e-mail noutro lugar, e desligar precisa calar os dois.
    const comPessoa = {
      ...LIGADO,
      api: { user: { data: async () => ({ preferences: { notify: { workout: false } } }) } },
    };

    const r = await avisar(comPessoa, "workout", { para: "u9" });

    assert.strictEqual(r.erro, "desligado_pela_pessoa");
  });

  test("central fora do ar não derruba — só não avisa", async () => {
    const quebrado = { mongodb: { centralDb: async () => { throw new Error("sem banco"); } } };
    assert.strictEqual((await avisar(quebrado, "diet", { para: "u2" })).erro, "desligado");
  });
});

describe("os eventos", () => {
  test("cada um leva a rota que o toque abre", () => {
    // Sem ela, tocar a notificação abre o app na tela inicial e a pessoa procura
    // sozinha o que foi que chegou.
    for (const [nome, e] of Object.entries(EVENTOS)) {
      assert.ok(e.rota && e.rota.startsWith("/"), `${nome} sem rota`);
      assert.ok(e.chave && e.chave.startsWith("push."), `${nome} sem chave de texto`);
    }
  });

  test("os quatro pedidos estão cobertos", () => {
    // Dieta, treino, avaliação e mensagem — o que o Marlon listou.
    for (const nome of ["diet", "workout", "assessment", "message"]) {
      assert.ok(EVENTOS[nome], `falta o evento ${nome}`);
    }
  });
});
