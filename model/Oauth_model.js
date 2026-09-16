// O QUE É IGUAL EM TODO "ENTRAR COM ___".
//
// Google, Facebook e (um dia) Apple diferem em três coisas: o endereço para onde
// se manda a pessoa, como o código vira token, e como o token vira e-mail. Todo o
// RESTO é o mesmo — as chaves na central, o bilhete de ida e volta, o TTL, e para
// onde devolver quem entrou.
//
// Isto nasceu dentro do modelo do Google, e saiu de lá quando o Facebook chegou:
// copiar teria criado dois lugares para a mesma regra, e o dia em que um deles
// ganhasse uma correção o outro seguiria errado em silêncio. Os provedores
// HERDAM daqui (ver o fim de `OauthGoogle_model.js`), então
// `app.api.oauthGoogle.criarEstado` continua existindo — com uma implementação só.
//
// Quem herda define `PROVEDOR` ("google", "facebook"). É esse nome que escolhe as
// chaves na central e monta o endereço de volta.

// Onde o backend responde. O callback é derivado dele e do provedor, e não escrito
// à mão em cada lugar: um `/auth/facebok/callback` com typo seria recusado pelo
// provedor com "URI não corresponde", sem dizer qual dos dois lados errou.
// ── ESTE HOST NÃO ACOMPANHA A TROCA DE DOMÍNIO, E ISSO É DE PROPÓSITO ─────
//
// Em 16/09/2026 eu centralizei o endereço do backend em `lib/domain.js`, para
// que ele seguisse o `BASE_DOMAIN` sozinho — e trouxe este arquivo junto. Errado:
// um teste pegou, e a consequência seria pior que o incômodo que eu queria
// resolver.
//
// O `redirect_uri` do OAuth tem de casar EXATAMENTE com o que está registrado
// no console do Google e do Facebook. Eles recusam qualquer outro — é a defesa
// do protocolo contra alguém desviar o retorno de um login. Mudar o host aqui
// não reapontaria o console; derrubaria o "entrar com Google" de todos os
// clientes, com um erro do provedor e nada no nosso log.
//
// Então ele fica em `gofitnow.fit` até alguém acrescentar o callback novo nos
// DOIS consoles. A ordem é essa: primeiro registrar lá, depois trocar aqui —
// nunca o contrário. O host antigo continua resolvendo para este servidor.
const BACKEND = process.env.BACKEND_URL || "https://backend.gofitnow.fit";

// O domínio base, para remontar o endereço de volta a partir do NOME da
// instância. Mesmo padrão de `lib/instance.js`, que também o traz como padrão.
const BASE = process.env.BASE_DOMAIN || "gofitnow.fit";

// O esquema do app nativo, o mesmo de `expo.scheme` no `app.json`. No iOS o
// `ASWebAuthenticationSession` só devolve o controle ao app quando o navegador
// tenta abrir exatamente este esquema.
const ESQUEMA_APP = process.env.APP_SCHEME || "gofitnow";

// Dez minutos para completar o consentimento. Mais que isso é um bilhete válido
// esquecido num histórico de navegador; menos, e quem parou para achar a senha
// volta para um erro.
const VALIDADE_SEGUNDOS = 600;

function Oauth_model(app) {
  this.app = app;
}

// ── AS CHAVES ─────────────────────────────────────────────────────────────
//
// Moram na collection `settings` do banco CENTRAL — o mesmo banco do painel,
// onde a tela "Chaves e apps" as grava. Este modelo só lê.
//
// O motivo é operacional: chave no `.env` só troca entrando no VPS e
// reiniciando o processo, e nesse intervalo ninguém entra. Vindo do banco, a
// troca é uma tela e o próximo clique já sai com a chave nova.
//
// E é lido a CADA clique, sem cache, porque "a chave atual" é o ponto. Um cache
// de cinco minutos significa cinco minutos mandando gente para o provedor com
// uma chave já revogada — e o erro que aparece não diz que a culpa é do cache.
Oauth_model.prototype.settings = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("settings");
};

Oauth_model.prototype.nomesDasChaves = function () {
  const p = this.PROVEDOR;
  return [`oauth.${p}.enabled`, `oauth.${p}.clientId`, `oauth.${p}.clientSecret`];
};

