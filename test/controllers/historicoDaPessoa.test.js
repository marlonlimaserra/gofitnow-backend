const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const ActionHistory = require("../../model/ActionHistory_model.js");

// A LINHA DO TEMPO DE UMA PESSOA.
//
// *"de baixo de documentos de alunos, crie um chamado histórico, quero ver ali
// TUDO que foi feito nesse aluno, paginado, separado por categoria... quando
// editar o aluno, salve os dados antigo e o novo do que foi alterado, quando
// mexer em qualquer coisa dele, financeiro etc... precisa salvar quem fez, a
// onde fez, ip da pessoa que fez"* (25/09/2026).
//
// ── NÃO NASCEU UMA COLLECTION NOVA ───────────────────────────────────────
//
// `user_action_history` já fazia quase tudo: quem, quando, IP, user-agent, rota
// e o diff campo a campo. O que faltava era dizer DE QUEM é a linha — o `target`
// diz "o que foi mexido" (um treino, uma cobrança), e juntar pelo dono exigiria
// buscar antes todos os ids que pertencem à pessoa.
//
// Estes casos seguram as três coisas que quebram calado: o dono gravado, a
// busca que acha o que é dele, e o segredo que não pode entrar.
function fakeModel() {
  const gravados = [];
  const modelo = new ActionHistory({});
  modelo.collection = async () => ({
    async insertOne(doc) {
      gravados.push(doc);
      return { insertedId: "h1" };
    },
    find(query) {
      gravados.consulta = query;
      return { sort: () => ({ skip: () => ({ limit: () => ({ async toArray() { return []; } }) }) }) };
    },
    async countDocuments() {
      return 0;
    },
  });
  return { modelo, gravados };
}

const req = {
  headers: { "user-agent": "Chrome", "x-forwarded-for": "201.17.8.9" },
  method: "PUT",
  originalUrl: "/people/p1",
};

const quem = { _id: "6512f1c0c0c0c0c0c0c0c0aa", name: "Marlon", email: "marlon@exemplo.com" };

test("grava QUEM fez, de onde, por qual rota e de qual IP", async () => {
  // As quatro coisas que ele listou. Nenhuma é derivável depois: o IP some com
  // a requisição, e o nome de quem fez tem de sobreviver à conta ser apagada.
  const { modelo, gravados } = fakeModel();

  await modelo.record(req, quem, "update_person", {
    category: "people",
    local: { target_type: "people", target_id: "p1", person: "6512f1c0c0c0c0c0c0c0c0c1" },
  });

  const doc = gravados[0];

  assert.equal(doc.userName, "Marlon");
  assert.equal(doc.userEmail, "marlon@exemplo.com");
  assert.equal(doc.ip, "201.17.8.9");
  assert.equal(doc.userAgent, "Chrome");
  assert.equal(doc.method, "PUT");
  assert.equal(doc.url, "/people/p1");
  assert.ok(doc.createdAt instanceof Date);
});

test("o DONO da linha é gravado como ObjectId — é por ele que a ficha busca", async () => {
  const { modelo, gravados } = fakeModel();
  const pessoa = "6512f1c0c0c0c0c0c0c0c0c1";

  await modelo.record(req, quem, "create_workout", {
    category: "workouts",
    local: { target_type: "workouts", target_id: "w9", person: pessoa },
  });

  assert.ok(gravados[0].pessoa instanceof ObjectId);
  assert.equal(String(gravados[0].pessoa), pessoa);
  // E o alvo continua sendo o treino: são perguntas diferentes.
  assert.equal(gravados[0].target.id, "w9");
});

test("sem dono, `pessoa` é nulo — e não o id do alvo", async () => {
  // Configuração da conta, fornecedor, login: a maioria das linhas não é de
  // ninguém, e o índice é `sparse` por causa disso.
  const { modelo, gravados } = fakeModel();

  await modelo.record(req, quem, "update_theme", {
    category: "admin",
    local: { target_type: "tenants", target_id: "t1" },
  });

  assert.equal(gravados[0].pessoa, null);
});

