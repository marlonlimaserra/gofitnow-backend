const instanceContext = require("../lib/instance.js");

// ENTRAR COM ___ — um controlador para todos os provedores.
//
// Google e Facebook diferem em três coisas, e todas as três moram nos modelos
// (`urlDeAutorizacao`, `trocarCodigo`, `pessoaDoCodigo`). Daqui para cima o fluxo
// é idêntico, então duplicar este arquivo por provedor criaria dois lugares para
// a mesma regra de segurança — e a regra aqui é uma só, dita de várias formas:
// **nenhum caminho de falha pode acabar em sessão**.
//
// A lista é FECHADA. Uma rota `/auth/:provedor/...` aceitaria qualquer palavra e
// procuraria um modelo que não existe — 500 em vez de 404, e um log que fala de
// `undefined` em vez de dizer que ninguém pediu aquele provedor.
const PROVEDORES = [
  { nome: "google", api: "oauthGoogle" },
  { nome: "facebook", api: "oauthFacebook" },
];

module.exports = function (app) {
  // QUAIS ENTRADAS SOCIAIS EXISTEM — sem instância, e de propósito.
  //
  // ── O ovo e a galinha que esta rota resolve ────────────────────────────
  //
  // O app nativo não é servido de host nenhum: ele descobre de qual cliente a
  // pessoa é consultando o portal PELO E-MAIL que ela digita. Mas para desenhar
  // a tela de entrada ele precisa saber, ANTES de qualquer e-mail, quais botões
  // mostrar. Pela rota de montar o link não dá: aquela exige instância, e na
  // primeira abertura ainda não existe nenhuma.
  //
  // Dá para responder sem instância porque o interruptor é GLOBAL — ele mora na
  // central, não na conta de cada cliente. Se um dia virar por cliente, esta
  // rota deixa de poder ser pública, e é aqui que a mudança dói.
  //
  // Sob `/public/`, que é o prefixo que o `instanceGate` isenta. Não devolve
  // chave nenhuma: só quais portas estão abertas — o que qualquer pessoa
  // descobre olhando a tela de entrada.
  app.get("/public/social", async function (req, res) {
    const saida = {};

    for (const p of PROVEDORES) {
      try {
        saida[p.nome] = (await app.api[p.api].chaves()).ligado;
      } catch (erro) {
        // Central fora do ar não pode derrubar a tela de entrada: sem botões, o
        // login por e-mail e senha continua de pé. E um provedor que falha não
        // pode esconder os outros — por isso o `try` é por provedor.
        console.error(`[oauth:${p.nome}] não consegui dizer se está ligado:`, erro.message);
        saida[p.nome] = false;
      }
    }

    // `apple` ainda não existe — nem o app no provedor, nem rota aqui. Fica
    // declarado como FALSO em vez de ausente para o app não ter de adivinhar a
    // forma da resposta quando ele chegar: o botão nasce escondido e acende
    // sozinho no dia em que a chave entrar, sem build novo.
    res.send({ ...saida, apple: false });
  });

  for (const provedor of PROVEDORES) registrar(app, provedor);
};

