const test = require("node:test");
const assert = require("node:assert/strict");

const instanceContext = require("../../lib/instance.js");
const { fakeApp, call } = require("../helpers/harness.js");
const OauthController = require("../../controllers/Oauth.js");
const OauthGoogle = require("../../model/OauthGoogle_model.js");

// A VOLTA DO GOOGLE — onde um descuido vira sessão para a pessoa errada.
//
// É a rota mais exposta do sistema: ela é pública (o `instanceGate` a isenta, e
// tem de isentar), o navegador chega nela vindo de fora, e tudo o que ela recebe
// veio pela barra de endereço. Então o que estes casos guardam é uma coisa só,
// dita de várias formas: **nenhum caminho de falha pode acabar em sessão**.

const CLIENT_ID = "496976445412-abc.apps.googleusercontent.com";
const CHAVES = { ligado: true, clientId: CLIENT_ID, clientSecret: "GOCSPX-x" };

// Um `id_token` de mentira, montado como o de verdade: três partes separadas por
// ponto, com o meio em base64url. A assinatura não é conferida (ver o comentário
// em `pessoaDoIdToken`), então a terceira parte pode ser qualquer coisa.
function idToken(payload) {
  const meio = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `x.${meio}.y`;
}

function cargaBoa(extra = {}) {
  return {
    aud: CLIENT_ID,
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "bruna@exemplo.com",
    email_verified: true,
    name: "Bruna",
    ...extra,
  };
}

// `estado` é o que o bilhete carregava; `null` é bilhete que não existe mais.
function monta({ estado, carga, usuario, chaves = CHAVES, trocaExplode = false } = {}) {
  const trocas = [];
  const sessoes = [];
  const buscas = [];
  const registros = [];

  const app = fakeApp({
    api: {
      oauthGoogle: {
        async chaves() {
          return chaves;
        },
        async consumirEstado(state) {
          // Uso único de verdade: a segunda chamada com o mesmo bilhete não acha
          // nada, igual ao `findOneAndDelete` do modelo.
          if (!state || !estado || estado._gasto) return null;
          estado._gasto = true;
          return estado;
        },
        async trocarCodigo(code, ch) {
          trocas.push({ code, clientId: ch.clientId });
          if (trocaExplode) throw new Error("token 400: invalid_grant");
          return { id_token: idToken(carga || cargaBoa()) };
        },
        pessoaDoIdToken: OauthGoogle.prototype.pessoaDoIdToken,
        // O de verdade: é ele que o controlador chama, e é ele que compõe
        // "troca o código" com "lê o id_token". Um dublê aqui esconderia
        // justamente a ordem que importa.
        pessoaDoCodigo: OauthGoogle.prototype.pessoaDoCodigo,
        enderecoDeVolta: OauthGoogle.prototype.enderecoDeVolta,
        // O de verdade, e não um dublê: é ele que decide entre página e esquema
        // do app, e é justamente essa escolha que estes casos afirmam. Ele chama
        // `this.enderecoDeVolta`, que está aqui ao lado.
        urlDeVolta: OauthGoogle.prototype.urlDeVolta,
      },
      user: {
        async porEmailVerificado(email) {
          // Registra EM QUAL instância a busca rodou. É o que prova que a volta
          // usa a instância do bilhete, e não a da requisição.
          buscas.push({ email, instancia: instanceContext.current() });
          return usuario;
        },
      },
      auth: {
        async registerToken(userId) {
          sessoes.push(String(userId));
          return "sessao-nova";
        },
      },
    },
  });

  app.insertUserActionHistory = (req, user, acao, dados) => {
    registros.push({ acao, via: dados?.extra?.via, instancia: instanceContext.current() });
  };

  OauthController(app);
  return { app, trocas, sessoes, buscas, registros };
}

function volta(app, query, instanciaDaRequisicao = "outra") {
  return call(app, "get", "/auth/google/callback", { query, instance: instanciaDaRequisicao });
}

// ── O CAMINHO QUE FUNCIONA ────────────────────────────────────────────────

