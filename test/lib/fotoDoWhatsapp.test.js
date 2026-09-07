const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const foto = require("../../lib/fotoDoWhatsapp.js");

// A FOTO DO WHATSAPP — o que ela NUNCA pode fazer.
//
// Este arquivo não testa a integração (não há uazapi em teste). Ele segura as
// três regras que fazem esta busca ser segura pendurar num cadastro:
//
//   NÃO SOBRESCREVE foto existente. Quem já tem avatar escolheu o dele, e o
//   WhatsApp não tem autoridade para trocar o que uma pessoa colocou.
//
//   NÃO CONSULTA quando está desligada na central. Ligada sem host ou sem token
//   faria uma requisição condenada em todo cadastro, e o log encheria de erro
//   que é configuração pela metade.
//
//   NÃO LANÇA nunca. Ela roda depois de um `res.send`, onde uma exceção não tem
//   para onde ir — e a alternativa a não ter foto é a inicial do nome, que a
//   tela já desenha.
const PESSOA = new ObjectId();

function monta({ ligado = true, avatarAt = undefined, host = "https://x.uazapi.dev", token = "t" } = {}) {
  const salvos = [];
  const consultas = [];

  const settings = [
    { key: "whatsapp.uazapi.enabled", value: ligado },
    { key: "whatsapp.uazapi.host", value: host },
    { key: "whatsapp.uazapi.token", value: token },
  ];

  const app = {
    mongodb: {
      async centralDb() {
        return {
          collection: () => ({
            find: () => ({ async toArray() { return settings; } }),
          }),
        };
      },
    },
    api: {
      user: {
        async collection() {
          return {
            async findOne() {
              return { _id: PESSOA, ...(avatarAt ? { avatarAt } : null) };
            },
          };
        },
      },
      avatar: {
        async save(id, mime, bytes) {
          salvos.push({ id: String(id), mime, bytes: bytes.length });
          return new Date();
        },
      },
    },
  };

  return { app, salvos, consultas };
}

test("desligada na central, nem consulta", async () => {
  const { app, salvos } = monta({ ligado: false });

  // `fetch` trocado por uma armadilha: se a função consultar, o teste falha com
  // o motivo na cara, em vez de passar por acidente.
  const original = global.fetch;
  global.fetch = () => {
    throw new Error("consultou o uazapi com a integração DESLIGADA");
  };

  try {
    assert.equal(await foto.buscarParaPessoa(app, PESSOA, "11988887777"), false);
    assert.deepEqual(salvos, []);
  } finally {
    global.fetch = original;
  }
});

test("sem host ou sem token, também não consulta", async () => {
  for (const cfg of [{ host: "" }, { token: "" }]) {
    const { app } = monta(cfg);
    const original = global.fetch;
    global.fetch = () => {
      throw new Error("consultou sem configuração completa");
    };
    try {
      assert.equal(await foto.buscarParaPessoa(app, PESSOA, "11988887777"), false);
    } finally {
      global.fetch = original;
    }
  }
});

test("quem JÁ tem foto não é tocado", async () => {
  const { app, salvos } = monta({ avatarAt: new Date() });

  const original = global.fetch;
  global.fetch = () => {
    throw new Error("consultou para quem já tem foto");
  };

  try {
    assert.equal(await foto.buscarParaPessoa(app, PESSOA, "11988887777"), false);
    assert.deepEqual(salvos, []);
  } finally {
    global.fetch = original;
  }
});

test("sem telefone, sem id, ou id estranho: não faz nada e não lança", async () => {
  const { app } = monta();

  assert.equal(await foto.buscarParaPessoa(app, PESSOA, ""), false);
  assert.equal(await foto.buscarParaPessoa(app, null, "11988887777"), false);
  // Id inválido chega de um cadastro que falhou no meio; não pode virar exceção.
  assert.equal(await foto.buscarParaPessoa(app, "nao-e-id", "11988887777"), false);
});

test("telefone curto demais não vira consulta", async () => {
  // Menos de 10 dígitos não é telefone brasileiro com DDD. Consultar gastaria
  // uma ida ao WhatsApp — e é ida contada, porque rajada bane número.
  const original = global.fetch;
  let bateu = false;
  global.fetch = () => {
    bateu = true;
    throw new Error("não deveria");
  };

  try {
    assert.equal(await foto.urlDaFoto({ host: "https://x", token: "t" }, "1198"), "");
    assert.equal(bateu, false);
  } finally {
    global.fetch = original;
  }
});

test("uazapi fora do ar devolve vazio, sem lançar", async () => {
  const original = global.fetch;
  global.fetch = () => Promise.reject(new Error("ECONNREFUSED"));

  try {
    assert.equal(await foto.urlDaFoto({ host: "https://x", token: "t" }, "11988887777"), "");
  } finally {
    global.fetch = original;
  }
});

test("resposta que não é imagem não é baixada", async () => {
  const original = global.fetch;

  // Um HTML de erro com 200: é o caso real de um proxy no meio do caminho.
  global.fetch = () =>
    Promise.resolve({
      ok: true,
      headers: new Map([["content-type", "text/html; charset=utf-8"]]),
      async arrayBuffer() {
        throw new Error("não deveria ler o corpo");
      },
    });

  try {
    assert.equal(await foto.baixar("https://cdn/foto.jpg"), null);
  } finally {
    global.fetch = original;
  }
});

test("imagem grande demais é recusada pelo cabeçalho, antes de ler", async () => {
  const original = global.fetch;
  let leu = false;

  global.fetch = () =>
    Promise.resolve({
      ok: true,
      headers: new Map([
        ["content-type", "image/jpeg"],
        ["content-length", String(foto.MAX_BYTES + 1)],
      ]),
      async arrayBuffer() {
        leu = true;
        return new ArrayBuffer(0);
      },
    });

  try {
    assert.equal(await foto.baixar("https://cdn/foto.jpg"), null);
    // O ponto: recusou SEM puxar os bytes.
    assert.equal(leu, false);
  } finally {
    global.fetch = original;
  }
});

test("url que não é https não é baixada", async () => {
  const original = global.fetch;
  let bateu = false;
  global.fetch = () => {
    bateu = true;
    throw new Error("não deveria");
  };

  try {
    assert.equal(await foto.baixar("http://cdn/foto.jpg"), null);
    assert.equal(await foto.baixar("javascript:alert(1)"), null);
    assert.equal(bateu, false);
  } finally {
    global.fetch = original;
  }
});