function registrar(app, { nome, api }) {
  // ── A IDA ───────────────────────────────────────────────────────────────
  //
  // Devolve um LINK, e não um 302: quem chama é a tela de entrada por XHR, e um
  // redirecionamento numa chamada de XHR faz o navegador seguir por dentro e
  // trazer o HTML do provedor como resposta de API.
  //
  // ── Por que o link é montado A CADA chamada ───────────────────────────
  //
  // Porque ele carrega duas coisas que mudam: a chave atual (que a central pode
  // ter trocado há um minuto) e um bilhete de uso único. Um link guardado no
  // frontend é um link com a chave de ontem e um bilhete já gasto.
  //
  // ── A instância vem do CONTEXTO, nunca do corpo do pedido ─────────────
  //
  // `instanceGate` já resolveu e CONFERIU contra o registro antes desta função
  // rodar — inclusive o caso do app, que manda `X-Instance-Host` porque a
  // chamada dele sai para `backend.gofitnow.fit` e o subdomínio da tela não
  // atravessa sozinho. Ler o nome de outro lugar aqui desfaria a conferência: é
  // o que separa "pediu um banco" de "tem esse banco".
  app.get(`/auth/${nome}/url`, async function (req, res) {
    try {
      const { ligado, clientId } = await app.api[api].chaves();

      // Desligado não é erro: é a resposta. Um 404 aqui faria a tela de entrada
      // mostrar aviso de falha para quem simplesmente não usa este provedor.
      if (!ligado) {
        res.send({ ligado: false });
        return;
      }

      // O host da TELA, não o desta requisição: a chamada sai para
      // `backend.gofitnow.fit`, então o Host que chega aqui é o do backend. É
      // conferido contra o registro dentro de `criarEstado` antes de ser
      // guardado.
      //
      // `?destino=app` é o app nativo pedindo a volta pelo esquema próprio. Sem
      // isso a volta termina numa página `https`, e no app a pessoa ficaria
      // olhando o navegador com a sessão presa lá dentro.
      const state = await app.api[api].criarEstado(
        instanceContext.current(),
        req.headers["x-instance-host"],
        req.query.destino
      );

      res.send({ ligado: true, url: app.api[api].urlDeAutorizacao(clientId, state) });
    } catch (erro) {
      // A tela de entrada não pode cair por causa disto. Sem link, o botão não
      // aparece e o login por e-mail e senha continua de pé.
      console.error(`[oauth:${nome}] não consegui montar o link:`, erro.message);
      res.send({ ligado: false });
    }
  });

  // ── A VOLTA ─────────────────────────────────────────────────────────────
  //
  // Sempre termina em REDIRECIONAMENTO, nunca em JSON: quem está olhando é um
  // navegador que acabou de sair da tela do provedor, e um JSON na cara da
  // pessoa é o fim do login.
  //
  // ── E ela termina em DOIS formatos, conforme quem pediu ───────────────
  //
  // No navegador, com o resultado no FRAGMENTO (`#sessao=…`): o fragmento não é
  // enviado ao servidor, então o token não entra em log de acesso, não vai no
  // `Referer` para terceiros e não fica em cache de proxy.
  //
  // No app nativo, no ESQUEMA próprio (`gofitnow://entrar?sessao=…`), porque um
  // app não tem página onde aterrissar — e no iOS é só ao ver esse esquema que o
  // navegador de autenticação devolve o controle ao app.
  //
  // Quem monta os dois é `urlDeVolta`, no modelo compartilhado.
  //
  // ── Esta rota é ISENTA de instância, e tem de ser ─────────────────────
  //
  // Ela chega do servidor do provedor, sem cabeçalho nenhum nosso, e com Host
  // `backend.gofitnow.fit` — que `lib/instance.js` ignora de propósito. Sem a
  // isenção em `lib/instanceGate.js`, a resposta seria 400 `no_instance` DEPOIS
  // de a pessoa já ter consentido. A instância sai do bilhete, que é o único
  // lugar confiável: foi este servidor que a gravou lá na ida, já conferida.
  app.get(`/auth/${nome}/callback`, async function (req, res) {
    const paraLogin = (estado, chave) =>
      // `erroLogin`, e não `erroGoogle`: a chave nasceu quando só havia um
      // provedor, e um erro do Facebook chegando como "erroGoogle" mandaria quem
      // fosse depurar olhar o provedor errado.
      res.redirect(app.api[api].urlDeVolta(estado, { erroLogin: chave }));
    // O bilhete que não existe: sem ele não há destino nenhum, e o navegador é o
    // único palpite razoável.
    const semRumo = { destino: "web" };

    try {
      // O bilhete é gasto PRIMEIRO, antes de qualquer outra coisa. Se ele não
      // vale, nada mais importa — e gastá-lo cedo garante que uma volta repetida
      // não chegue nem a falar com o provedor.
      //
      // `consumirEstado` filtra pelo PROVEDOR: os dois callbacks são públicos, e
      // trocar o `state` de um pelo do outro é a primeira coisa que alguém tenta.
      const estado = await app.api[api].consumirEstado(req.query.state);
      if (!estado) {
        console.error(`[oauth:${nome}] volta sem bilhete válido`);
        return paraLogin(semRumo, "expirou");
      }

      // Quem clicou em "cancelar" na tela do provedor. Não é falha nossa e não
      // merece mensagem de erro — merece a tela de entrada de volta, quieta.
      if (req.query.error) return paraLogin(estado, "recusado");

      if (!req.query.code) return paraLogin(estado, "falhou");

      const chaves = await app.api[api].chaves();
      if (!chaves.ligado) return paraLogin(estado, "desligado");

      const pessoa = await app.api[api].pessoaDoCodigo(req.query.code, chaves);
      if (pessoa.erro) {
        // O motivo vai para o log e NÃO para a tela: "e-mail não verificado" e
        // "token de outro app" contam a quem tentar em qual pedra ele tropeçou.
        console.error(`[oauth:${nome}] identidade recusada:`, pessoa.erro);
        return paraLogin(estado, "falhou");
      }

      // A partir daqui é preciso estar DENTRO da instância: os modelos leem o
      // banco do contexto assíncrono, e fora dele estouram de propósito. Este é
      // o único lugar do sistema em que a instância vem do bilhete, e não da
      // requisição — porque a requisição do provedor não tem como carregá-la.
      const entrada = await instanceContext.run(estado.instancia, async () => {
        const user = await app.api.user.porEmailVerificado(pessoa.email);
        if (!user) return null;
        return { user, token: await app.api.auth.registerToken(user._id) };
      });

      if (!entrada) {
        // E-mail sem conta nesta instância. NÃO criamos ninguém aqui — ver
        // `porEmailVerificado`. A tela diz o que fazer; o log diz quem tentou.
        console.error(
          `[oauth:${nome}] sem conta para ${pessoa.email} em ${estado.instancia || "(portal)"}`
        );
        return paraLogin(estado, "sem_conta");
      }

      // O mesmo registro que o login por senha faz, com o meio anotado: sem
      // isto, o histórico mostraria "login" sem dizer por onde a pessoa entrou,
      // e uma entrada estranha não teria como ser explicada depois.
      await instanceContext.run(estado.instancia, async () => {
        app.insertUserActionHistory(req, entrada.user, "login", {
          category: "auth",
          extra: { via: nome },
        });
      });

      return res.redirect(app.api[api].urlDeVolta(estado, { sessao: entrada.token }));
    } catch (erro) {
      console.error(`[oauth:${nome}] a volta falhou:`, erro.message);
      return paraLogin(semRumo, "falhou");
    }
  });
}

module.exports.PROVEDORES = PROVEDORES;