test("sucesso devolve para o host de origem com a sessão no FRAGMENTO", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon", origem: "treino.marlon.com.br" },
    usuario: { _id: "u1", name: "Bruna" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.status, 302);
  // Domínio próprio do cliente: o host guardado vence o subdomínio montado, senão
  // a pessoa seria jogada fora do endereço dela no meio do login.
  assert.equal(r.redirect, "https://treino.marlon.com.br/#sessao=sessao-nova");
  // `#` e não `?`: o fragmento não vai ao servidor, não entra em log de acesso e
  // não viaja no `Referer`. Um token de sessão na query vaza em cinco lugares.
  assert.ok(!r.redirect.includes("?sessao="), "a sessão foi na query, e não no fragmento");
  assert.deepEqual(sessoes, ["u1"]);
});

test("sem host guardado, monta o subdomínio pelo NOME da instância", async () => {
  const { app } = monta({ estado: { instancia: "marlon", origem: null }, usuario: { _id: "u1" } });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.redirect, "https://marlon.gofitnow.fit/#sessao=sessao-nova");
});

test("bilhete sem instância volta para o portal", async () => {
  const { app } = monta({ estado: { instancia: null, origem: null }, usuario: { _id: "u1" } });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.redirect, "https://app.gofitnow.fit/#sessao=sessao-nova");
});

// O ponto mais sutil da rota inteira.
test("a sessão nasce na instância do BILHETE, não na da requisição", async () => {
  const { app, buscas, registros } = monta({
    estado: { instancia: "marlon", origem: null },
    usuario: { _id: "u1" },
  });

  // A requisição do Google não carrega instância nenhuma; o arreio põe "outra"
  // no contexto de fora justamente para o caso de alguém passar a ler dali.
  await volta(app, { code: "cod-1", state: "est-1" }, "outra");

  assert.deepEqual(buscas, [{ email: "bruna@exemplo.com", instancia: "marlon" }]);
  // O registro de auditoria também: gravado no banco de "outra", ele contaria a
  // entrada no histórico do cliente errado.
  assert.deepEqual(registros, [{ acao: "login", via: "google", instancia: "marlon" }]);
});

// ── O APP NATIVO ──────────────────────────────────────────────────────────
//
// Um app não tem página onde aterrissar, e no iOS o navegador de autenticação só
// devolve o controle ao app quando vê o ESQUEMA próprio. Uma volta em `https://`
// deixaria a pessoa olhando o navegador com a sessão presa lá dentro, e o app na
// tela de login por baixo.

test("volta do app entrega a sessão no esquema próprio", async () => {
  const { app, sessoes } = monta({
    // `origem` preenchido de propósito: no app ele não pode vencer o destino, ou
    // a pessoa cairia no site em vez de voltar para o aplicativo.
    estado: { instancia: "marlon", origem: "treino.marlon.com.br", destino: "app" },
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.redirect, "gofitnow://entrar?sessao=sessao-nova");
  assert.deepEqual(sessoes, ["u1"]);
});

test("erro na volta do app também vai pelo esquema", async () => {
  const { app } = monta({ estado: { instancia: "marlon", destino: "app" }, usuario: undefined });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  // Em `https` a mensagem morreria no navegador, e o app nunca saberia por que
  // nada aconteceu.
  assert.equal(r.redirect, "gofitnow://entrar?erroLogin=sem_conta");
});

test("bilhete sem destino é tratado como navegador", async () => {
  // Bilhete gravado antes desta mudança existir não tem o campo. Ele não pode
  // virar `undefined://` — o caminho antigo é o padrão.
  const { app } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.redirect, "https://marlon.gofitnow.fit/#sessao=sessao-nova");
});

test("o token é escapado na volta do app", async () => {
  const { app } = monta({ estado: { destino: "app" }, usuario: { _id: "u1" } });
  app.api.auth.registerToken = async () => "tok/com+sinais==";

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  // Sem escapar, `+` chega ao app como espaço e a sessão gravada é outra — o
  // sintoma seria "entrou e caiu na tela de login".
  assert.equal(r.redirect, "gofitnow://entrar?sessao=tok%2Fcom%2Bsinais%3D%3D");
});

// ── OS CAMINHOS QUE NÃO PODEM DAR SESSÃO ──────────────────────────────────

test("e-mail sem conta nesta instância NÃO cria ninguém", async () => {
  const { app, sessoes } = monta({ estado: { instancia: "marlon" }, usuario: undefined });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /#erroLogin=sem_conta$/);
  // Achar-ou-criar aqui deixaria qualquer conta do Google nascer dentro do
  // sistema de um profissional, com um clique, no subdomínio dele.
  assert.deepEqual(sessoes, []);
});

