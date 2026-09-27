const test = require("node:test");
const assert = require("node:assert/strict");

const OauthInstagram = require("../../model/OauthInstagram_model.js");

// CONECTAR UMA CONTA DO INSTAGRAM.
//
// O que se guarda aqui é o que dói se estiver errado: o token que vai para o
// banco tem de ser o LONGO (o curto morre em uma hora), o `#_` que o Instagram
// gruda no código tem de sair, e o token nunca pode sair na resposta.

const CHAVES = { ligado: true, clientId: "2279906372852560", clientSecret: "seg-redo" };

function modelo({ respostas = [], docs } = {}) {
  const chamadas = [];
  const m = new OauthInstagram({
    uuidv4: () => "est-novo",
    instagramFetch: async (url, opcoes) => {
      chamadas.push({ url: String(url), corpo: opcoes?.body || null });
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

test("a URL é a do instagram.com, e não a do facebook.com", () => {
  const { m } = modelo();
  const u = new URL(m.urlDeAutorizacao(CHAVES.clientId, "est-1"));

  // O caminho pelo Facebook exigiria uma PÁGINA ligada à conta, que a maioria
  // dos profissionais não tem. Trocar um host pelo outro faz o fluxo pedir
  // algo que a pessoa não pode dar.
  assert.equal(u.host, "www.instagram.com");
  assert.equal(u.pathname, "/oauth/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("state"), "est-1");
});

test("o escopo pede ler a conta e responder — e nada além disso", () => {
  const { m } = modelo();
  const pedido = new URL(m.urlDeAutorizacao(CHAVES.clientId, "e"))
    .searchParams.get("scope")
    .split(",");

  assert.deepEqual(pedido.sort(), [
    "instagram_business_basic",
    "instagram_business_manage_comments",
    "instagram_business_manage_messages",
  ]);
});

test("as chaves são as do app do INSTAGRAM, não as do app do Facebook", async () => {
  const { m } = modelo({
    docs: [
      { key: "meta.instagramAppId", value: "2279906372852560" },
      { key: "meta.instagramAppSecret", value: "seg-redo" },
      // As do app do Facebook no meio: elas NÃO podem ligar isto.
      { key: "meta.appId", value: "2155086338698151" },
    ],
  });

  const c = await m.chaves();
  assert.equal(c.ligado, true);
  assert.equal(c.clientId, "2279906372852560");
  assert.deepEqual(m.nomesDasChaves(), ["meta.instagramAppId", "meta.instagramAppSecret"]);
});

test("sem o par completo, não dá para conectar — e o botão some", async () => {
  const { m } = modelo({ docs: [{ key: "meta.instagramAppId", value: "227" }] });
  assert.equal((await m.chaves()).ligado, false);
});

// ── A VOLTA ───────────────────────────────────────────────────────────────

test("o `#_` grudado no código é retirado antes da troca", async () => {
  const { m, chamadas } = modelo({ respostas: [{ corpo: { access_token: "curto", user_id: 9 } }] });

  await m.trocarCodigo("ABC123#_", CHAVES);

  // Mandado com o `#_`, o Instagram responde "authorization code expired" —
  // uma mensagem que manda procurar no lugar errado.
  assert.match(chamadas[0].corpo, /code=ABC123(&|$)/);
  assert.ok(!chamadas[0].corpo.includes("%23_"));
});

test("a troca vai por POST com corpo de formulário, não por querystring", async () => {
  const { m, chamadas } = modelo({ respostas: [{ corpo: { access_token: "curto" } }] });
  await m.trocarCodigo("ABC", CHAVES);

  assert.equal(chamadas[0].url, "https://api.instagram.com/oauth/access_token");
  assert.ok(chamadas[0].corpo.includes("grant_type=authorization_code"));
  // O segredo no CORPO, nunca na URL: URL entra em log de proxy e de servidor.
  assert.ok(chamadas[0].corpo.includes("client_secret=seg-redo"));
});

test("o token guardado é o de 60 dias, e não o de uma hora", async () => {
  const { m, chamadas } = modelo({
    respostas: [
      { corpo: { access_token: "de-uma-hora", user_id: 77, permissions: "instagram_business_basic" } },
      { corpo: { access_token: "de-60-dias", expires_in: 5184000 } },
      { corpo: { user_id: "17841400000000001", username: "marlon.fit", name: "Marlon", profile_picture_url: "https://f/x.jpg" } },
    ],
  });

  const conta = await m.contaDoCodigo("ABC", CHAVES);

  assert.equal(conta.token, "de-60-dias");
  assert.equal(conta.externalId, "17841400000000001");
  assert.equal(conta.usuario, "marlon.fit");
  assert.equal(conta.nome, "Marlon");
  // Guardo a DATA e não o prazo: prazo envelhece em silêncio, e ninguém
  // lembra de quando ele foi gravado.
  assert.ok(conta.expiraEm instanceof Date);
  assert.ok(conta.expiraEm.getTime() > Date.now() + 50 * 24 * 3600 * 1000);
  assert.ok(chamadas[1].url.includes("grant_type=ig_exchange_token"));
});

test("sem token na primeira resposta, para por aí — e diz o motivo", async () => {
  const { m } = modelo({ respostas: [{ corpo: { error_type: "OAuthException" } }] });
  assert.deepEqual(await m.contaDoCodigo("ABC", CHAVES), { erro: "sem_access_token" });
});

test("a Graph recusando o perfil não vira exceção, vira motivo", async () => {
  const { m } = modelo({
    respostas: [
      { corpo: { access_token: "curto" } },
      { corpo: { access_token: "longo", expires_in: 100 } },
      { ok: false, status: 400, corpo: { error: { message: "token inválido" } } },
    ],
  });

  const r = await m.contaDoCodigo("ABC", CHAVES);
  assert.equal(r.erro, "graph_400");
});

test("renovar usa ig_refresh_token, que é outro fluxo do de trocar", async () => {
  const { m, chamadas } = modelo({ respostas: [{ corpo: { access_token: "novo", expires_in: 5184000 } }] });
  await m.renovar("antigo");

  assert.ok(chamadas[0].url.includes("refresh_access_token"));
  assert.ok(chamadas[0].url.includes("grant_type=ig_refresh_token"));
  // Renovar NÃO leva o segredo do app: é o token que se autentica.
  assert.ok(!chamadas[0].url.includes("client_secret"));
});

// ── A VOLTA PRECISA ATRAVESSAR O PORTÃO DE INSTÂNCIA ──────────────────────
//
// Quem bate no callback é o navegador voltando do instagram.com, sem cabeçalho
// de cliente nenhum. Sem a isenção, o portão responde 400 e a pessoa vê uma
// tela de erro no fim de um fluxo que deu certo — o token já foi autorizado
// lá, e o sistema não fica sabendo.
test("o callback do Instagram está isento do portão de instância", () => {
  const { SEM_INSTANCIA } = require("../../lib/instanceGate.js");
  const isento = (caminho) => SEM_INSTANCIA.some((r) => r.test(caminho));

  assert.ok(isento("/auth/instagram/callback"));
  // E os vizinhos continuam isentos — a lista é uma só.
  assert.ok(isento("/auth/google/callback"));
  assert.ok(isento("/auth/facebook/callback"));
  // Mas não qualquer rota de conta: estas exigem sessão E cliente.
  assert.ok(!isento("/contas-conectadas"));
  assert.ok(!isento("/contas-conectadas/url"));
});
