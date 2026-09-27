const Oauth = require("./Oauth_model.js");

// CONECTAR UMA CONTA DO INSTAGRAM — que NÃO é entrar com o Instagram.
//
// *"agora precisamos conectar a conta do Facebook e a conta do Instagram no
// VAFIT"* (26/09/2026). A diferença com o "Entrar com ___" é o ponto de
// partida: aqui a pessoa JÁ ESTÁ dentro do sistema, logada, e o que ela pede é
// que o VAFIT passe a falar pela conta dela. O que volta não é identidade — é
// um token de trabalho, de 60 dias, que fica guardado.
//
// Por isso este modelo herda do `Oauth_model`: o bilhete de ida e volta (o
// `state`), o TTL dele e o endereço de retorno são exatamente os mesmos
// problemas do login, e resolvê-los de novo aqui criaria a segunda cópia que o
// `Oauth_model` existe para evitar. O que muda é tudo o que vem DEPOIS do
// código.
//
// ── Instagram Business Login, e não Facebook Login ───────────────────────
//
// A Meta tem dois caminhos para chegar ao Instagram de alguém. O que passa
// pelo Facebook exige que a pessoa tenha uma PÁGINA do Facebook ligada à conta
// dela — e a maioria dos profissionais não tem, nem quer criar uma para usar o
// VAFIT. O Instagram Business Login vai direto: a pessoa entra no
// instagram.com, autoriza, e pronto.
//
// O preço é que ele é um app SEPARADO dentro do mesmo app da Meta, com id e
// segredo próprios (`meta.instagramAppId` / `meta.instagramAppSecret`, na
// central). Não são os do app do Facebook, e trocar um pelo outro dá um erro
// que fala de "client_id inválido" sem dizer qual dos dois.
const AUTORIZAR = "https://www.instagram.com/oauth/authorize";
const TOKEN = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";

// O mínimo para o que o produto faz hoje: ler a conta, e ler/responder o que
// chega. Cada permissão a mais é uma linha a mais na tela de consentimento —
// e uma a justificar na Análise do App.
const ESCOPO = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
].join(",");

function OauthInstagram_model(app) {
  Oauth.call(this, app);
}

Oauth.herdar(OauthInstagram_model, "instagram");

// As chaves NÃO seguem o padrão `oauth.<provedor>.*` dos outros: elas são do
// app da Meta, não de um provedor de login, e moram junto com as outras chaves
// dele. Ver `Setting_model` da central.
OauthInstagram_model.prototype.nomesDasChaves = function () {
  return ["meta.instagramAppId", "meta.instagramAppSecret"];
};

OauthInstagram_model.prototype.chaves = async function () {
  const [nomeId, nomeSegredo] = this.nomesDasChaves();
  let docs = [];
  try {
    const col = await this.settings();
    docs = await col.find({ key: { $in: this.nomesDasChaves() } }).toArray();
  } catch (erro) {
    // Central fora do ar não pode derrubar a tela: sem chaves o botão de
    // conectar some, e o resto do sistema segue de pé.
    console.error("[instagram] não consegui ler as chaves:", erro.message);
    return { ligado: false, clientId: "", clientSecret: "" };
  }

  const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  const clientId = String(v[nomeId] || "").trim();
  const clientSecret = String(v[nomeSegredo] || "").trim();

  // Sem `enabled` separado, ao contrário do login: aqui não há botão que
  // aparece para o cliente final. Ou o par existe e dá para conectar, ou não.
  return { ligado: Boolean(clientId && clientSecret), clientId, clientSecret };
};

OauthInstagram_model.prototype.urlDeAutorizacao = function (clientId, state) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: this.callback(),
    response_type: "code",
    scope: ESCOPO,
    state,
  });
  return `${AUTORIZAR}?${p.toString()}`;
};