test("id_token emitido para OUTRO app é recusado", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon" },
    carga: cargaBoa({ aud: "999-outro.apps.googleusercontent.com" }),
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  // Sem conferir o `aud`, um token que o Google emitiu legitimamente para outro
  // aplicativo entraria aqui — e o dono desse outro app entraria como qualquer
  // pessoa cujo e-mail ele conheça.
  assert.match(r.redirect, /#erroLogin=falhou$/);
  assert.deepEqual(sessoes, []);
});

test("e-mail não verificado é recusado", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon" },
    carga: cargaBoa({ email_verified: false }),
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  // Criar conta no Google com o e-mail de outra pessoa é possível; o que não é
  // possível é VERIFICÁ-LO. É essa flag que separa as duas coisas.
  assert.match(r.redirect, /#erroLogin=falhou$/);
  assert.deepEqual(sessoes, []);
});

test("id_token vencido é recusado", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon" },
    carga: cargaBoa({ exp: Math.floor(Date.now() / 1000) - 10 }),
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /#erroLogin=falhou$/);
  assert.deepEqual(sessoes, []);
});

test("emissor que não é o Google é recusado", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon" },
    carga: cargaBoa({ iss: "https://accounts.google.com.exemplo.net" }),
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /#erroLogin=falhou$/);
  assert.deepEqual(sessoes, []);
});

// ── O BILHETE ─────────────────────────────────────────────────────────────

test("volta sem bilhete válido não chega a falar com o Google", async () => {
  const { app, trocas, sessoes } = monta({ estado: null });

  const r = await volta(app, { code: "cod-1", state: "nao-existe" });

  assert.equal(r.redirect, "https://app.gofitnow.fit/#erroLogin=expirou");
  // Gastar o bilhete primeiro é o que faz uma volta repetida sair barata: sem
  // isto, cada F5 numa URL velha viraria uma chamada ao Google.
  assert.deepEqual(trocas, []);
  assert.deepEqual(sessoes, []);
});

test("o mesmo bilhete não serve duas vezes", async () => {
  const { app, sessoes } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  const primeira = await volta(app, { code: "cod-1", state: "est-1" });
  const segunda = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(primeira.redirect, /#sessao=/);
  // A segunda volta com a mesma URL — F5, botão "voltar", link colado — não pode
  // render uma sessão nova.
  assert.match(segunda.redirect, /#erroLogin=expirou$/);
  assert.deepEqual(sessoes, ["u1"]);
});

test("quem cancelou na tela do Google volta quieto, sem erro de falha", async () => {
  const { app, trocas } = monta({ estado: { instancia: "marlon", origem: null } });

  const r = await volta(app, { error: "access_denied", state: "est-1" });

  // Cancelar não é defeito, e "algo deu errado" para quem desistiu de propósito
  // é uma mensagem que só confunde.
  assert.equal(r.redirect, "https://marlon.gofitnow.fit/#erroLogin=recusado");
  assert.deepEqual(trocas, []);
});

test("volta sem code e sem erro não vira sessão", async () => {
  const { app, sessoes } = monta({ estado: { instancia: "marlon", origem: null } });

  const r = await volta(app, { state: "est-1" });

  assert.match(r.redirect, /#erroLogin=falhou$/);
  assert.deepEqual(sessoes, []);
});

test("o Google recusando a troca do código não vira sessão", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon", origem: null },
    usuario: { _id: "u1" },
    trocaExplode: true,
  });

  const r = await volta(app, { code: "usado-ja", state: "est-1" });

  assert.match(r.redirect, /#erroLogin=falhou$/);
  assert.deepEqual(sessoes, []);
});

test("chave apagada na central no meio do caminho não vira sessão", async () => {
  const { app, sessoes, trocas } = monta({
    estado: { instancia: "marlon", origem: null },
    chaves: { ligado: false, clientId: "", clientSecret: "" },
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /#erroLogin=desligado$/);
  // Sem chave não há com que trocar o código — e tentar mandaria `client_id`
  // vazio para o Google, cujo erro não diz que a chave foi apagada aqui.
  assert.deepEqual(trocas, []);
  assert.deepEqual(sessoes, []);
});
