const test = require("node:test");
const assert = require("node:assert/strict");

const userModel = require("../../model/User_model.js");
const { checkUsername, looksLikeEmail, normalizeUsername } = userModel;

// Nome de usuário: a segunda forma de entrar.
//
// A regra é apertada por UM motivo, e todo teste abaixo existe por causa dele: o
// campo de login aceita as duas coisas, então nome de usuário e e-mail não podem
// se confundir. Se `marlon.silva` fosse um nome válido, o servidor teria de
// adivinhar se aquilo é nome ou endereço mal digitado.

test.describe("o que separa nome de usuário de e-mail", () => {
  test("arroba é e-mail, sempre — mesmo escrito errado", () => {
    // Não é uma lista de domínios: qualquer coisa com arroba é TENTATIVA de
    // e-mail. Procurar "marlon@" como nome de usuário falharia por um motivo que
    // não é o verdadeiro.
    assert.equal(looksLikeEmail("marlon@gmail.com"), true);
    assert.equal(looksLikeEmail("marlon@"), true);
    assert.equal(looksLikeEmail("@marlon"), true);
    assert.equal(looksLikeEmail("marlon"), false);
  });

  test("nome de usuário não aceita arroba nem ponto", () => {
    assert.equal(checkUsername("marlon@gmail.com").reason, "at");
    assert.equal(checkUsername("marlon.silva").reason, "dot");
  });
});

test.describe("o que é aceito", () => {
  test("o caso que motivou tudo", () => {
    assert.deepEqual(checkUsername("marlon"), { ok: true, value: "marlon" });
  });

  test("maiúsculas e espaços são normalizados, não recusados", () => {
    // Quem digita "Marlon " no cadastro não errou nada. Recusar seria ensinar uma
    // regra que só existe por dentro.
    assert.equal(checkUsername("  Marlon  ").value, "marlon");
    assert.equal(checkUsername("MARLON").value, "marlon");
  });

  test("hífen e sublinhado no meio", () => {
    assert.equal(checkUsername("marlon_lima").value, "marlon_lima");
    assert.equal(checkUsername("studio-marlon").value, "studio-marlon");
    assert.equal(checkUsername("m4rl0n").value, "m4rl0n");
  });

  test("vazio é permitido — não ter nome de usuário é normal", () => {
    // A esmagadora maioria das contas não vai ter. Recusar vazio obrigaria todo
    // mundo a inventar um.
    for (const nada of ["", "   ", null, undefined]) {
      const r = checkUsername(nada);
      assert.equal(r.ok, true, JSON.stringify(nada));
      assert.equal(r.value, null, JSON.stringify(nada));
    }
  });
});

test.describe("o que é recusado, e o motivo vem junto", () => {
  test("curto demais", () => {
    // Duas letras colidem com o hábito de digitar uma letra e dar enter.
    assert.equal(checkUsername("ma").reason, "short");
  });

  test("longo demais", () => {
    assert.equal(checkUsername("m".repeat(33)).reason, "long");
  });

  test("não começa nem termina por letra ou número", () => {
    // Sem isto, `-marlon` e `marlon` seriam contas diferentes que ninguém
    // distingue de relance.
    assert.equal(checkUsername("-marlon").reason, "chars");
    assert.equal(checkUsername("marlon-").reason, "chars");
    assert.equal(checkUsername("_marlon").reason, "chars");
  });

  test("caractere que não existe na regra", () => {
    for (const ruim of ["mar lon", "marlon!", "marlón", "mar/lon"]) {
      assert.equal(checkUsername(ruim).ok, false, ruim);
    }
  });

  test("nomes reservados", () => {
    // `admin` e `suporte` porque um nome desses numa conversa faz a pessoa achar
    // que está falando com a plataforma.
    for (const nome of ["admin", "suporte", "gofitnow", "root", "backend"]) {
      assert.equal(checkUsername(nome).reason, "reserved", nome);
    }
  });

  test("o motivo é sempre um dos que a tradução conhece", () => {
    // Um motivo novo sem tradução viraria a chave crua na tela.
    const conhecidos = new Set(["at", "dot", "short", "long", "chars", "reserved"]);
    for (const ruim of ["a@b", "a.b", "ab", "m".repeat(40), "-x-", "admin", "ç"]) {
      const r = checkUsername(ruim);
      if (!r.ok) assert.ok(conhecidos.has(r.reason), `motivo desconhecido: ${r.reason} (${ruim})`);
    }
  });
});

test("normalizeUsername devolve null para vazio, não string vazia", () => {
  // Importa porque "" gravado colidiria no índice único a partir da segunda
  // conta sem nome de usuário — e a pessoa levaria erro de duplicado ao LIMPAR
  // o campo.
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername("   "), null);
  assert.equal(normalizeUsername("Marlon"), "marlon");
});

// ── Entrar pelos dois caminhos ─────────────────────────────────────────────
//
// `authenticate` recebe o que a pessoa digitou no campo único e decide sozinha se
// aquilo é e-mail ou nome de usuário. Estes casos exercitam o modelo DE VERDADE,
// com uma collection de mentira, para o despacho não passar a existir só na
// cabeça de quem leu o código.
test.describe("authenticate com e-mail ou nome de usuário", () => {
  const crypto = require("node:crypto");

  function monta() {
    const app = { crypto };
    const users = new userModel(app);

    const salt = users.generateSalt();
    const doc = {
      _id: "u1",
      name: "Marlon",
      email: "marlon.20rj@gmail.com",
      username: "marlon",
      salt,
      password: users.hashPassword("5550125", salt),
      active: 1,
    };

    const consultas = [];
    users.collection = async () => ({
      findOne: async (q) => {
        consultas.push(q);
        if (q.email !== undefined) return q.email === doc.email ? doc : null;
        if (q.username !== undefined) return q.username === doc.username ? doc : null;
        return null;
      },
    });

    return { users, consultas };
  }

  test("entra pelo nome de usuário", async () => {
    const { users, consultas } = monta();
    const u = await users.authenticate("marlon", "5550125");

    assert.equal(u?.name, "Marlon");
    assert.equal(consultas[0].username, "marlon", "tinha de procurar por username, não por email");
  });

  test("entra pelo e-mail", async () => {
    const { users, consultas } = monta();
    const u = await users.authenticate("marlon.20rj@gmail.com", "5550125");

    assert.equal(u?.name, "Marlon");
    assert.equal(consultas[0].email, "marlon.20rj@gmail.com");
  });

  test("MARLON entra — o nome não é sensível a caixa", async () => {
    const { users } = monta();
    assert.ok(await users.authenticate("  MARLON ", "5550125"));
  });

  test("senha errada não entra por nenhum dos dois", async () => {
    const { users } = monta();
    assert.equal(await users.authenticate("marlon", "errada"), undefined);
    assert.equal(await users.authenticate("marlon.20rj@gmail.com", "errada"), undefined);
  });

  test("nome que não existe não entra", async () => {
    const { users } = monta();
    assert.equal(await users.authenticate("bruna", "5550125"), undefined);
  });
});
