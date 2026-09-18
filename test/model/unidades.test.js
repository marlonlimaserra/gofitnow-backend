const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Unit = require(path.join(__dirname, "..", "..", "model", "Unit_model.js"));
const iconify = require(path.join(__dirname, "..", "..", "lib", "iconify.js"));

// AS UNIDADES — os lugares onde a casa atende.
//
// *"quero cadastrar unidades de academia sabe? não precisa ser exatamente de
// academia... aí o aluno pode fazer parte ou não, de apenas 1 unidade"*.
//
// A decisão de desenho que estes casos guardam é a da segunda frase: o modelo
// NÃO presume academia. Não há CNPJ, horário de funcionamento nem capacidade —
// nada que só sirva a uma academia de bairro. O que toda unidade tem é nome,
// lugar e um jeito de falar com ela.

function monta() {
  const gravados = [];
  const atualizacoes = [];
  const podados = [];

  const col = {
    countDocuments: async () => 0,
    insertOne: async (doc) => {
      gravados.push(doc);
      return { insertedId: "6a80de570056d24c09f5da61" };
    },
    updateOne: async (onde, mudanca) => {
      atualizacoes.push(mudanca);
      return { matchedCount: 1 };
    },
    findOne: async () => null,
    deleteOne: async () => ({ deletedCount: 1 }),
    find: () => ({ sort: () => ({ toArray: async () => [] }) }),
  };

  const model = new Unit({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
    api: {
      unitImage: {
        async pruneUnused(id, emUso) {
          podados.push({ id: String(id), emUso });
          return 0;
        },
        async removeAllOf() {
          return 0;
        },
      },
    },
  });

  return { model, gravados, atualizacoes, podados };
}

const semIconify = () => {
  const original = iconify.buscar;
  iconify.buscar = async () => ({ body: "<path/>", caixa: "0 0 24 24" });
  return () => {
    iconify.buscar = original;
  };
};

test("sem nome não há unidade", async () => {
  // É o único campo obrigatório, e o servidor não pode confiar só na tela.
  const { model, gravados } = monta();

  assert.equal(await model.insert({ endereco: "Rua X" }), null);
  assert.equal(gravados.length, 0);
});

test("o ENDEREÇO é texto livre, e cabe um de verdade", async () => {
  // Endereço estruturado só se paga quando alguém CALCULA com ele. Aqui ele é
  // lido por gente — e um formulário de seis campos erra em qualquer endereço
  // fora do padrão dos Correios, num produto que atende quatro idiomas.
  const { model, gravados } = monta();
  const devolver = semIconify();

  await model.insert({
    name: "Centro",
    endereco: "Av. Paulista, 1000 — 4º andar, sala 42\nSão Paulo/SP",
  });
  devolver();

  assert.match(gravados[0].endereco, /4º andar/);
  assert.match(gravados[0].endereco, /\n/);
});

test("o link do mapa aceita http e https, e mais nada", async () => {
  const { model, gravados } = monta();
  const devolver = semIconify();

  await model.insert({ name: "A", mapa: "https://maps.app.goo.gl/x" });
  await model.insert({ name: "B", mapa: "javascript:alert(1)" });
  await model.insert({ name: "C", mapa: "não é url" });
  devolver();

  assert.equal(gravados[0].mapa, "https://maps.app.goo.gl/x");
  // Este endereço pode acabar num cartão embutido no site de um cliente.
  assert.equal(gravados[1].mapa, "");
  assert.equal(gravados[2].mapa, "");
});

test("o ÍCONE segue a mesma regra do benefício — nome aqui, desenho do servidor", async () => {
  const { model, gravados } = monta();
  const devolver = semIconify();

  await model.insert({ name: "Centro", icone: "MDI:Map-Marker" });
  devolver();

  assert.equal(gravados[0].icone, "mdi:map-marker");
  assert.equal(gravados[0].iconeSvg, "<path/>");
});

test("editar MESCLA — o que a chamada não menciona, ela não toca", async () => {
  // Mesma lição que custou cinco cobranças reais no `updateCharge`.
  const { model, atualizacoes } = monta();

  await model.update("6a80de570056d24c09f5da61", { phone: "(21) 99999-0000" });

  const set = atualizacoes[0].$set;
  assert.equal(set.phone, "(21) 99999-0000");
  assert.ok(!("name" in set), "o nome não foi mencionado e não pode ser tocado");
  assert.ok(!("endereco" in set));
});

test("a faxina de fotos olha o que ficou GRAVADO, não o que veio na chamada", async () => {
  // Uma edição que não menciona a foto mantém a de antes; apagá-la aqui seria
  // o mesmo erro destrutivo.
  const { model, podados } = monta();

  await model.update("6a80de570056d24c09f5da61", { name: "Centro" });

  assert.equal(podados.length, 1);
  assert.deepEqual(podados[0].emUso, []);
});

test("faxina que falha NÃO impede de salvar", async () => {
  const { model } = monta();
  model.app.api.unitImage.pruneUnused = async () => {
    throw new Error("balde fora");
  };

  assert.equal(await model.update("6a80de570056d24c09f5da61", { name: "Centro" }), true);
});

test("reordenar recusa a lista com um id inválido — inteira", async () => {
  // Gravar metade deixaria uma ordem que ninguém escolheu, e sem aviso.
  const { model } = monta();

  assert.equal(await model.reorder(["6a80de570056d24c09f5da61", "lixo"]), false);
  assert.equal(await model.reorder("nem é lista"), false);
  assert.equal(await model.reorder(["6a80de570056d24c09f5da61"]), true);
});

test("`active` só é falso quando alguém diz que é", async () => {
  // Unidade nasce no ar: quem cadastrou quer usá-la.
  const { model, gravados } = monta();
  const devolver = semIconify();

  await model.insert({ name: "A" });
  await model.insert({ name: "B", active: false });
  devolver();

  assert.equal(gravados[0].active, true);
  assert.equal(gravados[1].active, false);
});
