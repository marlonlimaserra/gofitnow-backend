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
const modelosDeCartao = require("../lib/modelosDeCartao.js");
const instanceContext = require("../lib/instance.js");
const arquivos = require("../lib/arquivos.js");
const dominio = require("../lib/domain.js");

module.exports = function (app) {
  const baseUrl = dominio.apiBaseUrl;

  // O ENDEREÇO da capa, montado aqui e não guardado no plano.
  //
  // O documento guarda só o ID da imagem. Guardar a URL inteira prenderia o
  // plano ao endereço do backend do dia em que a capa foi enviada — e este
  // sistema já mudou de endereço uma vez.
  const urlDaCapa = (instancia, id) =>
    id ? `${baseUrl()}/public/membership-image/${instancia}/${id}` : null;
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
      rows: rows.map((p) => ({ ...p, coverUrl: urlDaCapa(req.instance, p.cover) })),
      // Os BENEFÍCIOS vão junto: eles são o que cada plano marca, e a tela não
      // consegue desenhar nem o cartão nem a tabela sem os nomes deles.
      beneficios: await app.api.membershipBenefit.list(),
      // E as CADÊNCIAS, já traduzidas — o mesmo catálogo que a recorrência usa,
      // porque é a mesma pergunta: de quanto em quanto tempo isto cobra.
      //
      // Junto, e não numa rota própria: a tela precisa das três listas para
      // desenhar, e três chamadas a fariam piscar em três tempos.
      cadencias: recorrencia.paraTela(req.t),
      // Os MODELOS DE COR, pela mesma razão das cadências: é um catálogo, ele
      // viaja traduzido, e acrescentar um modelo é mexer num arquivo só.
      modelos: modelosDeCartao.paraTela(req.t),
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

  // O RASCUNHO, criado no clique de "Novo plano" — antes de a pessoa digitar
  // qualquer coisa. É o que dá um id à capa desde o primeiro momento; ver o
  // modelo.
  //
  // Antes do `:id` pela mesma razão do `order` logo abaixo.
  app.post("/memberships/draft", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const moeda = await app.api.tenant.currencyFor();
    const id = await app.api.membership.rascunho(moeda);

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

  // ── A CAPA ──────────────────────────────────────────────────────────────
  //
  // Sobe em `data:` no corpo, como a do aulão e a do avatar: a tela já reduz a
  // imagem antes de enviar, e um `multipart` só para isto traria uma dependência
  // e um caminho de erro a mais.
  //
  // Devolve a URL pronta — é ela que a tela põe no formulário e manda de volta
  // no `cover` ao salvar.
  app.post("/memberships/:id/cover", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const alvo = await app.api.membership.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.membershipNotFound") });

    const parsed = app.api.membershipImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.membershipImage.save(req.params.id, parsed.mime, parsed.buffer);

    res.status(201).send({ id: salva.id, url: urlDaCapa(req.instance, salva.id) });
  });

  // OS BYTES, sem sessão: a vitrine é pública, e a capa é parte dela.
  //
  // A instância vai no CAMINHO porque aqui não há de onde tirá-la: `<img src>`
  // não manda cabeçalho nosso, e `/public/` não passa pelo portão de instância.
  app.get("/public/membership-image/:instance/:id", async function (req, res) {
    const instancia = instanceContext.normalize(req.params.instance);
    if (!instancia) return res.status(404).end();

    const img = await instanceContext.run(instancia, () =>
      app.api.membershipImage.data(req.params.id)
    );
    // 404 seco: aqui não há quem leia mensagem traduzida.
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.setHeader("Content-Type", img.mime);
    res.setHeader("ETag", etag);
    // Cache longo e `immutable`: o id nunca é reaproveitado — trocar a capa gera
    // outro documento —, então não há como este endereço segurar imagem velha.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
  });

  app.post("/memberships/:id/clone", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const id = await app.api.membership.duplicate(req.params.id);
    if (!id) return res.status(404).send({ msg: req.t("errors.membershipNotFound") });

    app.insertUserActionHistory(req, user, "create_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(id) },
      extra: { clonadoDe: String(req.params.id) },
    });

    res.status(201).send(await app.api.membership.data(id));
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
      const [planos, beneficios, moedas] = await Promise.all([
        app.api.membership.listActive(),
        app.api.membershipBenefit.listActive(),
        app.api.tenant.currencyOfInstance(),
      ]);

      return { planos, beneficios, moeda: moedas.currency };
    });

    // ── SÓ OS CAMPOS DO CARTÃO ────────────────────────────────────────────
    //
    // Montado à mão, e não `...plano`. O documento tem `createdBy`, `order`,
    // `updatedAt` — nada disso desenha nada, e uma vitrine que devolve o
    // documento inteiro vaza o próximo campo que alguém acrescentar sem pensar
    // nisto aqui.
    const beneficiosVisiveis = dados.beneficios.map((b) => ({
      id: String(b._id),
      name: b.name,
      description: b.description || "",
      icone: b.icone || "",
      iconeSvg: b.iconeSvg || "",
      iconeCaixa: b.iconeCaixa || "",
    }));

    const validos = new Set(beneficiosVisiveis.map((b) => b.id));

    res.setHeader("Cache-Control", "public, max-age=60");

    res.send({
      moeda: dados.moeda,
      beneficios: beneficiosVisiveis,
      cadencias: recorrencia.paraTela(req.t),
      planos: dados.planos.map((p) => ({
        id: String(p._id),
        name: p.name,
        tagline: p.tagline || "",
        description: p.description || "",
        amount: p.amount || 0,
        currency: p.currency || dados.moeda,
        cadencia: p.cadencia,
        fidelidadeMeses: p.fidelidadeMeses || 0,
        destaque: p.destaque === true,
        coverUrl: urlDaCapa(instancia, p.cover),
        // ── A APARÊNCIA ESCOLHIDA ───────────────────────────────────────
        //
        // Elas viram `style=` no cartão, então saem daqui já validadas pelo
        // modelo: hex de seis dígitos ou vazio, nunca uma string livre. Vazio
        // é "usa a cor da marca", e é o que a esmagadora maioria dos planos
        // vai mandar.
        corFundo: p.corFundo || "",
        corTexto: p.corTexto || "",
        corDestaque: p.corDestaque || "",
        corBotao: p.corBotao || "",
        corBotaoTexto: p.corBotaoTexto || "",
        // ── O BOTÃO APARECE MESMO SEM LINK ──────────────────────────────
        //
        // *"na vitrine não aparecem os botões"*.
        //
        // Eu tinha escondido o botão sem destino, com o argumento de que porta
        // pintada é pior que parede. Errado para esta tela: o cartão SEM botão
        // não é um cartão honesto, é um cartão incompleto — ele termina na
        // lista de benefícios e não convida a nada, e o lugar onde ele vive é
        // justamente uma página de venda.
        //
        // Quem ainda não pôs o link vê o botão e entende o que falta. A tela
        // de edição diz onde preenchê-lo.
        botaoTexto: p.botaoTexto || "",
        botaoLink: p.botaoLink || "",
        // O DESENHO vem do nosso banco, conferido contra a lista fechada de
        // tags de `lib/iconify.js`. A vitrine nunca fala com a Iconify: ela
        // abre dentro do site do cliente, e um ícone que depende de um
        // terceiro responder é um buraco no cartão de venda dele.
        botaoIconeSvg: p.botaoIconeSvg || "",
        botaoIconeCaixa: p.botaoIconeCaixa || "",
        // Benefício DESATIVADO some do cartão junto com a linha da tabela:
        // deixá-lo aqui faria o cartão prometer algo que a comparação nem lista.
        beneficios: (p.beneficios || []).map(String).filter((id) => validos.has(id)),
      })),
    });
  });

  // ── Benefícios: as linhas da tabela de comparação ───────────────────────

  app.get("/membership-benefits", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const rows =
      req.query.todos === "1"
        ? await app.api.membershipBenefit.list()
        : await app.api.membershipBenefit.listActive();

    res.send({ rows });
  });

  app.post("/membership-benefits", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const id = await app.api.membershipBenefit.insert(req.body || {});
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    res.status(201).send(await app.api.membershipBenefit.data(id));
  });

  app.put("/membership-benefits/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const ok = await app.api.membershipBenefit.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.membershipSaved") });
  });

  app.put("/membership-benefits/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const existe = await app.api.membershipBenefit.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.membershipBenefitNotFound") });

    await app.api.membershipBenefit.update(req.params.id, req.body || {});
    res.send(await app.api.membershipBenefit.data(req.params.id));
  });

  app.delete("/membership-benefits/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const feito = await app.api.membershipBenefit.remove(req.params.id);

    if (feito?.erro === "notFound") {
      return res.status(404).send({ msg: req.t("errors.membershipBenefitNotFound") });
    }
    if (feito?.erro === "inUse") {
      return res.status(409).send({
        msg: req.t("errors.membershipBenefitInUse", { count: feito.quantos }),
        code: "in_use",
      });
    }

    res.send({ msg: req.t("ok.membershipBenefitRemoved") });
  });
};
