const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const StudentController = require("../../controllers/Student.js");

const TRAINER = { _id: "t1", name: "Marlon", type: "trainer" };
const PESSOA = { _id: "p1", name: "Ana", email: "ana@x.com" };

// Monta a rota de verdade sobre modelos de mentira, e devolve o que os modelos
// receberam — é sobre isso que os testes afirmam.
function monta({ target = PESSOA, existente } = {}) {
  const chamadas = { updateStudent: [], setNotes: [], setActive: [] };
  const permissao = permiteTudo(TRAINER);

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      user: {
        async dataStudent() {
          return target;
        },
        async dataByEmail() {
          return existente;
        },
        async updateStudent(trainerId, id, obj) {
          chamadas.updateStudent.push(obj);
          return true;
        },
        async data() {
          return { ...target, name: "Ana" };
        },
        filter: (d) => d,
      },
      link: {
        async setNotes(...a) {
          chamadas.setNotes.push(a);
        },
        async setActive(...a) {
          chamadas.setActive.push(a);
        },
        async notesOf() {
          return "";
        },
        async activeOf() {
          return 1;
        },
      },
      actionHistory: { diff: () => ({}) },
    },
  });

  StudentController(app);
  return { app, chamadas, permissao };
}

const put = (app, body, headers) =>
  call(app, "put", "/people/p1", { body, params: { id: "p1" }, headers });

test("editar mandando o MESMO e-mail continua funcionando", async () => {
  // O formulário envia a ficha inteira; recusar um valor igual ao gravado só
  // quebraria o salvar normal.
  const { app, chamadas } = monta();
  const r = await put(app, { name: "Ana Paula", email: "ana@x.com" });

  assert.equal(r.status, 200);
  assert.equal(chamadas.updateStudent.length, 1);
});

test("editar mandando OUTRO e-mail é recusado com 403", async () => {
  const { app, chamadas } = monta();
  const r = await put(app, { name: "Ana", email: "outro@x.com" });

  assert.equal(r.status, 403);
  assert.equal(r.body.code, "email_not_editable");
  assert.equal(chamadas.updateStudent.length, 0, "não pode nem chegar ao modelo");
});

test("a recusa do e-mail não depende de caixa nem de espaço em volta", async () => {
  const { app } = monta();
  const r = await put(app, { email: "  ANA@X.COM " });
  assert.equal(r.status, 200, "é o mesmo endereço, só escrito diferente");
});

test("o e-mail sai do corpo mesmo quando é aceito — o modelo não pode gravá-lo", async () => {
  const { app, chamadas } = monta();
  await put(app, { name: "Ana Paula", email: "ana@x.com" });

  assert.equal("email" in chamadas.updateStudent[0], false);
  assert.equal(chamadas.updateStudent[0].name, "Ana Paula");
});

test("a mensagem de recusa sai no idioma do pedido", async () => {
  for (const [lang, trecho] of [
    ["pt-BR", /própria pessoa/],
    ["en", /Only the person themselves/],
    ["fr", /Seule la personne/],
  ]) {
    const { app } = monta();
    const r = await put(app, { email: "outro@x.com" }, { "accept-language": lang });
    assert.match(r.body.msg, trecho, lang);
  }
});

test("nome com menos de 2 letras é recusado antes de tocar o modelo", async () => {
  const { app, chamadas } = monta();
  const r = await put(app, { name: "A" });

  assert.equal(r.status, 400);
  assert.equal(chamadas.updateStudent.length, 0);
});

test("pessoa que não é do profissional dá 404, não 403", async () => {
  // De fora não dá para distinguir "não existe" de "é de outro profissional".
  const { app } = monta({ target: null });
  const r = await put(app, { name: "Ana Paula" });

  assert.equal(r.status, 404);
});

test("a rota de edição exige a permissão people.edit", async () => {
  const { app, permissao } = monta();
  await put(app, { name: "Ana Paula" });

  assert.ok(permissao.pedidas.includes("people.edit"), `pediu: ${permissao.pedidas}`);
});

test("observação e status vão para o VÍNCULO, não para a pessoa", async () => {
  // Cada profissional tem a sua anotação e o seu "ativo na minha lista".
  const { app, chamadas } = monta();
  await put(app, { notes: "lesão no ombro", active: 0 });

  assert.equal(chamadas.setNotes.length, 1);
  assert.equal(chamadas.setNotes[0][2], "lesão no ombro");
  assert.equal(chamadas.setActive[0][2], 0);
});
