const stripeReal = require("../lib/stripe.js");
const { enderecoDaInstancia } = require("../lib/enderecoDaInstancia.js");

// O PLANO DESTE CLIENTE, e a vitrine dos outros.
//
// O painel do center é quem cria e ordena os planos; este backend só LÊ, pela
// mesma porta por onde já lê os limites. O que existe aqui são duas perguntas
// que o produto faz:
//
//   "em que plano eu estou?"     — para o selo no topo do app
//   "quais existem?"             — para a tela de escolher
//
// Elas são duas rotas e não uma porque têm frequências muito diferentes: a
// primeira é pedida na abertura de todo app, a segunda só quando alguém toca no
// selo. Juntá-las mandaria a vitrine inteira em toda abertura.
module.exports = function (app) {
  // A Stripe é rede, e rede não entra em teste. Mesmo arranjo do painel
  // (`gofitnow-center-backend/controllers/Plan.js`): em produção `app.stripe`
  // não existe e vale o módulo de verdade; no teste ele é posto e a chamada
  // nunca sai da máquina.
  const stripe = app.stripe || stripeReal;

  // O plano de quem está pedindo.
  //
  // `null` quando o cliente não tem plano nenhum, e isso NÃO é o mesmo que estar
  // num plano gratuito: o app não mostra selo algum no primeiro caso, porque
  // "não sei em que plano você está" não é uma informação para dar a ninguém.
  app.get("/me/plan", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({ plan: await app.api.center.planFor(req.instance) });
  });

  // A vitrine, e qual deles é o atual.
  //
  // A CHAVE DO ATUAL VAI JUNTO, e não um booleano por linha: quem desenha a tela
  // precisa marcar "este é o seu" mesmo quando o plano atual saiu da vitrine —
  // um plano desativado no painel continua valendo para quem já o assinou, e
  // some da lista. Nesse caso ele vem também, no fim, marcado como fora de
  // catálogo. Sem isso a tela diria "escolha um plano" para quem já tem um, sem
  // mostrar qual.
  app.get("/me/plans", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const [rows, atual, cobranca, registro] = await Promise.all([
      app.api.center.plansForSale(),
      app.api.center.planFor(req.instance),
      app.api.center.cobranca(),
      app.api.center.byInstance(req.instance),
    ]);

    const naVitrine = atual && rows.some((p) => p.key === atual.key);

    res.send({
      rows: naVitrine || !atual ? rows : [...rows, { ...atual, foraDoCatalogo: true }],
      current: atual ? atual.key : null,
      // ── A VENDA ESTÁ LIGADA? ──────────────────────────────────────────────
      //
      // Vai JUNTO da vitrine porque a tela precisa saber antes do clique. Sem
      // isto o botão "Assinar" ficaria sempre aceso, e numa instalação sem
      // Stripe configurada cada clique seria uma viagem ao servidor para voltar
      // com "a cobrança não está ligada" — que é exatamente o botão que parece
      // quebrado.
      //
      // Só o SIM ou NÃO sai daqui. A chave secreta fica no servidor.
      canSubscribe: Boolean(cobranca.ligada && cobranca.secretKey),

      // ── O ESTADO DA ASSINATURA, PARA A TELA ────────────────────────────────
      //
      // `null` quando não existe cliente na Stripe, e é o que faz a tela não
      // oferecer "Gerenciar assinatura" a quem nunca pagou — um botão que abre
      // para dizer "você não tem assinatura" é um botão que não deveria estar
      // lá.
      //
      // Os IDs da Stripe NÃO saem: `cus_...` e `sub_...` não têm uso no
      // navegador, e tudo que se faz com eles é feito no servidor.
      subscription: registro?.stripeCustomerId
        ? {
            status: registro.stripeStatus || "",
            // Cancelou e ainda tem acesso até a data. São dois estados
            // diferentes para quem olha a tela, e um booleano só os separa.
            cancelAtPeriodEnd: Boolean(registro.cancelaNoFim),
            currentPeriodEnd: registro.periodoFimEm || null,
            trialEnd: registro.testeFimEm || null,
          }
        : null,
    });
  });

  // ── ASSINAR UM PLANO ────────────────────────────────────────────────────
  //
  // Devolve a URL da tela de pagamento da Stripe, e a tela redireciona. O
  // cartão nunca passa por aqui — ver `lib/stripe.js`.
  //
  // O que APLICA o plano não é esta rota: é o webhook, no painel. Aqui só se
  // abre a porta; quem confirma que o dinheiro entrou é a Stripe falando com o
  // painel depois. Aplicar o plano no retorno do navegador seria confiar em
  // quem voltou da tela de pagamento — e voltar dela não prova pagamento
  // nenhum, basta digitar a URL de sucesso.
  //
  // ── QUEM PODE ASSINAR ───────────────────────────────────────────────────
  //
  // `users.manage`, e a escolha merece a explicação porque não é obviamente a
  // certa: o que se quer dizer é "quem administra esta conta", e a chave que
  // diria isso — `billing.manage` — não pode ser criada hoje.
  //
  // Não pode porque `ensureSystemRoles` (que é o que joga permissão nova no
  // papel Administrador) só roda no PROVISIONAMENTO de uma instância, nunca no
  // boot de uma que já existe. Uma chave nova nasceria sem estar em papel
  // nenhum, e a rota devolveria 403 para todo mundo — inclusive para o dono.
  //
  // Então: `users.manage`, que já está no Administrador de toda instância viva,
  // e que nenhuma recepcionista tem. No dia em que existir reconciliação de
  // permissões para instância existente, isto vira `billing.manage`.
  //
  // O que NÃO serviu: conferir o e-mail contra `instances.email` no registro
  // central. Parece o mais honesto — pagar é ato de quem tem a conta — e é
  // frágil: trocar o e-mail de login aqui dentro não atualiza o registro
  // central, então o dono que trocou o e-mail ficaria sem poder pagar.
  app.post("/me/checkout", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    // Mesma trava do domínio próprio, pela mesma razão: assinar é decisão de
    // quem está na tela, com o cartão na mão. Chave de API não compra.
    if (req._viaApiKey) {
      return res
        .status(403)
        .send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
    }

    const cobranca = await app.api.center.cobranca();

    if (!cobranca.ligada || !cobranca.secretKey) {
      return res
        .status(503)
        .send({ msg: req.t("errors.billingOff"), code: "billing_off" });
    }

    let plano;
    try {
      plano = await app.api.center.planoParaCobranca(req.body?.plan);
    } catch (erro) {
      // Banco central fora do ar. 503 e não 404: "não achei o plano" mandaria a
      // tela dizer que o plano não existe, e ele existe.
      console.error("[checkout] registro central inalcançável:", erro.message);
      return res.status(503).send({ msg: req.t("errors.billingOff"), code: "central_down" });
    }

    // Quatro recusas diferentes, e cada uma com a frase dela: "não dá para
    // assinar" sem dizer por quê é o tipo de erro que volta como suporte.
    if (!plano) {
      return res.status(404).send({ msg: req.t("errors.planNotFound"), code: "plan_not_found" });
    }
    if (!plano.active) {
      return res.status(409).send({ msg: req.t("errors.planInactive"), code: "plan_inactive" });
    }
    if (plano.free || !plano.priceCents) {
      // Plano gratuito não tem checkout. Quem quer descer para ele está
      // CANCELANDO, que é outra coisa e ainda não existe.
      return res.status(400).send({ msg: req.t("errors.planIsFree"), code: "plan_is_free" });
    }
    if (!plano.stripePriceId) {
      // O plano existe no painel e não foi sincronizado com a Stripe. É falha
      // nossa, não da pessoa — e o log é o que faz alguém ir olhar.
      console.error("[checkout] plano sem preço na Stripe:", plano.key);
      return res
        .status(503)
        .send({ msg: req.t("errors.planNotSellable"), code: "plan_not_synced" });
    }

    // Já está nele? Abrir checkout do plano atual cobraria de novo e criaria uma
    // segunda assinatura em paralelo — duas cobranças por mês, para o mesmo
    // plano. A tela já não mostra o botão; isto é a trava do servidor.
    const atual = await app.api.center.planFor(req.instance);
    if (atual && atual.key === plano.key) {
      return res.status(409).send({ msg: req.t("errors.alreadyOnPlan"), code: "already_on_plan" });
    }

    const registro = await app.api.center.byInstance(req.instance);

    // ── PARA ONDE VOLTA DEPOIS DE PAGAR ─────────────────────────────────────
    //
    // O endereço vem do REGISTRO central, não do cabeçalho do navegador — o
    // mesmo cuidado do link de recuperação de senha, e pela mesma razão: quem
    // forjasse `X-Instance-Host` faria o retorno do pagamento apontar para um
    // domínio dele. Ver `lib/enderecoDaInstancia.js`.
    const casa = await enderecoDaInstancia(app);

    // `billing.successUrl` do painel sobrescreve, e existe para quem quer uma
    // página de obrigado própria. Fora isso, o certo é voltar para a casa DELE:
    // um endereço fixo mandaria todo cliente para a mesma página, e num produto
    // de vários clientes isso é uma tela estranha na hora mais delicada.
    const sucesso = cobranca.successUrl || `${casa}/planos?assinatura=ok`;

    const r = await stripe.criarCheckout({
      secretKey: cobranca.secretKey,
      priceId: plano.stripePriceId,
      instancia: req.instance,
      planoKey: plano.key,
      email: user.email,
      clienteId: registro?.stripeCustomerId || null,
      successUrl: sucesso,
      cancelUrl: `${casa}/planos?assinatura=cancelada`,
      trialDays: cobranca.trialDays,
    });

    if (!r.ok) {
      // O detalhe da Stripe vai para o LOG, não para a tela: ele fala de
      // `price_...` e de conta, que não é assunto de quem só quer pagar.
      console.error("[checkout] a Stripe recusou:", r.erro, r.detalhe || "");
      return res
        .status(502)
        .send({ msg: req.t("errors.checkoutFailed"), code: r.erro });
    }

    res.send({ url: r.url });
  });

  // ── GERENCIAR A ASSINATURA ──────────────────────────────────────────────
  //
  // Cancelar mora aqui, e junto com trocar cartão, mudar de plano e baixar
  // fatura — porque são a mesma tela do outro lado (ver `lib/stripe.js`).
  //
  // ── POR QUE NÃO EXISTE `DELETE /me/subscription` ────────────────────────
  //
  // Existiria um botão "cancelar" e acabaria a conversa? Não: cancelar de
  // verdade é decidir se vale hoje ou no fim do mês pago, mostrar até quando o
  // acesso dura, e deixar voltar atrás antes da data. Um `DELETE` que faz a
  // primeira metade e esquece as outras três é pior que não ter — ele tira o
  // acesso de quem pagou o mês e não dá caminho de volta.
  //
  // E tem o lado de quem opera: o dia em que alguém cancelar por engano, a
  // pergunta vai ser "quando, e por quê". A Stripe guarda as duas coisas
  // (inclusive o motivo escolhido); um `DELETE` nosso guardaria nenhuma.
  app.post("/me/billing-portal", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    // Mesma trava do checkout: cancelar é decisão de quem está na tela.
    if (req._viaApiKey) {
      return res
        .status(403)
        .send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
    }

    const cobranca = await app.api.center.cobranca();
    if (!cobranca.ligada || !cobranca.secretKey) {
      return res.status(503).send({ msg: req.t("errors.billingOff"), code: "billing_off" });
    }

    const registro = await app.api.center.byInstance(req.instance);

    // Sem cliente na Stripe não existe portal — e é o estado de quem nunca
    // pagou. A mensagem diz isso em vez de "erro ao abrir", que mandaria a
    // pessoa abrir chamado.
    if (!registro?.stripeCustomerId) {
      return res
        .status(409)
        .send({ msg: req.t("errors.noSubscription"), code: "no_subscription" });
    }

    const r = await stripe.abrirPortal({
      secretKey: cobranca.secretKey,
      clienteId: registro.stripeCustomerId,
      voltarPara: `${await enderecoDaInstancia(app)}/planos`,
    });

    if (!r.ok) {
      console.error("[portal] a Stripe recusou:", r.erro, r.detalhe || "");
      return res.status(502).send({ msg: req.t("errors.portalFailed"), code: r.erro });
    }

    res.send({ url: r.url });
  });

  // ── A VITRINE PÚBLICA, PARA O SITE DE VENDAS ────────────────────────────
  //
  // Sem sessão, sem instância: quem chama é o site (`vafit.app`), que é uma
  // página estática e não tem login nenhum. O portão de instância já libera
  // `/public/` — ver `lib/instanceGate.js`.
  //
  // ── Por que ela existe ──────────────────────────────────────────────────
  //
  // Porque o site tinha a escada de preços CRAVADA no código, e ela divergiu:
  // em 16/09/2026 ele anunciava "Essencial R$ 79" e "Profissional R$ 149"
  // enquanto a central vendia "Recém formado R$ 10" e "Profissional R$ 50".
  // Duas verdades sobre o próprio preço, e a que o cliente lia era a errada.
  //
  // Mudar preço no painel agora muda o site sem deploy — que é o ponto.
  //
  // ── O que sai, e o que NÃO sai ──────────────────────────────────────────
  //
  // Sai a mesma lista fechada da vitrine de dentro (`resumoDoPlano`), porque é
  // a mesma pergunta feita de fora. NÃO sai `canSubscribe` nem plano atual:
  // aqui não existe cliente, e um campo sobre "você" numa rota sem "você" só
  // pode ser mentira.
  //
  // É pública, então é um alvo: quem descobrir o endereço pode chamá-la em
  // laço. Por isso ela não toca no banco em toda chamada — `plansForSale`
  // guarda a resposta, e o cache é a mesma defesa que o `/public/theme` usa.
  app.get("/public/plans", async function (req, res) {
    const rows = await app.api.center.plansForSale();

    // ── O CACHE, E POR QUE ELE É CURTO ────────────────────────────────────
    //
    // Eram 300 segundos, escolhidos com o argumento de que "uma correção de
    // preço aparece no mesmo dia". O argumento estava certo e a pergunta era
    // outra: o Marlon trocou a exibição de um plano no painel, deu F5 no site,
    // não viu mudança nenhuma e concluiu que não havia salvado. Tinha salvado —
    // o banco e esta rota já respondiam o valor novo, e o que ele via era o
    // cache do navegador dele e o da borda.
    //
    // Cinco minutos de "parece que não funcionou" custam mais que cinco minutos
    // de tráfego. É o mesmo raciocínio dos caches internos deste projeto, que
    // são de dez segundos exatamente por isso (ver `Center_model`) — eu tinha
    // aplicado o critério lá e esquecido dele aqui.
    //
    // `stale-while-revalidate` é o que devolve o que se perde: passados os 30s,
    // a borda entrega a resposta velha NA HORA e busca a nova atrás. Ninguém
    // espera rede, e a próxima visita já vê o valor novo.
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=300");

    res.send({ rows });
  });
};
