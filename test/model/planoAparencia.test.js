const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// AS CORES E O BOTÃO DE UM PLANO DA CASA — o que o modelo aceita gravar.
//
// *"coloque uma aba para personalizar cor... faltou o botão de comprar aí
// permita mudar o nome do botão e cores também"*.
//
// Estes valores não ficam guardados: eles saem do banco e entram num `style=`
// e num `href` do CARTÃO PÚBLICO, que roda dentro de um iframe no site de um
// cliente. É por isso que o saneamento é uma lista fechada e não uma limpeza —
// o que não casa vira vazio, e vazio é "a cor da marca".

// O modelo é uma função construtora que só precisa do `app` para falar com o
// banco. Os saneadores são puros: dá para exercitá-los pelo `insert` sem
// MongoDB nenhum, com uma coleção de mentira que só guarda o que recebeu.
function fakeModel() {
  const gravados = [];

  const col = {
    countDocuments: async () => 0,
    insertOne: async (doc) => {
      gravados.push(doc);
      return { insertedId: "novo" };
    },
    updateMany: async () => ({}),
    find: () => ({ sort: () => ({ toArray: async () => [] }) }),
    findOne: async () => null,
    updateOne: async () => ({}),
  };

  const Model = require(path.join(__dirname, "..", "..", "model", "Membership_model.js"));
  const model = new Model({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
    api: { membershipImage: { recolher: async () => {} } },
  });

  // `recolherCapas` fala com o bucket; aqui ele não é o assunto.
  model.recolherCapas = async () => {};

  return { model, gravados };
}

const gravar = async (obj) => {
  const { model, gravados } = fakeModel();
  await model.insert({ name: "Plano Fit", ...obj }, "BRL");
  return gravados[0];
};

test("uma cor válida é gravada normalizada — minúscula e com #", async () => {
  const doc = await gravar({ corFundo: "#AABBCC", corTexto: "112233" });

  assert.equal(doc.corFundo, "#aabbcc");
  // Sem `#` também vale: é como se digita quando se copia de outro lugar.
  assert.equal(doc.corTexto, "#112233");
});

test("o que não é hex de seis dígitos vira VAZIO, que é a cor da marca", async () => {
  // Nunca um cartão quebrado: o pior caso de um valor sujo é o plano sair com
  // a aparência padrão.
  for (const ruim of ["red", "rgb(1,2,3)", "#fff", "#12345", "", null, undefined, 42]) {
    const doc = await gravar({ corDestaque: ruim });
    assert.equal(doc.corDestaque, "", `recusa ${JSON.stringify(ruim)}`);
  }
});

test("CSS escondido numa cor não passa", async () => {
  // O destino destes valores é um atributo `style`, e ali uma string livre faz
  // mais coisa do que pintar.
  const doc = await gravar({ corFundo: "red;background-image:url(//x)" });

  assert.equal(doc.corFundo, "");
});

test("o link do botão aceita http e https, e mais nada", async () => {
  assert.equal((await gravar({ botaoLink: "https://ex.com/x" })).botaoLink, "https://ex.com/x");
  assert.equal((await gravar({ botaoLink: "http://ex.com/" })).botaoLink, "http://ex.com/");
});

test("`javascript:` num href é execução, e este cartão é embutido por terceiros", async () => {
  for (const ruim of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "não é url"]) {
    assert.equal((await gravar({ botaoLink: ruim })).botaoLink, "", `recusa ${ruim}`);
  }
});

test("o texto do botão é aparado, e tem teto", async () => {
  const doc = await gravar({ botaoTexto: "  Matricule-se  " });
  assert.equal(doc.botaoTexto, "Matricule-se");

  const longo = await gravar({ botaoTexto: "x".repeat(200) });
  assert.equal(longo.botaoTexto.length, 40);
});

test("um plano que nunca passou pela aba de aparência nasce todo vazio", async () => {
  // É o que garante que ele saia exatamente como saía antes — e que acompanhe
  // a marca quando ela mudar.
  const doc = await gravar({});

  for (const campo of ["corFundo", "corTexto", "corDestaque", "corBotao", "corBotaoTexto"]) {
    assert.equal(doc[campo], "", campo);
  }
  assert.equal(doc.botaoTexto, "");
  assert.equal(doc.botaoLink, "");
});
