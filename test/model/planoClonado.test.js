const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Membership = require(path.join(__dirname, "..", "..", "model", "Membership_model.js"));
const arquivos = require(path.join(__dirname, "..", "..", "lib", "arquivos.js"));

// CLONAR UM PLANO.
//
// Clonar existe para não remontar o plano do zero: quem tem o "Black" e quer o
// "Black Anual" muda o preço e a cadência, e mais nada. Tudo que ele tiver de
// refazer à mão é o clone cobrando um pedaço do trabalho que ele veio poupar.

// Ids de VERDADE: `data()` recusa o que não é ObjectId, e um "m1" faria o
// clone voltar `undefined` antes de tocar em qualquer regra — com os casos
// passando por engano.
const ID_ORIGEM = "6a80de570056d24c09f5da61";
const ID_CLONE = "6a80de570056d24c09f5da62";
const ID_IMAGEM = "6a80de570056d24c09f5da63";
const ID_IMAGEM_NOVA = "6a80de570056d24c09f5da64";

const ORIGEM = {
  _id: ID_ORIGEM,
  name: "Black",
  tagline: "Treine em qualquer lugar",
  description: "Todas as unidades.",
  amount: 15990,
  currency: "BRL",
  cadencia: "monthly",
  fidelidadeMeses: 12,
  beneficios: ["b1", "b2"],
  cover: ID_IMAGEM,
  destaque: true,
  active: true,
  corFundo: "#dc2626",
  corTexto: "#ffffff",
  corDestaque: "#facc15",
  corBotao: "#ffffff",
  corBotaoTexto: "#b91c1c",
  botaoTexto: "Matricule-se",
  botaoLink: "https://exemplo.com",
  botaoIcone: "mdi:cart",
  botaoIconeSvg: "<path/>",
  botaoIconeCaixa: "0 0 24 24",
};

function monta({ imagem = { _id: ID_IMAGEM, mime: "image/jpeg" }, bytes = Buffer.from("foto") } = {}) {
  const gravados = [];
  const atualizacoes = [];
  const salvas = [];

  const col = {
    countDocuments: async () => 1,
    insertOne: async (doc) => {
      gravados.push(doc);
      return { insertedId: ID_CLONE };
    },
    updateOne: async (onde, mudanca) => {
      atualizacoes.push({ onde, ...(mudanca || {}) });
      return {};
    },
    findOne: async () => ORIGEM,
  };

  const model = new Membership({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
    api: {
      membershipImage: {
        async data() {
          return imagem;
        },
        async save(membershipId, mime, buffer) {
          salvas.push({ membershipId, mime, tamanho: buffer.length });
          return { id: ID_IMAGEM_NOVA };
        },
      },
    },
  });

  const original = arquivos.bytesDoDocumento;
  arquivos.bytesDoDocumento = async () => bytes;

  return { model, gravados, atualizacoes, salvas, devolver: () => {
    arquivos.bytesDoDocumento = original;
  } };
}

test("a CAPA vem junto, com bytes próprios", async () => {
  // *"quando clonei, não veio a foto"*. Ela ficava de fora de propósito, com o
  // argumento do bucket — errado na conta (a capa é reduzida antes de subir) e
  // errado no uso (a foto é a primeira coisa que se escolhe ao montar).
  const { model, salvas, atualizacoes, devolver } = monta();

  await model.duplicate(ID_ORIGEM);

  assert.equal(salvas.length, 1);
  assert.equal(String(salvas[0].membershipId), ID_CLONE);
  assert.equal(salvas[0].mime, "image/jpeg");
  devolver();

  // E o clone passa a apontar para a imagem NOVA.
  const gravou = atualizacoes.find((a) => a.$set?.cover);
  assert.ok(gravou, "o clone não recebeu a capa");
  assert.equal(String(gravou.$set.cover), ID_IMAGEM_NOVA);
});

test("a imagem copiada pertence ao CLONE, e não à origem", async () => {
  // Apontar para a mesma imagem não era saída: a faxina varre POR PLANO, então
  // a primeira gravação do original apagaria a foto do clone.
  const { model, salvas, devolver } = monta();

  await model.duplicate(ID_ORIGEM);
  devolver();

  assert.notEqual(String(salvas[0].membershipId), ID_ORIGEM);
});

test("as CORES e o botão vêm junto — a aparência é metade do trabalho", async () => {
  const { model, gravados, devolver } = monta();

  await model.duplicate(ID_ORIGEM);
  devolver();

  const clone = gravados[0];
  for (const campo of [
    "corFundo", "corTexto", "corDestaque", "corBotao", "corBotaoTexto",
    "botaoTexto", "botaoLink", "botaoIcone", "botaoIconeSvg",
  ]) {
    assert.equal(clone[campo], ORIGEM[campo], campo);
  }
});

test("o DESTAQUE e o À VENDA não vêm — são decisões da vitrine", async () => {
  // Dois "Mais vantajoso" não destacam nada, e um clone à venda no mesmo
  // instante em que nasce publica um plano que ninguém revisou.
  const { model, gravados, devolver } = monta();

  await model.duplicate(ID_ORIGEM);
  devolver();

  assert.equal(gravados[0].destaque, false);
  assert.equal(gravados[0].active, false);
});

test("sem foto na origem, o clone nasce sem foto e sem ir ao bucket", async () => {
  const { model, salvas, devolver } = monta();
  model.data = async () => ({ ...ORIGEM, cover: null });

  await model.duplicate(ID_ORIGEM);
  devolver();

  assert.equal(salvas.length, 0);
});

test("foto que não pôde ser lida NÃO derruba o clone", async () => {
  // A foto é enfeite; o plano é o conteúdo. Ficar sem clone nenhum por causa
  // de um byte que não veio seria o pior dos resultados.
  const { model, gravados, salvas, devolver } = monta({ bytes: null });

  const id = await model.duplicate(ID_ORIGEM);
  devolver();

  assert.equal(id, ID_CLONE);
  assert.equal(gravados.length, 1);
  assert.equal(salvas.length, 0);
});

test("o bucket fora do ar também não derruba o clone", async () => {
  const { model, devolver } = monta();
  model.app.api.membershipImage.save = async () => {
    throw new Error("bucket fora");
  };

  const id = await model.duplicate(ID_ORIGEM);
  devolver();

  assert.equal(id, ID_CLONE);
});
