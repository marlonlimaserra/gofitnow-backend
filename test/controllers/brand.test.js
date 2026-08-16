const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const BrandController = require("../../controllers/Brand.js");
const BrandImage = require("../../model/BrandImage_model.js");

const USER = { _id: "u1", name: "Marlon" };

// Um PNG de 1×1, o menor arquivo que passa por um parser de verdade.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const INSTANCIA = "marlon";

// `limites` é o que o central responderia sobre o plano deste cliente.
// `undefined` é o caso de quem não tem plano nenhum — e é o padrão, porque foi
// assim que a rota viveu até o limite existir.
function monta({ imagem, quantas = 0, viaApiKey = false, limites } = {}) {
  const salvas = [];

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify(req) {
          req._viaApiKey = viaApiKey;
          // O middleware de instância põe isto na requisição de verdade; o
          // arreio não passa por ele.
          req.instance = INSTANCIA;
          return USER;
        },
      },
    },
    api: {
      brandImage: {
        parseDataUri: BrandImage.prototype.parseDataUri,
        async count() {
          return quantas;
        },
        async save(userId, mime, buffer) {
          salvas.push({ userId, mime, bytes: buffer.length });
          return { id: "507f1f77bcf86cd799439011", updatedAt: new Date("2026-08-11T00:00:00Z") };
        },
        async data() {
          return imagem;
        },
      },
      center: {
        async limitsFor() {
          return limites || {};
        },
      },
    },
  });

  BrandController(app);
  return { app, salvas };
}

test("a imagem da marca sai SEM sessão — a tela de entrada é pública", async () => {
  // É a diferença que separa esta rota da foto de perfil: a tela de login
  // aparece antes de existir sessão, então a logo tem de sair sem login.
  const { app } = monta({
    imagem: { mime: "image/png", data: Buffer.from("bytes"), updatedAt: new Date() },
  });

  const r = await call(app, "get", "/public/brand/marlon/507f1f77bcf86cd799439011");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  // `public`, ao contrário do avatar: é a mesma imagem para todo mundo que
  // abre o endereço do profissional.
  assert.match(r.headers["cache-control"], /public/);
});

test("com o mesmo ETag responde 304, sem mandar os bytes de novo", async () => {
  const quando = new Date("2026-08-11T00:00:00Z");
  const { app } = monta({ imagem: { mime: "image/png", data: Buffer.from("bytes"), updatedAt: quando } });

  const etag = '"' + quando.getTime() + '"';
  const r = await call(app, "get", "/public/brand/marlon/507f1f77bcf86cd799439011", {
    headers: { "if-none-match": etag },
  });

  assert.equal(r.status, 304);
  assert.equal(r.body, undefined);
});

test("imagem que não existe é 404 seco", async () => {
  const { app } = monta({ imagem: undefined });
  const r = await call(app, "get", "/public/brand/marlon/507f1f77bcf86cd799439011");
  assert.equal(r.status, 404);
});

test("enviar imagem devolve a URL pronta, não o id", async () => {
  // Quem chamou vai gravar isto no tema, e o tema guarda URL — inclusive de
  // imagem hospedada fora daqui.
  const { app, salvas } = monta();
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 200);
  assert.match(r.body.url, /\/public\/brand\/marlon\/507f1f77bcf86cd799439011$/);
  assert.ok(r.body.url.includes("/marlon/"), "a instância entra no caminho — a rota é aberta");
  assert.match(r.body.url, /^https:\/\//, "o tema só aceita http(s)");
  assert.equal(salvas.length, 1);
  assert.equal(salvas[0].mime, "image/png");
});

test("o que não é imagem é recusado antes de guardar", async () => {
  const { app, salvas } = monta();

  for (const ruim of [
    "",
    "não é data uri",
    "data:text/html;base64,PHNjcmlwdD4=",              // html executável
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",      // SVG é documento, não imagem
    "https://x.com/a.png",                             // URL não é upload
    null,
  ]) {
    const r = await call(app, "post", "/me/brand/image", { body: { image: ruim } });
    assert.equal(r.status, 400, JSON.stringify(ruim));
  }

  assert.deepEqual(salvas, []);
});

test("sem plano, o teto é o padrão do produto", async () => {
  const { app, salvas } = monta({ quantas: BrandImage.PADRAO_POR_CONTA });
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "too_many");
  assert.match(r.body.msg, new RegExp(String(BrandImage.PADRAO_POR_CONTA)));
  assert.deepEqual(salvas, []);
});

test("o número do plano manda, e a mensagem diz esse número", async () => {
  // Três é bem menos que o padrão: se o padrão vencesse, a quarta imagem
  // passaria e o teste falharia por passar, que é o jeito certo de falhar.
  const { app, salvas } = monta({ quantas: 3, limites: { brandImages: 3 } });
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "too_many");
  assert.match(r.body.msg, /3/);
  assert.deepEqual(salvas, []);
});

