const test = require("node:test");
const assert = require("node:assert/strict");

const Tenant_model = require("../../model/Tenant_model.js");

// O QUE SE GRAVA É O QUE SE LÊ.
//
// Estes testes existem por causa de um defeito calado que durou uma migração
// inteira: o documento da casa virou único (`{ chave: "instancia" }`), a LEITURA
// foi migrada e a ESCRITA não. Salvar o vocabulário criava um segundo documento
// em `configurations` que nenhum leitor procurava.
//
// Ninguém viu porque nada errou: a tela dizia "salvo", a rota respondia 200 com
// as palavras certas, e a interface continuava mostrando as antigas — o degrau
// de compatibilidade do leitor (`users.peopleSingular`) seguia respondendo pelo
// lugar de antes.
//
// Nenhum teste pegava isso porque todos dublavam um lado só. A forma que pega é
// esta: gravar e LER DE VOLTA pelo caminho de verdade, com uma collection que se
// comporta como o Mongo — o filtro tem de casar para o dado voltar.
function fakeCollection() {
  const docs = [];

  const casa = (doc, filtro) =>
    Object.entries(filtro).every(([k, v]) => String(doc[k]) === String(v));

  return {
    docs,
    async findOne(filtro) {
      return docs.find((d) => casa(d, filtro));
    },
    async updateOne(filtro, update, opcoes = {}) {
      const achado = docs.find((d) => casa(d, filtro));

      if (achado) {
        Object.assign(achado, update.$set || {});
        for (const campo of Object.keys(update.$unset || {})) delete achado[campo];
        return { matchedCount: 1 };
      }

      if (!opcoes.upsert) return { matchedCount: 0 };

      docs.push({ ...filtro, ...(update.$setOnInsert || {}), ...(update.$set || {}) });
      return { matchedCount: 0, upsertedCount: 1 };
    },
  };
}

const DONO = "aaaaaaaaaaaaaaaaaaaaaaaa";

function monta({ dono = { _id: DONO } } = {}) {
  const col = fakeCollection();

  const modelo = new Tenant_model({
    api: {
      user: {
        async collection() {
          return {
            async findOne() {
              return dono;
            },
          };
        },
        async data() {
          return dono;
        },
      },
    },
  });

  modelo.collection = async () => col;
  return { modelo, col };
}

test("o vocabulário salvo é o vocabulário lido", async () => {
  const { modelo } = monta();

  assert.deepEqual(await modelo.saveWords({ peopleSingular: "Paciente", peoplePlural: "Pacientes" }), {
    singular: "paciente",
    plural: "pacientes",
  });

  assert.deepEqual(await modelo.wordsOfInstance(), {
    singular: "paciente",
    plural: "pacientes",
  });
});

test("o vocabulário mora no documento ÚNICO da casa, não num por usuário", async () => {
  const { modelo, col } = monta();
  await modelo.saveWords({ peopleSingular: "cliente", peoplePlural: "clientes" });

  // Um documento só, e é o da instância. Um segundo aqui seria exatamente o
  // defeito de volta: gravado num lugar, procurado noutro.
  assert.equal(col.docs.length, 1);
  assert.equal(col.docs[0].chave, "instancia");
});

test("gravar o vocabulário não apaga o que já estava no documento", async () => {
  const { modelo, col } = monta();

  await modelo.saveTheme(DONO, { brand: "#16a34a" });
  await modelo.saveWords({ peopleSingular: "aluno", peoplePlural: "alunos" });

  assert.equal(col.docs.length, 1);
  assert.equal(col.docs[0].theme.brand, "#16a34a");
  assert.equal(col.docs[0].peopleSingular, "aluno");
});

test("meia palavra não grava — a conta não pode dizer 'cliente' e 'pessoas' na mesma tela", async () => {
  const { modelo, col } = monta();

  assert.equal(await modelo.saveWords({ peopleSingular: "cliente" }), null);
  assert.equal(await modelo.saveWords({ peoplePlural: "clientes" }), null);
  assert.deepEqual(col.docs, []);
});

test("sem ninguém ter escolhido, a palavra é pessoa/pessoas", async () => {
  const { modelo } = monta({ dono: { _id: DONO } });
  assert.deepEqual(await modelo.wordsOfInstance(), { singular: "pessoa", plural: "pessoas" });
});

test("o degrau de compatibilidade ainda enxerga a palavra no lugar ANTIGO", async () => {
  // Enquanto a migração não roda em toda instância, a palavra que mora no
  // documento do dono continua valendo. Tirar este degrau antes disso faria uma
  // conta inteira voltar a dizer "pessoa" sem ninguém ter mexido.
  const { modelo } = monta({
    dono: { _id: DONO, peopleSingular: "paciente", peoplePlural: "pacientes" },
  });

  assert.deepEqual(await modelo.wordsOfInstance(), {
    singular: "paciente",
    plural: "pacientes",
  });
});

test("o que está na CASA vence o que está no lugar antigo", async () => {
  const { modelo } = monta({
    dono: { _id: DONO, peopleSingular: "paciente", peoplePlural: "pacientes" },
  });

  await modelo.saveWords({ peopleSingular: "atleta", peoplePlural: "atletas" });

  assert.deepEqual(await modelo.wordsOfInstance(), { singular: "atleta", plural: "atletas" });
});

test("o idioma da conta salvo é o idioma da conta lido", async () => {
  const { modelo, col } = monta();

  assert.equal(await modelo.saveLanguage("en"), "en");
  assert.equal(await modelo.languageOfInstance(), "en");
  assert.equal(col.docs.length, 1);
  assert.equal(col.docs[0].chave, "instancia");
});

test("idioma que não é nosso não vira idioma gravado", async () => {
  const { modelo, col } = monta();

  // Conferido contra a lista CRUA: normalizar aqui gravaria "pt-BR" como se
  // alguém tivesse escolhido português.
  for (const lixo of ["de", "pt", "", null, "PT-br"]) {
    assert.equal(await modelo.saveLanguage(lixo), null);
  }
  assert.deepEqual(col.docs, []);
});

test("os ângulos da foto salvos são os ângulos lidos", async () => {
  const { modelo, col } = monta();

  const salvo = await modelo.saveAssessmentPhotoSides([{ key: "front" }, { label: "Duplo bíceps" }]);
  assert.deepEqual(salvo.map((l) => l.key), ["front", "duplo-biceps"]);

  assert.deepEqual(await modelo.assessmentPhotoSides(), salvo);
  assert.equal(col.docs.length, 1);
  assert.equal(col.docs[0].chave, "instancia");
});
