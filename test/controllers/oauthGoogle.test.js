const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const OauthController = require("../../controllers/Oauth.js");
const OauthGoogle = require("../../model/OauthGoogle_model.js");
const OauthFacebook = require("../../model/OauthFacebook_model.js");

// ENTRAR COM O GOOGLE — o link de ida.
//
// O que estes casos guardam é o que faz a diferença entre um botão que funciona e
// um que manda a pessoa para uma tela de erro do Google: o link sair com a chave
// ATUAL, o `state` valer uma vez só, e "desligado" não ser tratado como falha.

const INSTANCIA = "marlon";

function monta({ chaves, criarEstado, explode = false } = {}) {
  const estadosCriados = [];

  const app = fakeApp({
    api: {
      // O Facebook existe no dublê porque `/public/social` pergunta a TODOS os
      // provedores. Sem ele, a rota estouraria em `undefined.chaves()` e o teste
      // culparia o Google.
      oauthFacebook: {
        async chaves() {
          return { ligado: false, clientId: "", clientSecret: "" };
        },
      },
      oauthGoogle: {
        async chaves() {
          if (explode) throw new Error("central fora do ar");
          return chaves;
        },
        async criarEstado(instancia) {
          estadosCriados.push(instancia);
          return criarEstado || "est-1";
        },
        urlDeAutorizacao: OauthGoogle.prototype.urlDeAutorizacao,
        // `urlDeAutorizacao` monta o `redirect_uri` chamando `this.callback()`,
        // que vem da herança e depende de `PROVEDOR`. Sem os dois aqui, o dublê
        // produziria `redirect_uri=undefined` e o teste culparia a URL.
        callback: OauthGoogle.prototype.callback,
        PROVEDOR: "google",
      },
    },
  });

  OauthController(app);
  return { app, estadosCriados };
}

const LIGADO = { ligado: true, clientId: "496976445412-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-x" };

test("desligado é resposta, e não falha", async () => {
  const { app, estadosCriados } = monta({ chaves: { ligado: false, clientId: "", clientSecret: "" } });

  const r = await call(app, "get", "/auth/google/url", { instance: INSTANCIA });

  // 200 e `ligado: false`. Um 404 aqui faria a tela de entrada mostrar aviso de
  // falha para quem simplesmente não usa Google.
  assert.equal(r.status, 200);
  assert.equal(r.body.ligado, false);
  assert.equal(r.body.url, undefined);
  // E nenhum bilhete é emitido: um `state` por visita de tela em quem não usa o
  // recurso é lixo com TTL, e esconde o custo de verdade quando alguém for medir.
  assert.deepEqual(estadosCriados, []);
});

test("ligado devolve o link com a chave atual e um state", async () => {
  const { app, estadosCriados } = monta({ chaves: LIGADO, criarEstado: "est-abc" });

  const r = await call(app, "get", "/auth/google/url", { instance: INSTANCIA });

  assert.equal(r.body.ligado, true);
  const u = new URL(r.body.url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), LIGADO.clientId);
  assert.equal(u.searchParams.get("state"), "est-abc");
  assert.equal(u.searchParams.get("response_type"), "code");
  // O mínimo para saber QUEM entrou. Escopo além disto joga o app na fila de
  // verificação do Google, que leva semanas.
  assert.equal(u.searchParams.get("scope"), "openid email profile");
  // Sem isto, quem está logado em duas contas do Google entra com a última que
  // usou, em silêncio, e não entende com que conta entrou.
  assert.equal(u.searchParams.get("prompt"), "select_account");

  // O `state` carrega a instância que o `instanceGate` já conferiu.
  assert.deepEqual(estadosCriados, [INSTANCIA]);
});

// O Google recusa com `redirect_uri_mismatch` se um caractere divergir, e o erro
// não diz qual dos dois lados está errado.
test("o redirect_uri é o do backend, e não o subdomínio de quem chamou", async () => {
  const { app } = monta({ chaves: LIGADO });

  const r = await call(app, "get", "/auth/google/url", { instance: INSTANCIA });

  const uri = new URL(r.body.url).searchParams.get("redirect_uri");
  assert.equal(uri, OauthGoogle.CALLBACK);
  // O curinga é o motivo: o subdomínio de cada profissional não pode ser
  // cadastrado no console — os que ainda não existem, então, nunca.
  assert.ok(!uri.includes(INSTANCIA));
});

test("central fora do ar não derruba a tela de entrada", async () => {
  const { app } = monta({ explode: true });

  const r = await call(app, "get", "/auth/google/url", { instance: INSTANCIA });

  // Sem link o botão do Google não aparece, e o login por e-mail e senha segue
  // de pé. Um 500 aqui apagaria a tela inteira por causa de um botão.
  assert.equal(r.status, 200);
  assert.equal(r.body.ligado, false);
});

// ── QUAIS ENTRADAS EXISTEM ────────────────────────────────────────────────
//
// Rota pública e SEM instância, porque o app precisa desenhar a tela de entrada
// antes de saber de qual cliente a pessoa é.

