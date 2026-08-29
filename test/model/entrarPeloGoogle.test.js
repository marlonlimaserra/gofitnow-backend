const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const userModel = require("../../model/User_model.js");

// QUEM pode entrar pelo Google.
//
// A prova de identidade é outra — o Google já disse quem é —, mas a lista de
// contas RECUSADAS tem de ser a mesma do login por senha. Enquanto essas recusas
// eram dois `if` dentro de `authenticate`, o caminho do Google nasceria sem elas,
// e entrar pelo Google seria justamente o jeito de furar o "acesso ainda não
// liberado".
//
// É por isso que estes casos exercitam os DOIS caminhos com o mesmo documento:
// se um dia um deles passar a aceitar o que o outro recusa, cai aqui.
function monta(alteracoes = {}) {
  const users = new userModel({ crypto });

  const salt = users.generateSalt();
  const doc = {
    _id: "u1",
    name: "Bruna",
    email: "bruna@exemplo.com",
    salt,
    password: users.hashPassword("senha-boa", salt),
    active: 1,
    ...alteracoes,
  };

  const consultas = [];
  users.collection = async () => ({
    findOne: async (q) => {
      consultas.push(q);
      if (q.email !== undefined) return q.email === doc.email ? doc : null;
      if (q.username !== undefined) return null;
      return null;
    },
  });

  return { users, consultas };
}

test("conta boa entra pelos dois caminhos", async () => {
  const { users, consultas } = monta();

  assert.equal((await users.porEmailVerificado("bruna@exemplo.com"))?.name, "Bruna");
  assert.ok(await users.authenticate("bruna@exemplo.com", "senha-boa"));
  assert.equal(consultas[0].email, "bruna@exemplo.com");
});

test("e-mail é normalizado — MAIÚSCULA com espaço entra", async () => {
  const { users } = monta();

  // O Google devolve o e-mail como está na conta dele, que não é
  // necessariamente como está gravado aqui.
  assert.ok(await users.porEmailVerificado("  BRUNA@Exemplo.com "));
});

test("conta DESATIVADA não entra por nenhum dos dois", async () => {
  const { users } = monta({ active: 0 });

  assert.equal(await users.porEmailVerificado("bruna@exemplo.com"), undefined);
  assert.equal(await users.authenticate("bruna@exemplo.com", "senha-boa"), undefined);
});

test("perfil SEM acesso concedido não entra pelo Google", async () => {
  // O caso que o desenho tem de proteger: ficha de aluno/paciente que o
  // profissional criou e ainda não liberou. Ela não tem senha — e um caminho de
  // login que dispensa senha entraria exatamente por essa porta.
  const { users } = monta({ password: undefined, salt: undefined });

  assert.equal(await users.porEmailVerificado("bruna@exemplo.com"), undefined);
});

test("conta com salt sem senha também é recusada", async () => {
  // Metade do par é o estado que aparece em conta pela metade — e `hashPassword`
  // contra `undefined` não compara nada.
  const { users } = monta({ password: undefined });

  assert.equal(await users.porEmailVerificado("bruna@exemplo.com"), undefined);
});

test("e-mail que não existe não entra — e NÃO cria ninguém", async () => {
  const { users } = monta();

  assert.equal(await users.porEmailVerificado("ninguem@exemplo.com"), undefined);
});

test("nome de usuário NÃO serve para entrar pelo Google", async () => {
  const { users, consultas } = monta({ username: "bruna" });

  // `authenticate` aceita e-mail ou nome de usuário, porque o campo de login é
  // um só. Aqui o que chega é sempre e-mail, vindo do provedor — procurar por
  // nome de usuário deixaria alguém entrar com um "e-mail" que casa com o
  // apelido de outra pessoa.
  assert.equal(await users.porEmailVerificado("bruna"), undefined);
  for (const q of consultas) assert.equal(q.username, undefined);
});

test("podeEntrar sozinho: nada de nulo passa", () => {
  const { users } = monta();

  assert.equal(users.podeEntrar(undefined), false);
  assert.equal(users.podeEntrar(null), false);
  assert.equal(users.podeEntrar({}), false);
});
