const Oauth = require("./Oauth_model.js");

// O QUE É DO FACEBOOK, e só dele.
//
// Chaves, bilhete, TTL e endereço de volta são iguais em todo provedor e moram em
// `Oauth_model.js`, de onde este herda.
//
// ── As duas diferenças que importam em relação ao Google ──────────────────
//
// 1. NÃO existe `id_token`. O Google devolve a identidade assinada dentro da
//    própria resposta do token; o Facebook devolve só um `access_token`, e quem
//    é a pessoa se descobre CONSULTANDO a Graph API com ele. É uma ida à rede a
//    mais, e é por isso que `pessoaDoCodigo` existe: ela esconde essa diferença
//    do controlador, que é o mesmo para os dois.
//
// 2. NÃO existe `email_verified`. O Google afirma, explicitamente, que confirmou
//    o e-mail; o Facebook não afirma nada. Ele verifica o e-mail no cadastro,
//    então na prática o endereço é confiável — mas a garantia é MAIS FRACA que a
//    do Google, e isso é uma escolha consciente, não um esquecimento. Vale
//    lembrar disso no dia em que alguém propuser "criar conta" por aqui: com o
//    Google seria discutível; com o Facebook, não.
//
// ── A VERSÃO DA GRAPH API ────────────────────────────────────────────────
//
// A Meta lança versão nova a cada poucos meses e APOSENTA as antigas. Uma
// versão morta não responde "sua versão morreu": ela responde um erro de outra
// coisa, e quem for procurar o defeito vai olhar as chaves.
//
// *"toda hora o Facebook atualiza a API, aí eu mudando lá já reflete pra todo
// mundo"* (26/09/2026). Por isso ela vem da CENTRAL, e vale para todos os
// clientes de uma vez — trocar é uma tela, não um deploy.
//
// A chave é `oauth.facebook.apiVersion`, e NÃO a do app de integração
// (`meta.graphVersion`): são dois apps no console da Meta, cada um com a sua
// versão em Configurações do app › Avançado. Um valor só obrigaria a subir os
// dois no mesmo dia — e o que quebra numa versão nova raramente quebra nos
// dois ao mesmo tempo.
//
// A constante abaixo continua sendo o PADRÃO, para dois casos reais: a central
// sem o campo preenchido, e a central fora do ar. Sem ela, um campo em branco
// montaria `https://graph.facebook.com//me` e o erro falaria de rota.
const VERSAO = "v26.0";

// Só `v` seguido de número.número. A versão entra no CAMINHO da URL, então um
// valor com barra ou `..` digitado por engano apontaria a chamada para outro
// endereço da Meta. Formato torto cai no padrão em vez de viajar.
const FORMATO = /^v\d{1,3}\.\d{1,3}$/;

// Só o e-mail. `public_profile` vem sempre, sem pedir. Nada além disto: cada
// permissão a mais é uma tela de consentimento mais assustadora e um item a
// justificar na Análise do App.
const ESCOPO = "email";

function OauthFacebook_model(app) {
  Oauth.call(this, app);
}

Oauth.herdar(OauthFacebook_model, "facebook");

// Lida junto com o par de chaves, na mesma ida ao banco (ver `nomesDasChaves`).
OauthFacebook_model.prototype.CHAVE_VERSAO = "oauth.facebook.apiVersion";

// A versão que vale para ESTA chamada. Recebe o mesmo `chaves` que todo o resto
// do fluxo já carrega, então não há leitura extra — e quem chamar sem ele (os
// testes, e qualquer caminho antigo) continua no padrão.
OauthFacebook_model.prototype.versao = function (chaves) {
  const escolhida = String(chaves?.versao || "").trim();
  return FORMATO.test(escolhida) ? escolhida : VERSAO;
};

OauthFacebook_model.prototype.urlDeAutorizacao = function (clientId, state, chaves) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: this.callback(),
    response_type: "code",
    scope: ESCOPO,
    state,
  });
  return `https://www.facebook.com/${this.versao(chaves)}/dialog/oauth?` + p.toString();
};

// ── O código vira token ───────────────────────────────────────────────────
//
// GET, e não POST: o Facebook recebe a troca por querystring — é a API dele que
// é assim, e mandar POST devolve erro que fala de outra coisa.
OauthFacebook_model.prototype.trocarCodigo = async function (code, chaves) {
  const chamar = this.app.facebookFetch || fetch;

  const p = new URLSearchParams({
    client_id: chaves.clientId,
    client_secret: chaves.clientSecret,
    redirect_uri: this.callback(),
    code: String(code),
  });

  const r = await chamar(
    `https://graph.facebook.com/${this.versao(chaves)}/oauth/access_token?` + p.toString()
  );

  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    throw new Error(`token ${r.status}: ${texto.slice(0, 200)}`);
  }

  return r.json();
};

// A PROVA DE QUE O TOKEN É NOSSO.
//
// `appsecret_proof` é um HMAC do token com a chave secreta do app. Sem ele, um
// token roubado funciona de qualquer lugar do mundo; com ele, só funciona de
// quem tem a chave — ou seja, deste servidor. A Meta documenta isto como
// obrigatório para chamadas de servidor, e é barato: uma linha.
OauthFacebook_model.prototype.provaDoSegredo = function (accessToken, clientSecret) {
  return this.app.crypto
    .createHmac("sha256", String(clientSecret))
    .update(String(accessToken))
    .digest("hex");
};

// ── O token vira e-mail ───────────────────────────────────────────────────
//
// Aqui não há assinatura para conferir: a resposta VEM deste servidor falando com
// o `graph.facebook.com` por HTTPS, então o TLS já prova a origem — igual ao
// caminho do Google, e pelo mesmo motivo.
//
// O que precisa de cuidado é o contrário: o e-mail pode simplesmente NÃO VIR.
// Acontece em dois casos reais — a pessoa desmarcou o e-mail na tela de
// consentimento, ou a conta dela é só telefone. Sem e-mail não há como achar a
// conta aqui, e o desenho é "acha por e-mail e nunca cria" (ver
// `User_model.porEmailVerificado`). Então é recusa, com motivo próprio.
OauthFacebook_model.prototype.pessoaDoToken = async function (accessToken, chaves) {
  const chamar = this.app.facebookFetch || fetch;

  const p = new URLSearchParams({
    fields: "id,name,email",
    access_token: String(accessToken),
    appsecret_proof: this.provaDoSegredo(accessToken, chaves.clientSecret),
  });

  const r = await chamar(`https://graph.facebook.com/${this.versao(chaves)}/me?` + p.toString());
  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    return { erro: `graph_${r.status}`, detalhe: texto.slice(0, 200) };
  }

  const dados = await r.json();
  const email = String(dados.email || "").trim().toLowerCase();
  if (!email) return { erro: "sem_email_no_facebook" };

  return { email, nome: String(dados.name || "").trim() };
};

// O caminho completo, para o controlador do callback ser o mesmo dos outros
// provedores: troca o código e devolve quem entrou (ou `{ erro }`).
OauthFacebook_model.prototype.pessoaDoCodigo = async function (code, chaves) {
  const resposta = await this.trocarCodigo(code, chaves);
  if (!resposta?.access_token) return { erro: "sem_access_token" };
  return this.pessoaDoToken(resposta.access_token, chaves);
};

module.exports = OauthFacebook_model;
module.exports.VERSAO = VERSAO;
module.exports.ESCOPO = ESCOPO;
module.exports.CALLBACK = `${Oauth.BACKEND}/auth/facebook/callback`;