// ── O código vira token curto ─────────────────────────────────────────────
//
// POST com corpo de formulário, e não querystring: é o contrário do Facebook,
// e mandar do jeito do outro devolve um erro que fala de campo faltando.
//
// O `code` chega do Instagram com um `#_` grudado no fim. Ele não faz parte do
// código, e mandado assim a troca falha com "authorization code expired" — uma
// mensagem que manda procurar no lugar errado.
OauthInstagram_model.prototype.trocarCodigo = async function (code, chaves) {
  const chamar = this.app.instagramFetch || fetch;

  const corpo = new URLSearchParams({
    client_id: chaves.clientId,
    client_secret: chaves.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: this.callback(),
    code: String(code).replace(/#_$/, ""),
  });

  const r = await chamar(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: corpo.toString(),
  });

  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    throw new Error(`token ${r.status}: ${texto.slice(0, 200)}`);
  }

  return r.json();
};

// ── O token curto vira token de 60 dias ───────────────────────────────────
//
// O que sai da troca dura UMA HORA. Guardá-lo seria guardar algo que já morreu
// quando alguém for usar — e o sintoma seria "a conta desconectou sozinha".
OauthInstagram_model.prototype.tokenLongo = async function (curto, chaves) {
  const chamar = this.app.instagramFetch || fetch;

  const p = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: chaves.clientSecret,
    access_token: String(curto),
  });

  const r = await chamar(`${GRAPH}/access_token?${p.toString()}`);
  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    throw new Error(`token longo ${r.status}: ${texto.slice(0, 200)}`);
  }

  return r.json();
};

// Renova sem passar pela pessoa. Só funciona com token de pelo menos 24 horas
// de vida e no máximo 60 dias — passou disso, é conectar de novo, com ela
// presente. Quem chama é o zelador (ver `controllers/ContasConectadas.js`).
OauthInstagram_model.prototype.renovar = async function (token) {
  const chamar = this.app.instagramFetch || fetch;

  const p = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: String(token),
  });

  const r = await chamar(`${GRAPH}/refresh_access_token?${p.toString()}`);
  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    throw new Error(`renovação ${r.status}: ${texto.slice(0, 200)}`);
  }

  return r.json();
};

// QUEM É A CONTA. É o que a tela mostra — sem isto a lista de contas
// conectadas seria uma lista de números.
OauthInstagram_model.prototype.perfil = async function (token) {
  const chamar = this.app.instagramFetch || fetch;

  const p = new URLSearchParams({
    fields: "user_id,username,name,profile_picture_url",
    access_token: String(token),
  });

  const r = await chamar(`${GRAPH}/me?${p.toString()}`);
  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    return { erro: `graph_${r.status}`, detalhe: texto.slice(0, 200) };
  }

  return r.json();
};

// O caminho inteiro, para o controlador não conhecer as três etapas: código →
// token curto → token de 60 dias → quem é.
OauthInstagram_model.prototype.contaDoCodigo = async function (code, chaves) {
  const curto = await this.trocarCodigo(code, chaves);
  if (!curto?.access_token) return { erro: "sem_access_token" };

  const longo = await this.tokenLongo(curto.access_token, chaves);
  if (!longo?.access_token) return { erro: "sem_token_longo" };

  const quem = await this.perfil(longo.access_token);
  if (quem.erro) return quem;

  return {
    token: longo.access_token,
    // `expires_in` vem em segundos. Guardo a DATA, não o prazo: prazo guardado
    // envelhece em silêncio, e ninguém lembra de quando ele foi gravado.
    expiraEm: new Date(Date.now() + Number(longo.expires_in || 0) * 1000),
    externalId: String(quem.user_id || curto.user_id || ""),
    usuario: String(quem.username || ""),
    nome: String(quem.name || ""),
    foto: String(quem.profile_picture_url || ""),
    escopos: String(curto.permissions || ESCOPO)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
};

module.exports = OauthInstagram_model;
module.exports.ESCOPO = ESCOPO;
