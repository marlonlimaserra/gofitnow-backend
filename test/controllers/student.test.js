const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const StudentController = require("../../controllers/Student.js");

const TRAINER = { _id: "t1", name: "Marlon", type: "trainer" };
const PESSOA = { _id: "p1", name: "Ana", email: "ana@x.com" };

// Monta a rota de verdade sobre modelos de mentira, e devolve o que os modelos
// receberam — é sobre isso que os testes afirmam.
function monta({ target = PESSOA, existente , vinculado = true } = {}) {
  const chamadas = { updateStudent: [], setNotes: [], setActive: [], insertStudent: [] };
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
        async insertStudent(trainerId, obj) {
          chamadas.insertStudent.push(obj);
          return "novo1";
        },
        async data() {
          return { ...target, name: "Ana" };
        },
        filter: (d) => d,
      },
      link: {
        // Se o e-mail repetido é de aluno MEU ou de outro profissional da equipe:
        // é o que decide a mensagem do 409 (ver o POST /people).
        async exists() {
          return vinculado;
        },
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
      role: {
        clientName: "Pessoa",
        async dataByName() {
          return { _id: "r1" };
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

const post = (app, body) => call(app, "post", "/people", { body });

// ── Cadastrar ─────────────────────────────────────────────────────────────
//
// O e-mail deixou de ser obrigatório em 14/08/2026. A maior parte das fichas
// nunca vai entrar no app, e exigir endereço de quem não tem enchia a lista de
// aluno1@aluno.com — que parece dado, não é, e ainda ocupa o índice único.

test("cadastra só com o nome — sem e-mail nenhum", async () => {
  const { app, chamadas } = monta();
  const r = await post(app, { name: "Ana" });

  assert.equal(r.status, 201);
  assert.equal(chamadas.insertStudent.length, 1);
  assert.equal(chamadas.insertStudent[0].email, "");
});

test("e-mail só de espaços entra como ficha sem e-mail, não como endereço em branco", async () => {
  // Gravar "   " passaria pelo índice parcial como string e roubaria o lugar de
  // outra ficha vazia. Quem apara é a rota, antes do modelo.
  const { app, chamadas } = monta();
  const r = await post(app, { name: "Ana", email: "   " });

  assert.equal(r.status, 201);
  assert.equal(chamadas.insertStudent[0].email, "");
});

test("e-mail escrito errado continua sendo recusado", async () => {
  // Opcional não é o mesmo que aceito de qualquer jeito: "ana@" é engano de
  // digitação, e gravar assim quebraria o login e o e-mail que sai daqui.
  const { app, chamadas } = monta();
  const r = await post(app, { name: "Ana", email: "ana@" });

  assert.equal(r.status, 400);
  assert.equal(chamadas.insertStudent.length, 0);
});

test("senha sem e-mail é recusada — seria chave sem porta", async () => {
  // O pior desfecho seria gravar a ficha ignorando a senha: o profissional sai
  // achando que a pessoa já pode entrar no app.
  const { app, chamadas } = monta();
  const r = await post(app, { name: "Ana", password: "segredo123" });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "password_needs_email");
  assert.equal(chamadas.insertStudent.length, 0);
});

test("duas fichas sem e-mail não disputam nada — a checagem de repetido nem roda", async () => {
  // `dataByEmail` devolvendo alguém não pode barrar quem não mandou endereço.
  const { app } = monta({ existente: { _id: "outra" } });
  const r = await post(app, { name: "Ana" });

  assert.equal(r.status, 201);
});

test("com e-mail, o já cadastrado continua dando 409", async () => {
  const { app, chamadas } = monta({ existente: { _id: "outra" } });
  const r = await post(app, { name: "Ana", email: "ana@x.com" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_taken");
  assert.equal(chamadas.insertStudent.length, 0);
});

test("nome continua obrigatório — é o que sobrou de identidade", async () => {
  const { app, chamadas } = monta();
  const r = await post(app, { name: "A", email: "ana@x.com" });

  assert.equal(r.status, 400);
  assert.equal(chamadas.insertStudent.length, 0);
});

test("editar mandando o MESMO e-mail continua funcionando", async () => {
  // O formulário envia a ficha inteira; recusar um valor igual ao gravado só
  // quebraria o salvar normal.
  const { app, chamadas } = monta();
  const r = await put(app, { name: "Ana Paula", email: "ana@x.com" });

  assert.equal(r.status, 200);
  assert.equal(chamadas.updateStudent.length, 1);
});

// O e-mail PODE ser trocado.
//
// Ficou travado enquanto o backend era de banco único: o endereço era a
// identidade da pessoa entre profissionais de contas diferentes. Com um banco por
// cliente, o mesmo ser humano em duas instâncias já são dois cadastros distintos,
// e aqui dentro quem cadastrou é quem cuida do dado.
test("editar mandando OUTRO e-mail grava o novo", async () => {
  const { app, chamadas } = monta();
  const r = await put(app, { name: "Ana", email: "outro@x.com" });

  assert.equal(r.status, 200);
  assert.equal(chamadas.updateStudent[0].email, "outro@x.com", "o modelo tinha de receber");
});

test("e-mail que já é de OUTRA conta é recusado com 409", async () => {
  // Duas fichas com o mesmo e-mail seriam duas contas disputando o mesmo login.
  const { app, chamadas } = monta({ existente: { _id: "outra-pessoa" } });
  const r = await put(app, { email: "ocupado@x.com" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_in_use");
  assert.equal(chamadas.updateStudent.length, 0, "não pode nem chegar ao modelo");
});

test("o e-mail que já é DESTA pessoa não conta como ocupado", async () => {
  // `dataByEmail` acha o próprio documento: recusar aqui impediria de salvar
  // qualquer outro campo da ficha.
  const { app } = monta({ existente: { _id: PESSOA._id } });
  const r = await put(app, { email: "novo@x.com", name: "Ana Paula" });

  assert.equal(r.status, 200);
});

test("colisão de corrida vira 409, não 500", async () => {
  // A checagem acima perde a corrida entre duas requisições simultâneas; quem
  // garante é o índice único. Sem traduzir o 11000, a pessoa levaria um erro
  // interno sem explicação no lugar de "esse e-mail já é de outra".
  const { app } = monta();
  app.api.user.updateStudent = async () => {
    const erro = new Error("E11000 duplicate key");
    erro.code = 11000;
    throw erro;
  };

  const r = await put(app, { email: "corrida@x.com" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_in_use");
});

test("a recusa do e-mail não depende de caixa nem de espaço em volta", async () => {
  const { app } = monta();
  const r = await put(app, { email: "  ANA@X.COM " });
  assert.equal(r.status, 200, "é o mesmo endereço, só escrito diferente");
});

test("a recusa sai no idioma do pedido", async () => {
  for (const [lang, trecho] of [
    ["pt-BR", /em uso/i],
    ["en", /in use/i],
    ["es", /en uso/i],
  ]) {
    const { app } = monta({ existente: { _id: "outra-pessoa" } });
    const r = await put(app, { email: "ocupado@x.com" }, { "accept-language": lang });
    assert.match(r.body.msg, trecho, lang);
  }
});

test("apagar o e-mail de quem NÃO entra no app é permitido", async () => {
  // O caminho de volta do cadastro sem e-mail: gravou errado, apaga. O modelo
  // recebe a string vazia e transforma em campo ausente.
  const { app, chamadas } = monta({ target: { _id: "p1", name: "Ana", email: "ana@x.com" } });
  const r = await put(app, { name: "Ana", email: "" });

  assert.equal(r.status, 200);
  assert.equal(chamadas.updateStudent[0].email, "");
});

test("apagar o e-mail de quem ENTRA no app é recusado", async () => {
  // Sem endereço não há login. Apagar em silêncio trancaria a pessoa do lado de
  // fora sem ninguém saber — quem quer isso tem o botão de tirar o acesso, que
  // ao menos diz o que faz.
  const { app, chamadas } = monta({
    target: { _id: "p1", name: "Ana", email: "ana@x.com", password: "hash" },
  });
  const r = await put(app, { email: "" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_is_login");
  assert.equal(chamadas.updateStudent.length, 0);
});

test("dar acesso a quem está sem e-mail é recusado", async () => {
  const { app, chamadas } = monta({ target: { _id: "p1", name: "Ana" } });
  const r = await put(app, { password: "segredo123" });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "password_needs_email");
  assert.equal(chamadas.updateStudent.length, 0);
});

test("dar acesso junto com o e-mail, na mesma gravada, funciona", async () => {
  // É o caso real: a ficha nasceu sem endereço e agora a pessoa quer entrar no
  // app. Os dois campos vêm no mesmo salvar, e ler só o que está gravado
  // recusaria com "precisa de e-mail" bem na hora em que ele está sendo dado.
  const { app, chamadas } = monta({ target: { _id: "p1", name: "Ana" } });
  const r = await put(app, { email: "ana@x.com", password: "segredo123" });

  assert.equal(r.status, 200);
  assert.equal(chamadas.updateStudent.length, 1);
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


// ── QUAL É A MENSAGEM DO E-MAIL REPETIDO ──────────────────────────────────
//
// Ela era sempre "essa pessoa já está na sua lista", e é falsa em dois dos três
// casos. O Marlon caiu justo neles: tentou cadastrar o PRÓPRIO e-mail de
// profissional, ouviu "já existe na lista" e foi procurar na lista de clientes —
// onde conta de profissional nunca aparece. Mensagem que manda procurar onde não
// está consome o tempo da pessoa duas vezes.

test("e-mail de USUÁRIO DA EQUIPE aponta para a tela certa", async () => {
  const { app } = monta({ existente: { _id: "u9", type: "trainer" } });
  const r = await post(app, { name: "Ana", email: "marlon@x.com" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_taken");
  assert.equal(r.body.where, "team");
  // A frase manda para Usuários, e não para a lista de clientes.
  assert.match(r.body.msg, /equipe/i);
});

test("aluno JÁ MEU continua dizendo que está na minha lista", async () => {
  const { app } = monta({ existente: { _id: "p9", type: "student" }, vinculado: true });
  const r = await post(app, { name: "Ana", email: "ana@x.com" });

  assert.equal(r.body.where, "mine");
  assert.match(r.body.msg, /lista/i);
});

test("aluno de OUTRO profissional diz que existe na conta, não na minha lista", async () => {
  // Este é o caso mais escorregadio: a pessoa existe, a busca da tela não acha
  // (a lista é vinculada a quem está olhando), e "já está na sua lista" é mentira.
  const { app } = monta({ existente: { _id: "p9", type: "student" }, vinculado: false });
  const r = await post(app, { name: "Ana", email: "ana@x.com" });

  assert.equal(r.body.where, "other_professional");
  assert.match(r.body.msg, /outro profissional/i);
});