test("diz quais entradas sociais existem, sem exigir instância", async () => {
  const { app } = monta({ chaves: LIGADO });

  const r = await call(app, "get", "/public/social", { instance: null });

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { google: true, facebook: false, apple: false });
});

test("não devolve chave nenhuma — só quais portas estão abertas", async () => {
  const { app } = monta({ chaves: LIGADO });

  const r = await call(app, "get", "/public/social", { instance: null });

  const texto = JSON.stringify(r.body);
  assert.ok(!texto.includes(LIGADO.clientId), "o ID do cliente vazou numa rota pública");
  assert.ok(!texto.includes(LIGADO.clientSecret), "A CHAVE SECRETA VAZOU numa rota pública");
});

test("os provedores que ainda não existem vêm como FALSO, não ausentes", async () => {
  const { app } = monta({ chaves: { ligado: false, clientId: "", clientSecret: "" } });

  const r = await call(app, "get", "/public/social", { instance: null });

  // Ausentes, o app teria de adivinhar a forma da resposta quando eles
  // chegarem. Declarados falsos, o botão nasce escondido e acende sozinho.
  assert.deepEqual(r.body, { google: false, facebook: false, apple: false });
});

test("central fora do ar não derruba a tela de entrada do app", async () => {
  const { app } = monta({ explode: true });

  const r = await call(app, "get", "/public/social", { instance: null });

  assert.equal(r.status, 200);
  assert.equal(r.body.google, false);
});

// ── AS CHAVES ─────────────────────────────────────────────────────────────

function modeloComSettings(docs) {
  const m = new OauthGoogle({
    mongodb: {
      async centralDb() {
        return {
          collection() {
            return {
              find() {
                return { async toArray() { return docs; } };
              },
            };
          },
        };
      },
    },
  });
  return m;
}

test("ligado sem o par completo é DESLIGADO", async () => {
  // O caso que engana: alguém marca o interruptor, salva, e sai sem colar a
  // chave. Se isto devolvesse `ligado: true`, o botão apareceria na tela do
  // cliente e o Google recusaria — e o defeito pareceria ser do botão.
  const semSegredo = await modeloComSettings([
    { key: "oauth.google.enabled", value: true },
    { key: "oauth.google.clientId", value: "123-abc.apps.googleusercontent.com" },
  ]).chaves();
  assert.equal(semSegredo.ligado, false);

  const semId = await modeloComSettings([
    { key: "oauth.google.enabled", value: true },
    { key: "oauth.google.clientSecret", value: "GOCSPX-x" },
  ]).chaves();
  assert.equal(semId.ligado, false);

  const completo = await modeloComSettings([
    { key: "oauth.google.enabled", value: true },
    { key: "oauth.google.clientId", value: "123-abc.apps.googleusercontent.com" },
    { key: "oauth.google.clientSecret", value: "GOCSPX-x" },
  ]).chaves();
  assert.equal(completo.ligado, true);
});

test("par completo com o interruptor desligado continua desligado", async () => {
  // O interruptor é separado da chave de propósito: desligar apagando a chave
  // obrigaria a redigitar o segredo para ligar de novo.
  const r = await modeloComSettings([
    { key: "oauth.google.enabled", value: false },
    { key: "oauth.google.clientId", value: "123-abc.apps.googleusercontent.com" },
    { key: "oauth.google.clientSecret", value: "GOCSPX-x" },
  ]).chaves();
  assert.equal(r.ligado, false);
});

test("banco fora do ar devolve desligado, e não estoura", async () => {
  const m = new OauthGoogle({
    mongodb: {
      async centralDb() {
        throw new Error("sem conexão");
      },
    },
  });

  const r = await m.chaves();
  assert.equal(r.ligado, false);
  assert.equal(r.clientId, "");
});

// ── O BILHETE ─────────────────────────────────────────────────────────────

// `donos` diz de quem é cada host, como o registro responderia.
function modeloComEstados(donos = {}, registroExplode = false) {
  const guardados = [];
  let apagou = null;

  const m = new OauthGoogle({
    uuidv4: () => "est-novo",
    api: {
      center: {
        async instanceForHost(host) {
          if (registroExplode) throw new Error("registro fora do ar");
          return donos[host] || "";
        },
      },
    },
    mongodb: {
      async centralDb() {
        return {
          collection() {
            return {
              async createIndex() {},
              async insertOne(doc) {
                guardados.push(doc);
              },
              async findOneAndDelete(filtro) {
                apagou = filtro.state;
                // O filtro tem DOIS campos, e o dublê honra os dois. Ignorar o
                // provedor faria a asserção "bilhete de um não serve no outro"
                // passar por engano — o `CONTINUAR.md` tem essa lição escrita.
                const i = guardados.findIndex(
                  (g) => g.state === filtro.state && g.provedor === filtro.provedor
                );
                if (i < 0) return null;
                return guardados.splice(i, 1)[0];
              },
            };
          },
        };
      },
    },
  });

  return { m, guardados, apagouComo: () => apagou };
}

