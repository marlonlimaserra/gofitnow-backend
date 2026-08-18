const clientIp = require("../lib/clientIp.js");
const rateLimit = require("../lib/rateLimit.js");
const ensureSchema = require("../database/schema.js");
const instanceContext = require("../lib/instance.js");
const cloudflareLib = require("../lib/cloudflare.js");
const { passwordReset } = require("../lib/emailTemplates.js");

// O PORTAL: a porta de entrada que não é de cliente nenhum.
//
// `app.gofitnow.fit` de propósito não é o endereço de ninguém — está escrito
// assim no App.jsx da tela. Isso é ótimo depois de entrar (a aparência vem da
// conta, não do domínio) e é um problema ANTES: sem endereço de cliente, o
// `instanceGate` não tem em qual banco procurar, e a tela caía em "domínio
// desconhecido".
//
// Este controller resolve a única coisa que falta: qual cliente é o da pessoa.
// Ela digita o e-mail, o servidor procura, e a tela redireciona para o endereço
// dela — onde tudo volta a funcionar como sempre funcionou, sem uma linha de
// mudança no gate, na sessão ou no tema.
//
// ── Por que /public/ ──────────────────────────────────────────────────────
//
// Porque é a única família de rotas que o `instanceGate` deixa passar sem
// instância (ver SEM_INSTANCIA). E tem de ser assim: pedir a instância a quem
// está justamente perguntando qual é a instância seria circular.
//
// ── Por que POST para uma leitura ─────────────────────────────────────────
//
// Um GET põe o e-mail na query string, e query string vai para log de acesso,
// histórico do navegador e cabeçalho Referer. E-mail é dado pessoal: ele viaja
// no corpo.
module.exports = function (app) {
  // ── O limite, e por que ele é a metade do trabalho ──────────────────────
  //
  // Esta rota responde "este e-mail é de qual cliente nosso". Solta, ela é uma
  // máquina de descobrir duas coisas que não são de ninguém: quem usa o
  // GoFitNow, e de qual clínica. A segunda é pior — plano alimentar é dado de
  // saúde, e "esta pessoa é paciente da clínica X" é a informação que a LGPD
  // chama de sensível.
  //
  // Não há como fechar a porta e manter a função: a tela PRECISA da resposta.
  // O que se faz é encarecer a varredura. 10 por minuto atende qualquer pessoa
  // de verdade — ninguém erra o próprio e-mail dez vezes — e torna enumerar uma
  // lista inviável.
  const LIMITE_POR_MINUTO = 10;

  app.post("/public/portal/lookup", async function (req, res) {
    const ip = clientIp(req);
    const limite = await rateLimit.checkShared("portal:" + ip, LIMITE_POR_MINUTO);

    if (!limite.allowed) {
      res.setHeader("Retry-After", String(limite.retryAfter));
      return res.status(429).send({
        msg: req.t("errors.rateLimited", {
          limit: limite.limit,
          seconds: limite.retryAfter,
        }),
        code: "too_many_requests",
      });
    }

    const email = String((req.body && req.body.email) || "").trim();

    // 400 só para e-mail em branco. Formato inválido cai no fluxo normal e sai
    // como "não achei": responder diferente para "malformado" e "não existe"
    // daria a quem enumera um jeito de separar os dois.
    if (!email) {
      return res.status(400).send({
        msg: req.t("errors.requirePersonEmail"),
        code: "missing_email",
      });
    }

    try {
      const destinos = await app.api.portal.destinosParaEmail(email);

      // 200 com `found: false`, e não 404.
      //
      // Não achar não é erro da requisição — ela foi respondida. E a tela precisa
      // desenhar uma mensagem própria ("não encontramos esse e-mail"), o que com
      // 404 exigiria distinguir este caso de uma rota que não existe.
      res.send({ found: destinos.length > 0, destinations: destinos });
    } catch (error) {
      console.error("[portal] falha ao procurar e-mail:", error.message);
      res.status(503).send({ msg: req.t("errors.internal"), code: "lookup_failed" });
    }
  });

  // ── CADASTRO: um cliente novo, do zero, sem ninguém do outro lado ────────
  //
  // Até aqui criar cliente era trabalho de gente: o painel registrava, pedia o
  // provisionamento e criava o primeiro acesso, com alguém olhando cada passo.
  // Esta rota é aquele roteiro sem a pessoa — e é por isso que ela é a mais
  // perigosa do arquivo: ela cria BANCO DE DADOS e registro de DNS a partir de
  // um formulário aberto na internet.
  //
  // Duas defesas, e nenhuma é opcional:
  //
  //   o LIMITE, muito mais apertado que o da busca — três por hora, porque
  //   ninguém abre três negócios numa tarde e cada chamada custa um banco;
  //
  //   o ÍNDICE ÚNICO de e-mail em `instances`, que é o que garante uma
  //   instância por e-mail mesmo se duas requisições chegarem no mesmo instante.
  //
  // O que NÃO está aqui e vale dizer: não há confirmação de e-mail antes de
  // criar. É o preço de "entra na hora" — e se um dia isto for abusado, é a
  // primeira coisa a acrescentar.
  const LIMITE_CADASTROS_POR_HORA = 3;

  // A janela do `rateLimit` é de um minuto. Para uma hora, a chave carrega a
  // hora corrente: `cadastro:1.2.3.4:481234` só existe durante aquela hora, e a
  // contagem morre com ela sem precisar de um segundo mecanismo.
  function chaveDaHora(ip) {
    return `portalSignup:${ip}:${Math.floor(Date.now() / 3600000)}`;
  }

  // O que a pessoa chama de quem ela atende. Vem de uma lista de botões na tela
  // (aluno, paciente, cliente, pessoa), mas chega aqui como texto — e texto de
  // rota aberta não se confia.
  //
  // Só letras e espaço, 2 a 20 caracteres. Não é a lista fechada de propósito:
  // "atleta" e "corredor" são legítimos e a tela pode oferecê-los amanhã. O que
  // esta regra barra é o que nunca é uma palavra — marcação, script, URL.
  const PALAVRA = /^[a-záàâãéèêíïóôõöúçñ ]{2,20}$/i;

  function palavraValida(v) {
    return PALAVRA.test(String(v || "").trim());
  }

  app.post("/public/portal/signup", async function (req, res) {
    const body = req.body || {};
    const nome = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const singular = String(body.peopleSingular || "").trim().toLowerCase();
    const plural = String(body.peoplePlural || "").trim().toLowerCase();

    if (nome.length < 2) {
      return res.status(400).send({ msg: req.t("errors.invalidName"), code: "invalid_name" });
    }
    if (!app.validator.isEmail(email)) {
      return res.status(400).send({ msg: req.t("errors.invalidEmail"), code: "invalid_email" });
    }
    if (!palavraValida(singular) || !palavraValida(plural)) {
      return res.status(400).send({ msg: req.t("errors.invalidWords"), code: "invalid_words" });
    }

    // O LIMITE vem DEPOIS de conferir os campos, e a ordem é uma decisão.
    //
    // Antes ele vinha primeiro, e um teste mostrou o preço: quem errasse o
    // próprio e-mail três vezes ficava trancado por uma hora — punido por
    // digitar torto, no primeiro contato com o produto.
    //
    // Contar só o que PODE criar algo protege o que precisa de proteção. Quem
    // insiste com campo inválido não gasta cota nenhuma, e também não cria banco
    // nenhum: as três coisas caras — a varredura de e-mail, o DNS e o
    // provisionamento — estão todas depois desta linha.
    const limite = await rateLimit.checkShared(
      chaveDaHora(clientIp(req)),
      LIMITE_CADASTROS_POR_HORA
    );

    if (!limite.allowed) {
      res.setHeader("Retry-After", "3600");
      return res.status(429).send({
        msg: req.t("errors.signupRateLimited"),
        code: "too_many_requests",
      });
    }

    try {
      // Já tem conta? Manda entrar, não cria a segunda.
      //
      // O índice único de `instances.email` já barraria o dono repetido, mas não
      // pega quem é ALUNO de outro cliente e resolveu se cadastrar como
      // profissional. Aqui os dois casos dão a mesma resposta útil: "você já tem
      // acesso, entre por ele".
      const existentes = await app.api.portal.destinosParaEmail(email);
      if (existentes.length) {
        return res.status(409).send({
          msg: req.t("errors.emailAlreadyHasAccess"),
          code: "already_has_access",
          destinations: existentes,
        });
      }

      const instancia = await app.api.portal.slugLivre(nome);
      if (!instancia) {
        return res.status(400).send({ msg: req.t("errors.invalidName"), code: "invalid_name" });
      }

      const host = `${instancia}.${require("../lib/domain.js").BASE_DOMAIN}`;

      // ── A ORDEM DOS PASSOS É A PROTEÇÃO ───────────────────────────────────
      //
      // O DNS vem PRIMEIRO, antes de existir instância ou banco. Se a Cloudflare
      // falhar, nada foi criado e tentar de novo é limpo. Na ordem contrária, uma
      // falha de rede deixaria um cliente cadastrado num endereço que não
      // responde — e o e-mail dele já ocupado, então nem repetir o cadastro daria.
      //
      // O contrário não é simétrico: um registro de DNS sem instância é inofensivo
      // (mostra "domínio não identificado") e é reaproveitado na tentativa
      // seguinte, porque `createSubdomain` tolera "já existe".
      const cf = app.cloudflare || cloudflareLib;
      const dns = await cf.createSubdomain(host);
      if (!dns.ok) {
        console.error(`[portal] cloudflare recusou ${host}:`, dns.erro, dns.passo || "");
        return res.status(503).send({ msg: req.t("errors.internal"), code: "domain_failed" });
      }

      const registro = await app.api.center.ensure({ instance: instancia, email, name: nome });
      if (!registro.ok) {
        // "taken" = o índice único de e-mail. Duas requisições ao mesmo tempo com
        // o mesmo e-mail: uma cria, a outra chega aqui. A resposta é a mesma do
        // 409 acima, e é a certa.
        const jaTem = registro.erro === "taken";
        return res.status(jaTem ? 409 : 400).send({
          msg: jaTem ? req.t("errors.emailAlreadyHasAccess") : req.t("errors.internal"),
          code: jaTem ? "already_has_access" : "register_failed",
        });
      }

      // `app.schema` é o dublê do teste, no mesmo padrão do `app.cloudflare`: as
      // duas coisas que saem desta máquina — o banco e a rede — ficam trocáveis
      // num ponto só, senão um teste de regra bateria no Mongo e na Cloudflare.
      await (app.schema || ensureSchema).ensureInstance(app, instancia);
      await app.api.center.addHost(instancia, host);
      // O portão guarda por alguns segundos que um nome NÃO é de ninguém. Sem
      // isto, a pessoa chega no endereço dela e vê "domínio não identificado" —
      // no pior momento possível, que é o de conferir se o cadastro funcionou.
      app.api.center.forget(instancia);

      const criado = await instanceContext.run(instancia, async () => {
        // A SENHA é aleatória e ninguém a conhece — nem a pessoa, nem nós.
        //
        // Ela existe porque `insertTrainer` exige uma, e nunca é usada para
        // entrar: quem entra é o token de criar senha, logo abaixo. Uma senha
        // curta e adivinhável aqui seria a única senha fraca do sistema, numa
        // conta que vai guardar dado de saúde.
        const id = await app.api.user.insertTrainer({
          name: nome,
          email,
          password: app.crypto.randomBytes(24).toString("hex"),
          // Dona da casa: a primeira precisa poder tudo, inclusive convidar as
          // outras. Sem isto ela entra e não consegue cadastrar ninguém.
          admin: true,
        });

        if (id && id.erro) return { erro: id.erro };

        // O vocabulário é gravado num segundo passo porque é `updateSelf` quem
        // sabe normalizá-lo (minúscula, sem espaço nas pontas) — e repetir essa
        // regra aqui daria dois lugares para ela discordar de si mesma.
        await app.api.user.updateSelf(id, { peopleSingular: singular, peoplePlural: plural });

        const token = await app.api.passwordReset.create(id);
        return { id, token };
      });

      if (criado.erro) {
        console.error(`[portal] não consegui criar o primeiro acesso de ${instancia}:`, criado.erro);
        return res.status(503).send({ msg: req.t("errors.internal"), code: "first_user_failed" });
      }

      // O link vai por E-MAIL ALÉM de ir na resposta.
      //
      // A resposta é o caminho normal: a tela redireciona e a pessoa nem lê o
      // e-mail. O e-mail é a rede de segurança para quem fechou a aba, perdeu a
      // conexão no meio, ou se cadastrou no celular e quer abrir no computador.
      // Sem ele, um cadastro interrompido é uma conta inalcançável — e o e-mail
      // já está ocupado, então nem repetir o cadastro resolveria.
      const url = `https://${host}/reset-password?token=${criado.token}`;
      const mail = passwordReset({
        lang: req.lang,
        name: nome,
        url,
        minutes: app.api.passwordReset.validityMinutes,
      });

      const resposta = { ok: true, host, token: criado.token };

      try {
        const enviado = await app.helpers.mailer.send({ to: email, ...mail });
        if (enviado.preview) resposta.preview = enviado.preview;
      } catch (error) {
        // O cadastro DEU CERTO. Falhar o e-mail não pode virar erro para quem
        // acabou de criar a conta — ela vai entrar pelo redirecionamento, que é
        // o caminho principal. Fica no log.
        console.error("[portal] cadastro criado mas o e-mail não saiu:", error.message);
      }

      res.status(201).send(resposta);
    } catch (error) {
      console.error("[portal] falha no cadastro:", error.message);
      res.status(503).send({ msg: req.t("errors.internal"), code: "signup_failed" });
    }
  });

  // ── O ENDEREÇO JÁ RESPONDE? ──────────────────────────────────────────────
  //
  // O subdomínio nasce em duas etapas: o DNS é instantâneo, o CERTIFICADO não.
  // Enquanto o Pages não emite o dele, o navegador que chega ali leva uma tela
  // de erro de SSL — que, para quem acabou de se cadastrar, parece que o
  // cadastro falhou.
  //
  // Então a tela espera aqui em vez de redirecionar às cegas. É leitura pura, e
  // o limite é generoso porque quem chama está esperando de propósito.
  app.get("/public/portal/ready", async function (req, res) {
    const ip = clientIp(req);
    const limite = await rateLimit.checkShared("portalReady:" + ip, 40);
    if (!limite.allowed) return res.status(429).send({ code: "too_many_requests" });

    const host = String(req.query.host || "").trim().toLowerCase();
    if (!host) return res.status(400).send({ code: "missing_host" });

    try {
      const cf = app.cloudflare || cloudflareLib;
      const estado = await cf.domainStatus(host);
      // `active` é o que o Pages chama de pronto. Qualquer outra coisa —
      // pendente, inicializando, erro — é "ainda não", e a tela continua
      // esperando: dizer "pronto" cedo é o mesmo que não ter esperado.
      res.send({ ready: estado.ok && estado.status === "active" });
    } catch (error) {
      // Não conseguir perguntar não é "não está pronto" nem é erro para quem
      // espera — a tela tem prazo próprio e desiste sozinha.
      res.send({ ready: false });
    }
  });
};