// Devolve `{ ligado, clientId, clientSecret }`. `ligado` é verdadeiro só com o
// par COMPLETO: ligado sem chave mandaria a pessoa para uma URL que o provedor
// recusa, e o botão na tela do cliente pareceria simplesmente quebrado.
Oauth_model.prototype.chaves = async function () {
  const nomes = this.nomesDasChaves();
  let docs = [];
  try {
    const col = await this.settings();
    docs = await col.find({ key: { $in: nomes } }).toArray();
  } catch (erro) {
    // Central fora do ar não pode derrubar a tela de entrada: sem as chaves o
    // botão não aparece e o login por e-mail e senha segue de pé.
    console.error(`[oauth:${this.PROVEDOR}] não consegui ler as chaves:`, erro.message);
    return { ligado: false, clientId: "", clientSecret: "" };
  }

  const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  const [nomeLigado, nomeId, nomeSegredo] = nomes;
  const clientId = String(v[nomeId] || "").trim();
  const clientSecret = String(v[nomeSegredo] || "").trim();

  return {
    ligado: Boolean(v[nomeLigado]) && Boolean(clientId) && Boolean(clientSecret),
    clientId,
    clientSecret,
  };
};

// Para onde o provedor devolve a pessoa. Tem de ser IDÊNTICA à cadastrada no
// console dele, senão a recusa é "URI não corresponde" — que não diz qual dos
// dois lados está errado.
//
// É UMA só por provedor, e fixa, por causa do curinga: nenhum deles aceita URI
// com curinga, e cada profissional tem seu subdomínio — inclusive os que ainda
// não existem, que não poderiam ter sido cadastrados. Então o retorno é sempre
// aqui, e o subdomínio de origem volta pelo `state`.
Oauth_model.prototype.callback = function () {
  return `${BACKEND}/auth/${this.PROVEDOR}/callback`;
};

// ── O BILHETE DE IDA E VOLTA ──────────────────────────────────────────────
//
// Ele resolve dois problemas de uma vez, e os dois importam:
//
//   1. CSRF. Sem `state`, qualquer um pode arrastar alguém para o nosso callback
//      com um `code` obtido em outra sessão. O bilhete só vale se nós o
//      emitimos, e vale UMA vez.
//   2. De onde a pessoa veio. O callback é um endereço só, então é ele que
//      precisa saber para qual subdomínio — ou para qual app — devolver.
//
// ── Por que documento no Mongo, e não HMAC ────────────────────────────────
//
// Porque não existe segredo de assinatura neste código: sessão aqui é token
// opaco guardado no banco (ver `Auth_model`), e inventar um segredo novo criaria
// mais uma coisa para vazar e para rodar. Documento com TTL dá de graça o uso
// único, que assinatura NÃO dá — um HMAC válido continua válido enquanto não
// vence, e serve para repetir a mesma volta.
//
// A collection é UMA para todos os provedores, com o provedor gravado dentro: o
// bilhete é consumido pelo callback daquele provedor, e um bilhete do Google
// chegando no callback do Facebook tem de ser recusado.
Oauth_model.prototype.estados = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("oauth_states");
};

let indexado = false;

// O índice de TTL: é ele que apaga o bilhete não usado.
//
// Sem ele a collection cresce para sempre com estados que ninguém completou, e
// um bilhete de mês passado continuaria valendo.
Oauth_model.prototype.garantirIndices = async function (col) {
  if (indexado) return;
  indexado = true;
  await col.createIndex({ state: 1 }, { unique: true, name: "por_state" });
  await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: VALIDADE_SEGUNDOS, name: "expira" });
};

// `instancia` é o NOME normalizado que `lib/instance.js` resolveu, nunca um host
// que veio de fora. É o que impede redirecionamento aberto: na volta o endereço
// é remontado a partir desse nome.
//
// `origem` é o host em que a tela está — e ele só é guardado se o REGISTRO
// confirmar que aquele host é daquela instância. É o que permite devolver quem
// tem domínio próprio para o domínio dele, sem abrir um redirecionamento para
// qualquer endereço que alguém escreva num cabeçalho.
//
// `destino` diz QUEM recebe a volta: o navegador (padrão) ou o app nativo.
Oauth_model.prototype.criarEstado = async function (instancia, origem, destino) {
  const col = await this.estados();
  await this.garantirIndices(col);

  let hostConferido = null;
  const candidato = String(origem || "").trim().toLowerCase().split(":")[0];
  if (candidato && instancia) {
    try {
      const dono = await this.app.api.center.instanceForHost(candidato);
      // Igualdade com a instância DESTA requisição, e não "existe no registro":
      // um host de outro cliente existe no registro e mandaria a pessoa para o
      // endereço do concorrente com uma sessão válida na mão.
      if (dono && String(dono) === String(instancia)) hostConferido = candidato;
    } catch (erro) {
      // Registro fora do ar não impede entrar: sem host guardado a volta cai no
      // subdomínio montado pelo nome, que funciona para todo mundo.
      console.error(`[oauth:${this.PROVEDOR}] não consegui conferir o host:`, erro.message);
    }
  }

  const state = this.app.uuidv4();
  await col.insertOne({
    state,
    provedor: this.PROVEDOR,
    instancia: instancia ? String(instancia) : null,
    origem: hostConferido,
    // Lista fechada, e não o que chegou: gravar a string crua deixaria um valor
    // qualquer decidir o formato da volta mais tarde, longe daqui.
    destino: destino === "app" ? "app" : "web",
    createdAt: new Date(),
  });

  return state;
};