test("o bilhete guarda a instância, e vale UMA vez", async () => {
  const { m, guardados } = modeloComEstados();

  const state = await m.criarEstado("marlon");
  assert.equal(state, "est-novo");
  assert.equal(guardados[0].instancia, "marlon");
  assert.ok(guardados[0].createdAt instanceof Date, "sem createdAt o TTL não apaga nada");

  const primeira = await m.consumirEstado(state);
  assert.equal(primeira.instancia, "marlon");

  // A segunda volta com o mesmo bilhete não vale. Sem isto, repetir a URL do
  // callback cria uma sessão nova para quem repetiu.
  assert.equal(await m.consumirEstado(state), null);
});

test("bilhete vazio não vira consulta ao banco", async () => {
  const { m, apagouComo } = modeloComEstados();

  // `findOneAndDelete({ state: "" })` poderia casar com um documento malformado.
  assert.equal(await m.consumirEstado(""), null);
  assert.equal(await m.consumirEstado(undefined), null);
  assert.equal(apagouComo(), null);
});

// ── O HOST DE ORIGEM: o guarda contra redirecionamento aberto ────────────
//
// O bilhete guarda para onde devolver a pessoa. Se esse endereço viesse do
// cabeçalho sem conferência, qualquer um montaria um link de login que termina no
// site dele — com uma sessão válida do GoFitNow no fragmento da URL.

test("host de OUTRA instância não é guardado", async () => {
  const { m, guardados } = modeloComEstados({ "treino.bruna.com.br": "bruna" });

  await m.criarEstado("marlon", "treino.bruna.com.br");

  // O host existe no registro — e é justamente por isso que "existe no registro"
  // não pode ser o critério. Ele é de outro cliente.
  assert.equal(guardados[0].origem, null);
  assert.equal(guardados[0].instancia, "marlon");
});

test("host da MESMA instância é guardado, para o domínio próprio funcionar", async () => {
  const { m, guardados } = modeloComEstados({ "treino.marlon.com.br": "marlon" });

  await m.criarEstado("marlon", "treino.marlon.com.br");

  assert.equal(guardados[0].origem, "treino.marlon.com.br");
});

test("host desconhecido não é guardado", async () => {
  const { m, guardados } = modeloComEstados({});

  await m.criarEstado("marlon", "site-do-atacante.com");

  assert.equal(guardados[0].origem, null);
});

test("host com porta e maiúsculas é normalizado antes de conferir", async () => {
  const { m, guardados } = modeloComEstados({ "treino.marlon.com.br": "marlon" });

  await m.criarEstado("marlon", "TREINO.Marlon.com.br:443");

  // Sem normalizar, o mesmo host escrito de outro jeito não casaria no registro e
  // a pessoa cairia no subdomínio — funcionaria, e ninguém entenderia por quê.
  assert.equal(guardados[0].origem, "treino.marlon.com.br");
});

test("registro fora do ar não impede entrar — só perde o domínio próprio", async () => {
  const { m, guardados } = modeloComEstados({ "treino.marlon.com.br": "marlon" }, true);

  const state = await m.criarEstado("marlon", "treino.marlon.com.br");

  assert.equal(state, "est-novo");
  // O bilhete nasce mesmo assim: a volta cai no subdomínio montado pelo nome, que
  // funciona para todo mundo. Recusar o login inteiro por isso seria pior.
  assert.equal(guardados[0].origem, null);
  assert.equal(guardados[0].instancia, "marlon");
});

test("bilhete de um provedor NÃO serve no callback do outro", async () => {
  // Os dois callbacks são públicos, e trocar o `state` de um pelo do outro é a
  // primeira coisa que alguém tenta. O bilhete guarda o provedor, e
  // `consumirEstado` filtra por ele.
  const { m, guardados } = modeloComEstados();
  const state = await m.criarEstado("marlon");
  assert.equal(guardados[0].provedor, "google");

  // O modelo do Facebook, olhando a MESMA collection.
  const facebook = new OauthFacebook(m.app);
  assert.equal(await facebook.consumirEstado(state), null);

  // E o dono continua conseguindo gastá-lo — a recusa acima não o consumiu.
  assert.equal((await m.consumirEstado(state))?.instancia, "marlon");
});

test("o destino do bilhete é lista fechada", async () => {
  const { m, guardados } = modeloComEstados();

  await m.criarEstado("marlon", null, "app");
  await m.criarEstado("marlon", null, undefined);
  // Qualquer coisa que não seja "app" é navegador. Gravar a string crua deixaria
  // um valor inventado decidir o formato da volta, longe daqui — e o efeito
  // apareceria como `undefined://entrar` na cara de alguém.
  await m.criarEstado("marlon", null, "javascript:alert(1)");

  assert.deepEqual(guardados.map((g) => g.destino), ["app", "web", "web"]);
});

test("sem instância o bilhete guarda nulo, e não a string 'null'", async () => {
  // Quem entra por `app.gofitnow.fit` não tem subdomínio de profissional — é um
  // caso real, e `String(null)` gravaria "null" como se fosse o nome de alguém.
  const { m, guardados } = modeloComEstados();

  await m.criarEstado(null);
  assert.equal(guardados[0].instancia, null);
});
