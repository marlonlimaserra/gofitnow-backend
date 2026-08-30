const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sessaoGuardada = require("../../lib/sessaoGuardada.js");
const instanceContext = require("../../lib/instance.js");

// A SESSÃO GUARDADA POR UM MINUTO.
//
// Três idas ao Mongo por requisição (sessão, usuário, papel) viram uma leitura no
// Redis. Medido: 1,7 ms contra 0,14 ms.
//
// O risco é conhecido e é o que estes testes cercam: enquanto a sessão está
// guardada, o sistema está respondendo com uma FOTO do passado. Se o logout, a
// troca de papel ou a desativação de conta não apagarem essa foto, uma sessão
// revogada continua valendo — e não há erro em lugar nenhum para avisar.

const raiz = path.join(__dirname, "..", "..");
const ler = (rel) => fs.readFileSync(path.join(raiz, rel), "utf8");

test("o prazo é curto — ele é o TETO do estrago", () => {
  // Tudo que este cache pode errar dura no máximo o prazo. Sessenta segundos
  // economiza quase tudo que dez minutos economizariam (as requisições vêm em
  // rajada) e custa sessenta vezes menos no pior caso.
  assert.ok(sessaoGuardada.PRAZO_MS <= 60 * 1000, "prazo longo demais para um cache de sessão");
});

test("a chave leva a INSTÂNCIA e o TOKEN", () => {
  // A instância porque o mesmo texto de token em dois clientes não pode colidir
  // — seria entrar na conta de outra casa. O token porque é ele que o logout
  // apaga, e tê-lo na chave é o que torna a limpeza exata em vez de uma varredura.
  const chave = sessaoGuardada.chaveDoToken("bruna", "abc123");

  assert.ok(chave.includes("bruna"));
  assert.ok(chave.includes("abc123"));
  assert.notEqual(chave, sessaoGuardada.chaveDoToken("will", "abc123"));
});

test("sem Redis, ela some do caminho", async () => {
  // `REDIS_URL` não existe em teste. Ler devolve `null` — "não sei" — e quem
  // chama vai ao banco como sempre foi.
  await instanceContext.run("bruna", async () => {
    assert.equal(await sessaoGuardada.ler("qualquer"), null);
    assert.doesNotThrow(() => sessaoGuardada.guardar("t", { _id: "1" }));
    await sessaoGuardada.esquecerToken("t");
    await sessaoGuardada.esquecerUsuario("1");
  });
});

test("fora de uma requisição, não guarda nada", async () => {
  // Sem instância no contexto não há como montar a chave — e uma chave sem
  // cliente seria a sessão de um valendo para outro.
  assert.equal(await sessaoGuardada.ler("token"), null);
});

// ── OS PONTOS DE LIMPEZA, conferidos no CÓDIGO ────────────────────────────
//
// Não dá para exercitá-los sem Mongo e sem Redis, mas dá para exigir que a
// chamada exista onde ela precisa existir. É o que impede alguém de mexer nesses
// modelos amanhã e deixar um caminho sem limpeza.

test("apagar um token apaga o cache dele", () => {
  const auth = ler("model/Auth_model.js");
  const trecho = auth.slice(auth.indexOf("prototype.deleteToken"), auth.indexOf("prototype.deleteAllTokensByUser"));
  assert.match(trecho, /sessaoGuardada\.esquecerToken/);
});

test("derrubar todas as sessões de alguém apaga o cache dele", () => {
  const auth = ler("model/Auth_model.js");
  const trecho = auth.slice(auth.indexOf("prototype.deleteAllTokensByUser"));
  assert.match(trecho, /sessaoGuardada\.esquecerUsuario/);
});

test("TODA escrita em usuário limpa a sessão guardada", () => {
  // São quatro caminhos, e é aqui que mora o caso que mais importa: desativar
  // uma conta não pode demorar um minuto para valer.
  const user = ler("model/User_model.js");

  for (const fn of ["updateStudent", "updateSelf", "updateAny", "deleteAny"]) {
    const i = user.indexOf(`User_model.prototype.${fn} = async function`);
    assert.notEqual(i, -1, `${fn} sumiu`);

    // A limpeza tem de estar nas primeiras linhas da função, não perdida no fim
    // depois de um `return` antecipado.
    const inicio = user.slice(i, i + 400);
    assert.match(inicio, /sessaoGuardada\.esquecerUsuario/, `${fn} não limpa a sessão`);
  }
});

test("mudar as PERMISSÕES de um papel limpa todo mundo que o tem", () => {
  // O caso que mais engana: apagar a sessão de um usuário não basta. Tirar uma
  // permissão de "Recepção" tem de valer agora para as cinco pessoas que são
  // recepção.
  const role = semComentarios(ler("model/Role_model.js"));

  // A CHAMADA, dentro do `update` — e não só a função existindo no arquivo.
  //
  // A primeira versão deste teste conferia só a existência, e a mutação passou:
  // apaguei a linha que chama e os dez testes continuaram verdes. Função
  // definida e nunca chamada é o defeito mais fácil de deixar passar.
  const inicio = role.indexOf("Role_model.prototype.update = async function");
  const fim = role.indexOf("async function esquecerQuemTemOPapel");
  assert.ok(inicio > 0 && fim > inicio, "o update ou o ajudante mudaram de lugar");

  const corpo = role.slice(inicio, fim);
  assert.match(corpo, /await esquecerQuemTemOPapel\(/, "o update não chama a limpeza");

  // E ela alcança TODOS os donos do papel, não um só.
  assert.match(role, /find\(\{ role: new ObjectId\(roleId\) \}/);
});

// Os COMENTÁRIOS saem antes de medir ordem. Eles citam os mesmos nomes que o
// código — este arquivo explica que "o acerto pula o authSession.protect" —, e
// sem tirá-los o teste mede o texto da explicação em vez da linha que roda. Foi
// o que ele fez na primeira vez que rodou.
const semComentarios = (texto) =>
  texto
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

test("o cache é lido ANTES do banco, e escrito DEPOIS da conferência", () => {
  const req = semComentarios(ler("helper/ReqProtected.js"));

  const leitura = req.indexOf("sessaoGuardada.ler");
  const banco = req.indexOf("authSession.protect");
  const escrita = req.indexOf("sessaoGuardada.guardar");
  const conferencia = req.indexOf("user.active === 0");

  // Ler DEPOIS do banco economizaria só dois terços do caminho: a busca da
  // sessão pelo token é a primeira das três idas ao Mongo.
  assert.ok(leitura > 0 && leitura < banco, "a leitura do cache tem de vir antes do banco");

  // E só entra no cache a sessão que passou pela conferência inteira, inclusive
  // o teste de conta desativada.
  assert.ok(conferencia > 0 && conferencia < escrita, "guardou antes de conferir");
});

test("o que entra no cache NÃO tem senha", () => {
  // O objeto guardado é o MESMO que a rota recebe — já passado por
  // `User_model.filter`. Guardar o documento cru do Mongo poria o hash da senha
  // num segundo lugar, e num que é mais fácil de ler que o banco.
  const req = semComentarios(ler("helper/ReqProtected.js"));

  assert.match(req, /sessaoGuardada\.guardar\(session\.token, req\._user\)/);

  // E nunca o documento cru: `user` é o que saiu do banco, `req._user` é o
  // filtrado.
  assert.doesNotMatch(req, /sessaoGuardada\.guardar\([^,]+,\s*user\)/);
});