test("abaixo do número do plano, sobe", async () => {
  const { app, salvas } = monta({ quantas: 2, limites: { brandImages: 3 } });
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 200);
  assert.equal(salvas.length, 1);
});

test("um plano acima do padrão vale — o padrão é só de quem não tem número", async () => {
  const { app, salvas } = monta({
    quantas: BrandImage.PADRAO_POR_CONTA + 5,
    limites: { brandImages: 100 },
  });
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 200);
  assert.equal(salvas.length, 1);
});

test("plano com zero não sobe nenhuma, e a mensagem não manda fazer faxina", async () => {
  // Zero é um limite de verdade — um plano sem imagem de marca é venda
  // legítima. A mensagem do teto ("salve a aparência para liberar as que não
  // estão em uso") mandaria limpar o que não existe.
  const { app, salvas } = monta({ quantas: 0, limites: { brandImages: 0 } });
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "not_in_plan");
  assert.doesNotMatch(r.body.msg, /aparência/);
  assert.deepEqual(salvas, []);
});

test("limite em branco no plano é o padrão, não é torneira aberta", async () => {
  // `null` na tela do painel se chama "ilimitado". Numa rota de upload, sem
  // teto nenhum é um caminho de encher o banco em laço.
  const { app, salvas } = monta({
    quantas: BrandImage.PADRAO_POR_CONTA,
    limites: { brandImages: null },
  });
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "too_many");
  assert.deepEqual(salvas, []);
});

test("uma chave de API não sobe imagem de marca", async () => {
  const { app, salvas } = monta({ viaApiKey: true });
  const r = await call(app, "post", "/me/brand/image", { body: { image: PNG } });

  assert.equal(r.status, 403);
  assert.deepEqual(salvas, []);
});

// ── O parser, direto ────────────────────────────────────────────────────────

test("o parser aceita só os três formatos que o navegador exibe", () => {
  const parse = BrandImage.prototype.parseDataUri;
  const corpo = Buffer.from("x").toString("base64");

  for (const mime of BrandImage.MIMES) {
    assert.ok(parse(`data:${mime};base64,${corpo}`), mime);
  }
  assert.equal(parse(`data:image/svg+xml;base64,${corpo}`), undefined);
  assert.equal(parse(`data:image/gif;base64,${corpo}`), undefined);
});

test("o parser recusa o que passa do tamanho máximo", () => {
  const parse = BrandImage.prototype.parseDataUri;
  const grande = Buffer.alloc(BrandImage.MAX_BYTES + 1).toString("base64");

  assert.equal(parse(`data:image/png;base64,${grande}`), undefined);
  assert.equal(parse("data:image/png;base64,"), undefined, "vazio também não passa");
});

// ── A faxina ────────────────────────────────────────────────────────────────

test("apaga o que o tema deixou de usar, e só isso", async () => {
  // O tema salvo é o dono da verdade: trocar a logo não pode deixar a antiga
  // pendurada, e uma imagem enviada e não usada também não fica.
  let filtro;
  const model = new (require("../../model/BrandImage_model.js"))({
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            async deleteMany(f) {
              filtro = f;
              return { deletedCount: 3 };
            },
          }),
        };
      },
    },
  });

  const apagadas = await model.pruneUnused("507f1f77bcf86cd799439099", [
    "https://backend.gofitnow.fit/public/brand/507f1f77bcf86cd799439011",
    "https://backend.gofitnow.fit/public/brand/507f1f77bcf86cd799439012",
  ]);

  assert.equal(apagadas, 3);
  assert.equal(filtro._id.$nin.length, 2, "o que está em uso fica de fora do apagar");
  assert.deepEqual(
    filtro._id.$nin.map(String),
    ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
  );
});

test("URL de fora não vira id — e não faz a faxina apagar tudo", async () => {
  // Uma imagem hospedada em outro lugar é URL válida no tema, mas não tem id
  // nosso. Se ela virasse um ObjectId inválido, a consulta estouraria.
  let filtro;
  const model = new (require("../../model/BrandImage_model.js"))({
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            async deleteMany(f) {
              filtro = f;
              return { deletedCount: 0 };
            },
          }),
        };
      },
    },
  });

  await model.pruneUnused("507f1f77bcf86cd799439099", [
    "https://cdn.outrolugar.com/logo.png",
    "",
    undefined,
    "https://backend.gofitnow.fit/public/brand/507f1f77bcf86cd799439011",
  ]);

  assert.deepEqual(filtro._id.$nin.map(String), ["507f1f77bcf86cd799439011"]);
});
