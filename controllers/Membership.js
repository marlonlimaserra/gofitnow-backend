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
// ── A VITRINE PÚBLICA NÃO ESTÁ AQUI ──────────────────────────────────────
//
// De propósito: ele ainda está decidindo o formato (*"ainda estou decidindo como
// vai ser"*). Tudo aqui exige sessão. Quando a vitrine existir, ela vai ser uma
// rota pública NOVA, que lê `listActive` — e não um afrouxamento destas.
const recorrencia = require("../lib/recorrencia.js");

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
