const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const OauthFacebook = require("../../model/OauthFacebook_model.js");

// O QUE É DO FACEBOOK.
//
// O que é igual ao Google (bilhete, TTL, endereço de volta) já é exercitado em
// `oauthGoogle.test.js` — os dois herdam da mesma implementação, e testar duas
// vezes a mesma função só dá duas coisas para atualizar. Aqui ficam as diferenças,
// e elas são três: não há `id_token`, não há `email_verified`, e a chamada à Graph
// precisa provar que o token é nosso.

const CHAVES = { ligado: true, clientId: "123456", clientSecret: "seg-redo" };

function modelo({ respostas = [], docs } = {}) {
  const chamadas = [];
  const m = new OauthFacebook({
    crypto,
    uuidv4: () => "est-novo",
    facebookFetch: async (url) => {
      chamadas.push(String(url));
      const r = respostas.shift();
      if (!r) throw new Error("o teste não preparou resposta para " + url);
      return {
        ok: r.ok !== false,
        status: r.status || 200,
        async json() {
          return r.corpo;
        },
        async text() {
          return JSON.stringify(r.corpo || {});
        },
      };
    },
    mongodb: {
      async centralDb() {
        return {
          collection() {
            return { find: () => ({ async toArray() { return docs || []; } }) };
          },
        };
      },
    },
  });
  return { m, chamadas };
}

// ── A IDA ─────────────────────────────────────────────────────────────────

test("a URL de autorização é a do Facebook, com a versão e o escopo certos", () => {
  const { m } = modelo();

  const u = new URL(m.urlDeAutorizacao(CHAVES.clientId, "est-1"));

  assert.equal(u.host, "www.facebook.com");
  // A versão vem do console do app (Configurações › Avançado), não de chute: a
  // Meta descontinua versão, e uma versão morta responde erro que não diz
  // "sua versão morreu".
  assert.equal(u.pathname, `/${OauthFacebook.VERSAO}/dialog/oauth`);
  assert.equal(u.searchParams.get("client_id"), CHAVES.clientId);
  assert.equal(u.searchParams.get("response_type"), "code");
  // Só o e-mail. Cada permissão a mais é uma tela de consentimento mais
  // assustadora e um item a justificar na Análise do App.
  assert.equal(u.searchParams.get("scope"), "email");
  assert.equal(u.searchParams.get("state"), "est-1");
});

test("o redirect_uri é o do FACEBOOK, e não o do Google", () => {
  const { m } = modelo();

  const uri = new URL(m.urlDeAutorizacao(CHAVES.clientId, "est-1")).searchParams.get("redirect_uri");

  // Um callback compartilhado entre provedores seria recusado por ambos: cada um
  // exige correspondência exata com o que está cadastrado no console dele.
  //
  // Os DOIS hosts viraram `vafit.app` em 26/09/2026, quando os apps foram
  // refeitos na conta da VAFIT — cada console nasceu com o endereço novo, o
  // Facebook de manhã e o Google à tarde. O mapa por provedor fica: é ele que
  // permitiu virar um sem esperar o outro, que foi exatamente o que houve.
  assert.equal(uri, "https://backend.vafit.app/auth/facebook/callback");
  assert.ok(!uri.includes("google"));
});

test("as chaves lidas são as do facebook, não as do google", async () => {
  const { m } = modelo({
    docs: [
      { key: "oauth.facebook.enabled", value: true },
      { key: "oauth.facebook.clientId", value: "123456" },
      { key: "oauth.facebook.clientSecret", value: "seg-redo" },
      // As do Google no meio, para o caso de alguém trocar o prefixo por
      // acidente: elas NÃO podem ligar o Facebook.
      { key: "oauth.google.clientId", value: "nao-e-esta" },
    ],
  });

  const c = await m.chaves();

  assert.equal(c.ligado, true);
  assert.equal(c.clientId, "123456");
  // A versão da Graph entra na MESMA leitura das chaves — é de propósito: uma
  // consulta a mais por clique de login seria paga para sempre por um valor
  // que muda uma vez por ano.
  assert.deepEqual(m.nomesDasChaves(), [
    "oauth.facebook.enabled",
    "oauth.facebook.clientId",
    "oauth.facebook.clientSecret",
    "oauth.facebook.apiVersion",
  ]);
});

// ── A VERSÃO DA GRAPH VEM DA CENTRAL ──────────────────────────────────────
//
// *"toda hora o Facebook atualiza a API, aí eu mudando lá já reflete pra todo
// mundo"*. O que isto guarda é que a troca não precise de deploy — e que um
// valor torto no banco não mande a chamada para outro endereço da Meta.

test("a versão digitada na central é a que vai para a URL", async () => {
  const { m } = modelo({
    docs: [
      { key: "oauth.facebook.enabled", value: true },
      { key: "oauth.facebook.clientId", value: "123456" },
      { key: "oauth.facebook.clientSecret", value: "seg-redo" },
      { key: "oauth.facebook.apiVersion", value: "v31.0" },
    ],
  });

  const chaves = await m.chaves();
  const u = new URL(m.urlDeAutorizacao(chaves.clientId, "est-1", chaves));

  assert.equal(u.pathname, "/v31.0/dialog/oauth");
});

test("central em branco, ou fora do ar, cai no padrão do código", async () => {
  const { m } = modelo({
    docs: [
      { key: "oauth.facebook.enabled", value: true },
      { key: "oauth.facebook.clientId", value: "123456" },
      { key: "oauth.facebook.clientSecret", value: "seg-redo" },
    ],
  });

  const chaves = await m.chaves();
  assert.equal(chaves.versao, "");
  assert.equal(m.versao(chaves), OauthFacebook.VERSAO);
  // Sem argumento nenhum também: é como os caminhos antigos chamam.
  assert.equal(m.versao(), OauthFacebook.VERSAO);
});

