// OS PLANOS DA CASA, e as linhas que os comparam.
//
// Pedido do Marlon em 17/09/2026: *"como pretendo oferecer para academias, ai eu
// crio a recorrencia com um plano"*, com a página da Smart Fit ao lado.
//
// ── DUAS PERMISSÕES, e a diferença importa ───────────────────────────────
//
// LER é `finance.view`: quem cadastra a recorrência de alguém precisa escolher o
// plano, e essa é a permissão que a aba Financeiro da ficha já exige.
//
// MEXER é `finance.manage`: mudar o cardápio é mudar o preço do que a casa
// vende, e é a escrita mais cara desta tela.
//
// ── E A VITRINE PÚBLICA, que é uma rota À PARTE ──────────────────────────
//
// *"crie um botão ver vitrine, aí você monta uma rota pública... pois em breve
// nossos clientes vão criar um iframe dentro do site deles com essa URL"*.
//
// Ela é OUTRA rota (`/public/memberships`) e não um afrouxamento destas, e a
// diferença é o que ela devolve: só o que está À VENDA, e só os campos que o
// cartão desenha. Sem contagem de assinantes, sem quem assinou, sem nada que a
// academia não tenha escolhido pendurar na parede.
const recorrencia = require("../lib/recorrencia.js");
const instanceContext = require("../lib/instance.js");