// Gasta o bilhete: devolve o que ele carregava e o APAGA na mesma operação.
//
// `findOneAndDelete` e não "achar, depois apagar": duas chamadas abrem a janela
// em que a mesma volta é processada duas vezes — e duas voltas com o mesmo
// `code` criam duas sessões, uma delas para quem repetiu a URL.
//
// O filtro inclui o PROVEDOR. Um bilhete do Google chegando no callback do
// Facebook não é um erro teórico: os dois callbacks são públicos, e trocar o
// `state` de um pelo do outro é a primeira coisa que alguém tenta.
Oauth_model.prototype.consumirEstado = async function (state) {
  if (!state) return null;
  const col = await this.estados();
  const doc = await col.findOneAndDelete({ state: String(state), provedor: this.PROVEDOR });
  // O driver do Mongo mudou o formato desta resposta entre versões: 4.x devolve
  // `{ value }`, 6.x devolve o documento. Aceitar os dois evita um `null` que
  // só apareceria depois de um `npm update`.
  return doc?.value || doc || null;
};

// ── PARA ONDE DEVOLVER ────────────────────────────────────────────────────
//
// O host guardado vence o subdomínio montado: um profissional pode ter DOMÍNIO
// PRÓPRIO apontado para cá, e devolvê-lo para `joao.gofitnow.fit` o jogaria fora
// do endereço dele no meio do login.
//
// Sem host guardado, monta-se o subdomínio a partir do NOME, que é normalizado e
// veio do registro. Em nenhum dos dois caminhos um endereço escolhido por quem
// chamou é usado — é isso que separa isto de um redirecionamento aberto.
Oauth_model.prototype.enderecoDeVolta = function (estado) {
  if (estado?.origem) return `https://${estado.origem}`;
  if (estado?.instancia) return `https://${estado.instancia}.${BASE}`;
  // Sem instância: quem entrou pelo portal. `app.gofitnow.fit` é o produto, e
  // de propósito não é endereço de cliente nenhum.
  return `https://app.${BASE}`;
};

// ── Por que no app o dado vai na QUERY, e no web no fragmento ─────────────
//
// No web o fragmento existe para o token NÃO chegar ao servidor. No app não há
// servidor no caminho: quem lê a URL é o próprio aparelho, pelo esquema, e o
// sistema entrega a string direto ao app. O fragmento não protegeria de nada e
// só daria mais um lugar para errar o parse.
Oauth_model.prototype.urlDeVolta = function (estado, resultado) {
  const p = new URLSearchParams(resultado);

  if (estado?.destino === "app") return `${ESQUEMA_APP}://entrar?${p.toString()}`;

  return `${this.enderecoDeVolta(estado)}/#${p.toString()}`;
};

// Faz um provedor herdar tudo isto. Chamado no fim de cada modelo de provedor.
//
// Prototype puro, como o resto dos modelos deste projeto — nada de `class`, que
// só faria este arquivo parecer de outro repositório.
Oauth_model.herdar = function (Filho, provedor) {
  Filho.prototype = Object.create(Oauth_model.prototype);
  Filho.prototype.constructor = Filho;
  Filho.prototype.PROVEDOR = provedor;
  return Filho;
};

module.exports = Oauth_model;
module.exports.BACKEND = BACKEND;
module.exports.ESQUEMA_APP = ESQUEMA_APP;
module.exports.VALIDADE_SEGUNDOS = VALIDADE_SEGUNDOS;