test("versão com formato torto NÃO viaja — a URL é caminho, não texto", () => {
  const { m } = modelo();

  for (const torta of ["../v1.0", "v26.0/me", "26.0", "v26", "https://evil", " "]) {
    assert.equal(m.versao({ versao: torta }), OauthFacebook.VERSAO, torta);
  }
});

test("a versão da central vale também na troca do código e na ida à Graph", async () => {
  const { m, chamadas } = modelo({
    respostas: [
      { corpo: { access_token: "tok-fb" } },
      { corpo: { id: "9", name: "Bruna", email: "bruna@exemplo.com" } },
    ],
  });

  await m.pessoaDoCodigo("cod-1", { ...CHAVES, versao: "v31.0" });

  assert.ok(chamadas[0].startsWith("https://graph.facebook.com/v31.0/oauth/access_token"), chamadas[0]);
  assert.ok(chamadas[1].startsWith("https://graph.facebook.com/v31.0/me"), chamadas[1]);
});

// ── A VOLTA ───────────────────────────────────────────────────────────────

test("o código vira token, e o e-mail vem da Graph", async () => {
  const { m, chamadas } = modelo({
    respostas: [
      { corpo: { access_token: "tok-fb" } },
      { corpo: { id: "9", name: "Bruna", email: "Bruna@Exemplo.com " } },
    ],
  });

  const pessoa = await m.pessoaDoCodigo("cod-1", CHAVES);

  assert.deepEqual(pessoa, { email: "bruna@exemplo.com", nome: "Bruna" });
  // Duas idas à rede, e nessa ordem: o Facebook não manda a identidade junto com
  // o token, como o Google manda no `id_token`.
  assert.equal(chamadas.length, 2);
  assert.ok(chamadas[0].includes("/oauth/access_token"));
  assert.ok(chamadas[1].includes("/me?"));
});

test("a chamada à Graph leva a PROVA do segredo", async () => {
  const { m, chamadas } = modelo({
    respostas: [{ corpo: { access_token: "tok-fb" } }, { corpo: { id: "9", email: "a@b.com" } }],
  });

  await m.pessoaDoCodigo("cod-1", CHAVES);

  const prova = new URL(chamadas[1]).searchParams.get("appsecret_proof");
  // Sem ela, um token roubado funciona de qualquer lugar do mundo; com ela, só
  // funciona de quem tem a chave — ou seja, deste servidor.
  const esperada = crypto.createHmac("sha256", CHAVES.clientSecret).update("tok-fb").digest("hex");
  assert.equal(prova, esperada);
});

test("conta do Facebook SEM e-mail é recusada, com motivo próprio", async () => {
  // Acontece de dois jeitos reais: a pessoa desmarcou o e-mail na tela de
  // consentimento, ou a conta dela é só telefone. Sem e-mail não há como achar a
  // conta aqui — e o desenho é "acha por e-mail e nunca cria".
  const { m } = modelo({
    respostas: [{ corpo: { access_token: "tok-fb" } }, { corpo: { id: "9", name: "Sem Email" } }],
  });

  const pessoa = await m.pessoaDoCodigo("cod-1", CHAVES);

  assert.equal(pessoa.erro, "sem_email_no_facebook");
  assert.equal(pessoa.email, undefined);
});

test("token que não vem não vira consulta à Graph", async () => {
  const { m, chamadas } = modelo({ respostas: [{ corpo: { error: { message: "algo" } } }] });

  const pessoa = await m.pessoaDoCodigo("cod-1", CHAVES);

  assert.equal(pessoa.erro, "sem_access_token");
  // Uma consulta com `access_token=undefined` devolveria erro da Graph, e o log
  // falaria da Graph quando o problema foi a troca do código.
  assert.equal(chamadas.length, 1);
});

test("a troca do código recusada estoura com o corpo do erro", async () => {
  const { m } = modelo({
    respostas: [{ ok: false, status: 400, corpo: { error: { message: "This authorization code has been used" } } }],
  });

  // O corpo diz o motivo real. Sem ele no log, "código já usado" e "chave errada"
  // ficam iguais — e são consertos opostos.
  await assert.rejects(() => m.pessoaDoCodigo("cod-1", CHAVES), /token 400/);
});

test("a Graph recusando devolve erro, e não um e-mail vazio", async () => {
  const { m } = modelo({
    respostas: [{ corpo: { access_token: "tok-fb" } }, { ok: false, status: 401, corpo: { error: {} } }],
  });

  const pessoa = await m.pessoaDoCodigo("cod-1", CHAVES);

  assert.equal(pessoa.erro, "graph_401");
  assert.equal(pessoa.email, undefined);
});

// ── O ENDEREÇO DE VOLTA ───────────────────────────────────────────────────
//
// O domínio base era uma CÓPIA dentro deste modelo, e a cópia ficou em
// `gofitnow.fit` depois que `lib/domain.js` virou `vafit.app`. Este teste
// existe para a próxima troca de marca não deixar um sobrevivente.

test("sem host confirmado, a volta cai no domínio base DE HOJE", () => {
  const { m } = modelo();
  const dominio = require("../../lib/domain.js");

  assert.equal(m.enderecoDeVolta({ instancia: "marlon" }), `https://marlon.${dominio.BASE_DOMAIN}`);
  assert.equal(m.enderecoDeVolta(null), `https://app.${dominio.BASE_DOMAIN}`);
});

test("o host confirmado vence o domínio base — quem tem domínio próprio volta para ele", () => {
  const { m } = modelo();
  assert.equal(
    m.enderecoDeVolta({ instancia: "marlon", origem: "treinos.marlon.com.br" }),
    "https://treinos.marlon.com.br"
  );
});
