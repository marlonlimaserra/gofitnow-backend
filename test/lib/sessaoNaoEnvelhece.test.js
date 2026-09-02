const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// TODA ESCRITA EM `users` TEM DE LIMPAR A SESSÃO GUARDADA.
//
// ── Por que este teste existe ─────────────────────────────────────────────
//
// O Marlon, ao ver o cache de sessão entrar: *"tenho certeza que alguém vai
// mexer nas preferências, vai dar F5, não vão se manter; alguém vai editar o
// usuário etc… alguma coisa vai acontecer"*.
//
// Ele estava certo, e o problema era pior do que a lista dele. `User_model.filter`
// só tira senha e sal — o objeto guardado é o DOCUMENTO INTEIRO do usuário. Então
// não são "algumas" escritas que envelhecem o cache: são TODAS.
//
// A auditoria por campo achou CINCO caminhos sem limpeza, incluindo os dois que
// ele citou de cabeça:
//
//   savePreferences       ← "mexe nas preferências, dá F5, não se mantém"
//   updateTrainer         ← "alguém vai editar o usuário"
//   deleteTrainer
//   deleteStudent
//   revokeStudentAccess   ← e este era de SEGURANÇA: revogar demoraria um minuto
//
// ── Por que um teste que lê o CÓDIGO ──────────────────────────────────────
//
// Consertar os cinco não impede o sexto. Uma função nova que escreva em `users`
// e esqueça a limpeza não quebra teste nenhum — ela só faz a tela mostrar dado
// velho, às vezes, por até um minuto. É o defeito que ninguém reporta e ninguém
// reproduz.
//
// Então o teste não confia numa lista escrita à mão: ele VARRE o modelo atrás de
// escritas e exige que cada função que escreve limpe. É o mesmo desenho do
// `dbRouting.test.js`, que exige declaração para usar o banco cru.

const modelo = fs.readFileSync(
  path.join(__dirname, "..", "..", "model", "User_model.js"),
  "utf8"
);

const linhas = modelo.split("\n");

// A função a que uma linha pertence.
function funcaoDe(indice) {
  for (let i = indice; i >= 0; i--) {
    const m = /^User_model\.prototype\.(\w+) = /.exec(linhas[i]);
    if (m) return { nome: m[1], inicio: i };
  }
  return null;
}

// Uma escrita é o que MUDA o documento de alguém. `findOne`, `countDocuments` e
// `aggregate` não entram.
const ESCRITA = /\.(updateOne|updateMany|deleteOne|deleteMany|replaceOne|findOneAndUpdate|bulkWrite)\(/;

// ── AS EXCEÇÕES, e cada uma com o motivo escrito ──────────────────────────
//
// Escrever aqui é declarar em voz alta que aquela função não precisa limpar. Se
// o motivo não couber numa linha, provavelmente ela precisa.
const DISPENSADAS = {
  // Cria um usuário: ninguém tem sessão de quem acabou de nascer.
  insert: "cria — não há sessão anterior",
  insertStudent: "cria — não há sessão anterior",
  insertTrainer: "cria — não há sessão anterior",
};

test("toda função que escreve em users limpa a sessão guardada", () => {
  const semLimpeza = [];
  const vistas = new Set();

  linhas.forEach((linha, i) => {
    if (!ESCRITA.test(linha)) return;

    const fn = funcaoDe(i);
    if (!fn || vistas.has(fn.nome)) return;
    vistas.add(fn.nome);

    if (DISPENSADAS[fn.nome]) return;

    // O corpo da função, do início dela até a escrita.
    const corpo = linhas.slice(fn.inicio, i + 1).join("\n");
    if (!corpo.includes("sessaoGuardada.esquecerUsuario")) semLimpeza.push(fn.nome);
  });

  assert.deepEqual(
    semLimpeza,
    [],
    "escreve em users e não limpa o cache — a tela vai mostrar dado velho por até um minuto"
  );
});

test("a varredura está mesmo achando as funções", () => {
  // Um teste que não acha nada passa sempre. Este confere que a varredura
  // enxerga o que se sabe que existe — senão o de cima seria decorativo.
  const achadas = [];
  const vistas = new Set();

  linhas.forEach((linha, i) => {
    if (!ESCRITA.test(linha)) return;
    const fn = funcaoDe(i);
    if (fn && !vistas.has(fn.nome)) {
      vistas.add(fn.nome);
      achadas.push(fn.nome);
    }
  });

  for (const esperada of ["updateAny", "savePreferences", "revokeStudentAccess", "updateSelf"]) {
    assert.ok(achadas.includes(esperada), `a varredura não enxergou ${esperada}`);
  }
  assert.ok(achadas.length >= 8, `só ${achadas.length} funções de escrita? a varredura quebrou`);
});

test("as dispensadas são só as que CRIAM", () => {
  // A lista de exceções é onde um buraco se esconde legitimamente. Ela não pode
  // crescer para acomodar uma função que simplesmente esqueceu de limpar.
  for (const nome of Object.keys(DISPENSADAS)) {
    assert.match(nome, /^insert/, `${nome} não é uma criação — por que está dispensada?`);
  }
});

test("mudar o PAPEL limpa mesmo quando só o nome muda", () => {
  // O objeto guardado carrega `roleName`. Renomear "Recepção" para "Atendimento"
  // deixaria o nome velho na tela por um minuto — e a primeira versão só limpava
  // quando as PERMISSÕES mudavam.
  const role = fs
    .readFileSync(path.join(__dirname, "..", "..", "model", "Role_model.js"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  const corpo = role.slice(
    role.indexOf("Role_model.prototype.update = async function"),
    role.indexOf("async function esquecerQuemTemOPapel")
  );

  assert.match(corpo, /await esquecerQuemTemOPapel\(/);
  assert.doesNotMatch(
    corpo,
    /if \(obj\.permissions !== undefined\) await esquecerQuemTemOPapel/,
    "limpar só quando as permissões mudam deixa o nome do papel velho na tela"
  );
});