module.exports = function (app) {
  // ── Planos ──────────────────────────────────────────────────────────────

  app.get("/memberships", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    // `?todos=1` traz também os desativados — é a tela de configuração. Quem
    // monta uma recorrência só quer os que estão à venda.
    const rows =
      req.query.todos === "1" ? await app.api.membership.list() : await app.api.membership.listActive();

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows,
      // As CATEGORIAS vão junto: elas são o que cada plano marca, e a tela não
      // consegue desenhar nem o cartão nem a tabela sem os nomes delas.
      categorias: await app.api.membershipCategory.list(),
      // E as CADÊNCIAS, já traduzidas — o mesmo catálogo que a recorrência usa,
      // porque é a mesma pergunta: de quanto em quanto tempo isto cobra.
      //
      // Junto, e não numa rota própria: a tela precisa das três listas para
      // desenhar, e três chamadas a fariam piscar em três tempos.
      cadencias: recorrencia.paraTela(req.t),
      currency: moedas.currency,
    });
  });

  app.post("/memberships", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      return res.status(400).send({ msg: req.t("errors.requireName") });
    }

    const moeda = await app.api.tenant.currencyFor(body.currency);
    const id = await app.api.membership.insert(body, moeda);

    app.insertUserActionHistory(req, user, "create_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(id) },
      extra: { name: body.name, amount: Number(body.amount) || 0 },
    });

    res.status(201).send(await app.api.membership.data(id));
  });

  // A ORDEM antes do `:id`: sem isso, "order" cairia na rota de baixo como se
  // fosse um id — e um id inválido vira 404 em vez de reordenar.
  app.put("/memberships/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const ok = await app.api.membership.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.membershipSaved") });
  });

  app.put("/memberships/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const existe = await app.api.membership.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.membershipNotFound") });

    await app.api.membership.update(req.params.id, req.body || {});

    app.insertUserActionHistory(req, user, "update_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(req.params.id) },
    });

    res.send(await app.api.membership.data(req.params.id));
  });

  app.delete("/memberships/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const feito = await app.api.membership.remove(req.params.id);

    if (feito?.erro === "notFound") {
      return res.status(404).send({ msg: req.t("errors.membershipNotFound") });
    }
    // O NÚMERO vai na mensagem: "não dá para apagar" sem dizer quantos deixaria
    // a pessoa procurando onde. Ver o modelo — desativar é o caminho.
    if (feito?.erro === "inUse") {
      return res.status(409).send({
        msg: req.t("errors.membershipInUse", { count: feito.quantas }),
        code: "in_use",
      });
    }

    app.insertUserActionHistory(req, user, "delete_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(req.params.id) },
    });

    res.send({ msg: req.t("ok.membershipRemoved") });
  });

  // ── A VITRINE, aberta ───────────────────────────────────────────────────
  //
  // De qual academia é esta vitrine sai do HOST, como na página pública da
  // agenda e na do aulão. `/public/` não passa pelo portão de instância (ver
  // `lib/instanceGate.js`), então quem resolve é a rota — e ela ENTRA no
  // contexto antes de tocar no banco, senão os modelos estouram de propósito.
  async function instanciaDoHost(req, res) {
    const host = String(
      req.query.host ||
        req.headers["x-instance-host"] ||
        req.headers["x-forwarded-host"] ||
        req.headers.host ||
        ""
    );

    const registro = await app.api.center.byHost(host);
    if (!registro || registro.active === false || registro.active === 0) {
      // 404 seco: aqui não há sessão nem idioma, e ninguém lê mensagem
      // traduzida dentro de um iframe no site de outra pessoa.
      res.status(404).send({ msg: "unknown" });
      return false;
    }

    return registro.instance;
  }

  app.get("/public/memberships", async function (req, res) {
    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const dados = await instanceContext.run(instancia, async () => {
      const [planos, categorias, moedas] = await Promise.all([
        app.api.membership.listActive(),
        app.api.membershipCategory.listActive(),
        app.api.tenant.currencyOfInstance(),
      ]);

      return { planos, categorias, moeda: moedas.currency };
    });

    // ── SÓ OS CAMPOS DO CARTÃO ────────────────────────────────────────────
    //
    // Montado à mão, e não `...plano`. O documento tem `createdBy`, `order`,
    // `updatedAt` — nada disso desenha nada, e uma vitrine que devolve o
    // documento inteiro vaza o próximo campo que alguém acrescentar sem pensar
    // nisto aqui.
    const categoriasVisiveis = dados.categorias.map((c) => ({
      id: String(c._id),
      name: c.name,
      description: c.description || "",
    }));

    const validas = new Set(categoriasVisiveis.map((c) => c.id));

    res.setHeader("Cache-Control", "public, max-age=60");

    res.send({
      moeda: dados.moeda,
      categorias: categoriasVisiveis,
      cadencias: recorrencia.paraTela(req.t),
      planos: dados.planos.map((p) => ({
        id: String(p._id),
        name: p.name,
        description: p.description || "",
        amount: p.amount || 0,
        currency: p.currency || dados.moeda,
        cadencia: p.cadencia,
        fidelidadeMeses: p.fidelidadeMeses || 0,
        destaque: p.destaque === true,
        // Categoria DESATIVADA some do cartão junto com a linha da tabela:
        // deixá-la aqui faria o cartão prometer um benefício que a comparação
        // nem lista.
        categorias: (p.categorias || []).map(String).filter((id) => validas.has(id)),
      })),
    });
  });

  // ── Categorias: as linhas da tabela de comparação ───────────────────────

  app.get("/membership-categories", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const rows =
      req.query.todos === "1"
        ? await app.api.membershipCategory.list()
        : await app.api.membershipCategory.listActive();

    res.send({ rows });
  });

  app.post("/membership-categories", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const id = await app.api.membershipCategory.insert(req.body || {});
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    res.status(201).send(await app.api.membershipCategory.data(id));
  });

  app.put("/membership-categories/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const ok = await app.api.membershipCategory.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.membershipSaved") });
  });

  app.put("/membership-categories/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const existe = await app.api.membershipCategory.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.membershipCategoryNotFound") });

    await app.api.membershipCategory.update(req.params.id, req.body || {});
    res.send(await app.api.membershipCategory.data(req.params.id));
  });

  app.delete("/membership-categories/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const feito = await app.api.membershipCategory.remove(req.params.id);

    if (feito?.erro === "notFound") {
      return res.status(404).send({ msg: req.t("errors.membershipCategoryNotFound") });
    }
    if (feito?.erro === "inUse") {
      return res.status(409).send({
        msg: req.t("errors.membershipCategoryInUse", { count: feito.quantos }),
        code: "in_use",
      });
    }

    res.send({ msg: req.t("ok.membershipCategoryRemoved") });
  });
};
