const Oauth = require("./Oauth_model.js");

// O QUE É DO GOOGLE, e só dele.
//
// Chaves, bilhete, TTL e endereço de volta são iguais em todo provedor e moram em
// `Oauth_model.js`, de onde este herda. Aqui ficam as três coisas que mudam de um
// provedor para o outro: para onde se manda a pessoa, como o código vira token, e
// como o token vira e-mail.
//
// A central mostra o callback deste provedor na tela para ser copiado
// (`views/configuracao/ChavesEApps.jsx`, constante `CALLBACK`). Mudar um sem o
// outro quebra o login sem quebrar nenhum teste — as duas vivem em repositórios
// diferentes, e nenhum teste alcança as duas.

// O mínimo para saber QUEM entrou. Nada além disto de propósito: escopo sensível
// (agenda, contatos, arquivos) joga o app na fila de verificação do Google, que
// leva semanas, e não precisamos de nada disso para autenticar.
const ESCOPO = "openid email profile";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function OauthGoogle_model(app) {
  Oauth.call(this, app);
}

Oauth.herdar(OauthGoogle_model, "google");

// A URL para onde o navegador vai.
OauthGoogle_model.prototype.urlDeAutorizacao = function (clientId, state) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: this.callback(),
    response_type: "code",
    scope: ESCOPO,
    state,
    // `select_account` porque quem já está logado em duas contas do Google
    // precisa poder escolher. Sem isto o Google usa a última em silêncio, e a
    // pessoa entra com a conta errada sem entender o que aconteceu.
    prompt: "select_account",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
};

// ── O código vira token ───────────────────────────────────────────────────
//
// O `code` que chega na URL não diz quem é ninguém. Ele é um cupom de uso único
// que só vale trocado por token NESTE servidor, com a chave secreta — é por isso
// que ele pode viajar à vista, na barra de endereço.
OauthGoogle_model.prototype.trocarCodigo = async function (code, chaves) {
  // `app.googleFetch` para o teste poder responder sem rede, igual ao
  // `app.anthropicFetch` do controlador de IA.
  const chamar = this.app.googleFetch || fetch;

  const r = await chamar(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(code),
      client_id: chaves.clientId,
      client_secret: chaves.clientSecret,
      redirect_uri: this.callback(),
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!r.ok) {
    // O corpo do erro do Google diz o motivo real (`invalid_grant` de código já
    // usado, `invalid_client` de chave errada). Sem ele no log, os dois casos
    // ficam iguais — e são consertos opostos.
    const texto = await r.text().catch(() => "");
    throw new Error(`token ${r.status}: ${texto.slice(0, 200)}`);
  }

  return r.json();
};

// ── O token vira e-mail ───────────────────────────────────────────────────
//
// ── Por que a assinatura NÃO é conferida aqui ─────────────────────────────
//
// Porque este token não veio do navegador: ele veio da resposta de uma chamada
// que ESTE servidor fez ao endereço do Google, por HTTPS, com a chave secreta. O
// próprio Google documenta que nesse caminho a verificação de assinatura é
// dispensável — o TLS já prova a origem. Conferir exigiria buscar e girar as
// chaves públicas dele, mais código e mais uma dependência de rede para provar
// o que já está provado.
//
// (A Apple, quando chegar, é o caso OPOSTO: lá o token vem do aparelho, então a
// assinatura tem de ser conferida contra o JWKS dela.)
//
// O que É conferido são as afirmações que dependem do nosso lado: `aud` tem de
// ser a NOSSA chave (senão um token emitido para outro app serviria aqui), e o
// e-mail tem de estar verificado — sem isso, quem cria uma conta no Google com o
// e-mail de outra pessoa entraria como ela.
OauthGoogle_model.prototype.pessoaDoIdToken = function (idToken, clientId) {
  const partes = String(idToken || "").split(".");
  if (partes.length !== 3) return { erro: "id_token_malformado" };

  let dados;
  try {
    dados = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
  } catch {
    return { erro: "id_token_ilegivel" };
  }

  if (dados.aud !== clientId) return { erro: "aud_de_outro_app" };

  const emissores = ["accounts.google.com", "https://accounts.google.com"];
  if (!emissores.includes(dados.iss)) return { erro: "emissor_desconhecido" };

  // `exp` vem em segundos, não milissegundos. Comparar com `Date.now()` cru
  // daria um token sempre vencido — e o sintoma seria "o Google parou de
  // funcionar", sem nada no log.
  if (!dados.exp || dados.exp * 1000 < Date.now()) return { erro: "id_token_vencido" };

  // `email_verified` chega como booleano ou como a string "true", dependendo do
  // caminho. Tratar só o booleano recusaria login legítimo.
  const verificado = dados.email_verified === true || dados.email_verified === "true";
  if (!verificado) return { erro: "email_nao_verificado" };

  const email = String(dados.email || "").trim().toLowerCase();
  if (!email) return { erro: "sem_email" };

  return { email, nome: String(dados.name || "").trim() };
};

// O caminho completo da volta, para o controlador não ter de conhecer a ordem:
// troca o código e devolve quem entrou (ou `{ erro }`).
//
// Existe para o controlador do callback ser o MESMO para todos os provedores — é
// aqui que a diferença entre "o Google manda um id_token" e "o Facebook manda um
// access_token e um endereço para consultar" fica contida.
OauthGoogle_model.prototype.pessoaDoCodigo = async function (code, chaves) {
  const resposta = await this.trocarCodigo(code, chaves);
  return this.pessoaDoIdToken(resposta.id_token, chaves.clientId);
};

module.exports = OauthGoogle_model;
module.exports.ESCOPO = ESCOPO;
module.exports.TOKEN_URL = TOKEN_URL;

// O callback deste provedor também como constante, para quem precisa afirmar
// sobre ele sem instanciar o modelo (os testes).
module.exports.CALLBACK = `${Oauth.BACKEND}/auth/google/callback`;