test("um id inválido não vira dono — nem derruba o registro", async () => {
  const { modelo, gravados } = fakeModel();

  await modelo.record(req, quem, "x", { local: { person: "lixo" } });

  assert.equal(gravados[0].pessoa, null);
});

test("o DIFF guarda o antes e o depois, só do que mudou", async () => {
  // *"salve os dados antigo e o novo do que foi alterado"*. Só do que mudou:
  // um antes/depois inteiro dobraria a collection para nada.
  const { modelo } = fakeModel();

  const mudou = modelo.diff(
    { name: "Ana", phone: "1199", goal: "Hipertrofia" },
    { name: "Ana Souza", phone: "1199", goal: "Hipertrofia" }
  );

  assert.deepEqual(mudou, { name: { from: "Ana", to: "Ana Souza" } });
});

test("senha NUNCA entra, nem dentro do diff", async () => {
  // Uma edição de pessoa carregaria o hash direto para uma collection feita
  // para ser lida.
  const { modelo, gravados } = fakeModel();

  const mudou = modelo.diff(
    { password: "hash-velho", salt: "s1", name: "Ana" },
    { password: "hash-novo", salt: "s2", name: "Ana" }
  );
  assert.deepEqual(mudou, {}, "senha e salt ficam fora do diff");

  await modelo.record(req, quem, "update_person", {
    local: { person: "6512f1c0c0c0c0c0c0c0c0c1" },
    extra: { dados: { password: "hash", token: "t", name: "Ana" } },
  });

  assert.equal(gravados[0].details.dados.password, "[oculto]");
  assert.equal(gravados[0].details.dados.token, "[oculto]");
  assert.equal(gravados[0].details.dados.name, "Ana");
});

test("a busca da ficha acha o que é DELA e o que é DELE", async () => {
  // O cadastro editado (alvo = a pessoa) e o treino trocado (dono = a pessoa)
  // são a mesma história, e a ficha mostra as duas.
  const { modelo, gravados } = fakeModel();
  const pessoa = "6512f1c0c0c0c0c0c0c0c0c1";

  await modelo.list({ person: pessoa });

  const ou = gravados.consulta.$and[0].$or;
  assert.equal(String(ou[0].pessoa), pessoa);
  // E as linhas gravadas ANTES de `pessoa` existir continuam aparecendo pelo
  // alvo — senão a ficha nasceria vazia num sistema que já roda há meses.
  assert.deepEqual(ou[1], { "target.type": "people", "target.id": pessoa });
});

test("a ficha pede só o que ALTERA — a leitura fica de fora", async () => {
  // *"chamadas GET, tipo abriu uma ficha, tá aparecendo um monte; essa GET que
  // não acontece nada não precisa ficar no histórico"* (25/09/2026). Abrir a
  // ficha dez vezes num dia empurra para baixo a única linha que interessa.
  const { modelo, gravados } = fakeModel();

  await modelo.list({ person: "6512f1c0c0c0c0c0c0c0c0c1", somenteAlteracoes: true });

  assert.deepEqual(gravados.consulta.method, { $nin: ["GET", "HEAD", "OPTIONS"] });
});

test("sem pedir, o corte não acontece — a tela de Logs vê tudo", async () => {
  // Lá "quem andou abrindo a ficha de quem" é exatamente a pergunta, e é o que
  // uma auditoria de acesso precisa responder.
  const { modelo, gravados } = fakeModel();

  await modelo.list({ person: "6512f1c0c0c0c0c0c0c0c0c1" });

  assert.equal(gravados.consulta.method, undefined);
});

test("um registro que falha NÃO derruba a requisição", async () => {
  // A ação já aconteceu; recusá-la por causa do log seria desfazer o que deu
  // certo.
  const modelo = new ActionHistory({});
  modelo.collection = async () => {
    throw new Error("banco fora");
  };

  const r = await modelo.record(req, quem, "x", {});
  assert.equal(r.success, false);
});
