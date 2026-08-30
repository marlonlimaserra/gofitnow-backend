const { test, describe } = require("node:test");
const assert = require("node:assert");

const { enviar } = require("../../lib/push.js");

// O ENVIO PARA O ONESIGNAL.
//
// Testado com um `fetch` de mentira: dá para conferir exatamente o que sai pela
// rede — que é o que importa — sem chave, sem rede, e sem notificar ninguém.

function fetchFalso(resposta, reg = {}) {
  return async (url, opcoes) => {
    reg.url = url;
    reg.opcoes = opcoes;
    reg.corpo = JSON.parse(opcoes.body);
    return {
      ok: resposta.ok !== false,
      status: resposta.status || 200,
      json: async () => resposta.json ?? { id: "n1", recipients: 1 },
    };
  };
}

const BASE = { appId: "app-1", apiKey: "chave", paraUsuarios: ["u9"], titulo: "Oi", texto: "Corpo" };

describe("o que sai pela rede", () => {
  test("o destino vai como external_id — não guardamos token de aparelho", () => {
    // A alternativa seria uma tabela de tokens nossa, que envelhece sozinha:
    // token morre quando a pessoa reinstala e ninguém avisa.
    const reg = {};
    return enviar(BASE, fetchFalso({}, reg)).then(() => {
      assert.deepStrictEqual(reg.corpo.include_aliases, { external_id: ["u9"] });
      assert.strictEqual(reg.corpo.app_id, "app-1");
    });
  });

  test("a chave vai no cabeçalho, nunca no corpo", async () => {
    const reg = {};
    await enviar(BASE, fetchFalso({}, reg));

    assert.strictEqual(reg.opcoes.headers.Authorization, "Key chave");
    assert.ok(!JSON.stringify(reg.corpo).includes("chave"));
  });

  test("o id do destino vira TEXTO — o Mongo devolve ObjectId", async () => {
    // Sem isto, `include_aliases` sairia com um objeto e o OneSignal recusaria.
    const reg = {};
    await enviar({ ...BASE, paraUsuarios: { toString: () => "abc123" } }, fetchFalso({}, reg));

    assert.deepStrictEqual(reg.corpo.include_aliases.external_id, ["abc123"]);
  });

  test("a rota do toque viaja em `data`", async () => {
    const reg = {};
    await enviar({ ...BASE, dados: { rota: "/my/diet" } }, fetchFalso({}, reg));

    assert.deepStrictEqual(reg.corpo.data, { rota: "/my/diet" });
  });
});

describe("o que NÃO chega a sair", () => {
  test("sem chave, nem tenta", async () => {
    let chamou = false;
    const r = await enviar({ ...BASE, apiKey: "" }, async () => { chamou = true; });

    assert.strictEqual(r.erro, "sem_chave");
    assert.strictEqual(chamou, false);
  });

  test("sem destino, nem tenta", async () => {
    let chamou = false;
    const r = await enviar({ ...BASE, paraUsuarios: [null, undefined, ""] }, async () => { chamou = true; });

    assert.strictEqual(r.erro, "sem_destino");
    assert.strictEqual(chamou, false);
  });
});

describe("a falha nunca sobe", () => {
  test("erro da API vira resultado, e não exceção", async () => {
    // Quem chama é uma rota que JÁ salvou a dieta. Uma exceção aqui derrubaria
    // a resposta de algo que deu certo.
    const r = await enviar(BASE, fetchFalso({ ok: false, status: 400, json: { errors: ["invalid_app_id"] } }));

    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /invalid_app_id/);
  });

  test("rede fora do ar não lança", async () => {
    const r = await enviar(BASE, async () => { throw new Error("sem rede"); });

    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /indisponivel/);
  });

  test("ninguém para receber NÃO é erro", async () => {
    // Acontece o tempo todo: a pessoa nunca abriu o app, ou negou a permissão.
    // Tratar como falha faria procurar defeito onde não há.
    const r = await enviar(BASE, fetchFalso({ json: { id: "n2", recipients: 0 } }));

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.entregues, 0);
  });
});
