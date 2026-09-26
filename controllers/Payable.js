const categorias = require("../lib/categoriasDeConta.js");
const arquivos = require("../lib/arquivos.js");
const statusDeCobranca = require("../lib/statusDeCobranca.js");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");

// CONTAS A PAGAR — a luz, o telefone, o aluguel, a folha.
//
// *"crie mais um módulo chamado de contas a pagar para lançar conta de luz,
// telefone etc… por unidade também"*.
//
// ── A PERMISSÃO É A DO FINANCEIRO, e é uma escolha para revisitar ───────
//
// `finance.view` / `finance.manage`, as mesmas das cobranças. Uma chave nova
// (`payables.*`) teria de ser concedida a todos os tipos de usuário que já
// existem — e até alguém fazer isso, o módulo nasceria invisível para o dono da
// conta, que é o contrário do que ele quer.
//
// O argumento a favor de separar é real e tem nome: FOLHA. Quem lança a conta
// de luz não é necessariamente quem pode ver quanto se paga de salário. No dia
// em que isso incomodar, a chave nova entra — e este comentário é onde a
// conversa começa.
module.exports = function (app) {
  // O fuso da conta, para a janela do mês bater com o calendário de quem olha.
  // Num `try` porque uma leitura de configuração que falha não pode derrubar a
  // tela que mostra o dinheiro.
  async function fusoDaConta() {
    try {
      return await app.api.tenant.timezoneOfInstance();
    } catch (erro) {
      console.warn("[payables] fuso:", erro.message);
      return undefined;
    }
  }

  app.get("/payables", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const { rows, total, pagina, limite, resumo, porCategoria } = await app.api.payable.listar({
      de: req.query.de,
      ate: req.query.ate,
      status: req.query.status,
      categoria: req.query.categoria,
      busca: req.query.q,
      ...lenteDeUnidade.recorte(user, req.query.unit),
      // "Da casa toda" é um recorte de verdade, e não a ausência de filtro: o
      // contador e o software não pertencem a unidade nenhuma, e quem fecha o
      // custo de Paraty precisa poder olhar os dois separados.
      semUnidade: req.query.semUnidade === "1",
      ordem: req.query.sort,
      direcao: req.query.dir,
      pagina: req.query.page,
      limite: req.query.limit,
      fuso: await fusoDaConta(),
    });

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows,
      resumo,
      // O relatório por categoria vem na MESMA resposta: é a mesma janela, e
      // pedi-lo à parte seria varrer o mês duas vezes para desenhar uma tela.
      porCategoria,
      total,
      pagina,
      limite,
      currency: moedas.currency,
      currencies: moedas.currencies,
      // Os catálogos, já traduzidos — o mesmo caminho do resto do financeiro:
      // uma categoria nova aparece sem ninguém mexer no frontend.
      categorias: categorias.paraTela(req.t),
      status: statusDeCobranca.paraTela(req.t),
    });
  });

  app.get("/payables/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const conta = await app.api.payable.data(req.params.id);
    if (!conta) return res.status(404).send({ msg: req.t("errors.payableNotFound") });

    res.send(conta);
  });

  app.post("/payables", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    // O comprovante é lido ANTES de gravar: um arquivo recusado tem de virar
    // 400 com o motivo certo, e não uma conta salva sem o anexo que a pessoa
    // achou que tinha mandado.
    const corpo = req.body || {};
    let comprovante;
    if (corpo.receipt) {
      comprovante = app.api.payable.parseReceipt(corpo.receipt);
      if (!comprovante) return res.status(400).send({ msg: req.t("errors.invalidReceipt") });
    }

    const moedas = await app.api.tenant.currencyOfInstance();
    const id = await app.api.payable.insert(corpo, user._id, moedas.currency);
    // Sem descrição não há conta: a linha não diria o que é.
    if (!id) return res.status(400).send({ msg: req.t("errors.payableNoDescription") });

    if (comprovante) await app.api.payable.saveReceipt(id, comprovante);

    app.insertUserActionHistory(req, user, "create_payable", {
      category: "finance",
      local: { target_type: "payables", target_id: String(id) },
      extra: { valor: Number((req.body || {}).amount) || 0 },
    });

    res.status(201).send(await app.api.payable.data(id));
  });

  app.put("/payables/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const existe = await app.api.payable.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.payableNotFound") });

    const corpo = req.body || {};
    let comprovante;
    if (corpo.receipt?.dataUri) {
      comprovante = app.api.payable.parseReceipt(corpo.receipt);
      if (!comprovante) return res.status(400).send({ msg: req.t("errors.invalidReceipt") });
    }

    const ok = await app.api.payable.update(req.params.id, corpo);
    if (!ok) return res.status(400).send({ msg: req.t("errors.payableNoDescription") });

    if (comprovante) await app.api.payable.saveReceipt(req.params.id, comprovante);
    // `receipt: null` explícito é "tirei o anexo" — diferente de não mandar o
    // campo, que numa edição significa "não mexa".
    else if (corpo.receipt === null) await app.api.payable.removeReceipt(req.params.id);

    app.insertUserActionHistory(req, user, "update_payable", {
      category: "finance",
      local: { target_type: "payables", target_id: String(req.params.id) },
    });

    res.send(await app.api.payable.data(req.params.id));
  });

  // O COMPROVANTE, com SESSÃO: é a nota fiscal da casa, e um endereço aberto
  // seria o boleto de alguém circulando em link.
  app.get("/payables/:id/receipt", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const doc = await app.api.payable.receiptOf(req.params.id);
    if (!doc) return res.status(404).send({ msg: req.t("errors.payableNotFound") });

    res.setHeader("Content-Type", doc.mime);
    // `inline` para a imagem abrir na aba e o PDF no leitor do navegador. O
    // nome é escapado: ele veio de um arquivo que alguém nomeou.
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(doc.name || "comprovante").replace(/"/g, "")}"`
    );

    const bytes = await arquivos.bytesDoDocumento(doc);
    if (!bytes) return res.status(404).end();

    res.send(bytes);
  });

  app.delete("/payables/:id/receipt", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const alvo = await app.api.payable.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.payableNotFound") });

    await app.api.payable.removeReceipt(req.params.id);
    res.send({ msg: req.t("ok.payableRemoved") });
  });

  app.delete("/payables/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const alvo = await app.api.payable.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.payableNotFound") });

    await app.api.payable.remove(req.params.id);

    app.insertUserActionHistory(req, user, "delete_payable", {
      category: "finance",
      local: { target_type: "payables", target_id: String(req.params.id) },
      extra: { descricao: alvo.description || "" },
    });

    res.send({ msg: req.t("ok.payableRemoved") });
  });
};
