const arquivos = require("../lib/arquivos.js");
const instanceContext = require("../lib/instance.js");
const dominio = require("../lib/domain.js");
const categorias = require("../lib/categoriasDeConta.js");

// OS FORNECEDORES — quem recebe o dinheiro que sai.
//
// *"Fornecedor, em cima ponha 'novo fornecedor', aí abre um dialog para digitar
// todos os dados do fornecedor e foto"*.
//
// A permissão é a do financeiro, como a das contas: quem lança a conta é quem
// cadastra para quem ela é. Separar as duas faria alguém ter de pedir a um
// colega para cadastrar a Enel antes de conseguir lançar a conta de luz.
module.exports = function (app) {
  const baseUrl = dominio.apiBaseUrl;

  const urlDaFoto = (instancia, id) =>
    id ? `${baseUrl()}/public/supplier-image/${instancia}/${id}` : null;

  const paraTela = (req) => (f) => ({ ...f, photoUrl: urlDaFoto(req.instance, f.photo) });

  app.get("/suppliers", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    // `todos=1` traz também os desativados — é o que a tela de cadastro usa. O
    // seletor do formulário pede só os ativos: oferecer quem saiu faria alguém
    // lançar uma conta para um fornecedor que a casa já dispensou.
    const rows =
      req.query.todos === "1"
        ? await app.api.supplier.list()
        : await app.api.supplier.listActive();

    res.send({ rows: rows.map(paraTela(req)), categorias: categorias.paraTela(req.t) });
  });

  app.post("/suppliers", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const id = await app.api.supplier.insert(req.body || {});
    // Sem nome não há fornecedor: a linha da conta não diria para quem foi.
    if (!id) return res.status(400).send({ msg: req.t("errors.supplierNoName") });

    app.insertUserActionHistory(req, user, "create_supplier", {
      category: "finance",
      local: { target_type: "suppliers", target_id: String(id) },
    });

    res.status(201).send(paraTela(req)(await app.api.supplier.data(id)));
  });

  // ── USAR OS DO VAFIT ────────────────────────────────────────────────────
  //
  // Traz o catálogo da central e cria o que ainda não existe. Pode ser clicado
  // duas vezes sem medo: o que já está lá não é tocado — nem duplicado, nem
  // sobrescrito. É exatamente o que acontece quando alguém não lembra se já
  // clicou.
  app.post("/suppliers/importar", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const conhecidos = await app.api.center.fornecedoresConhecidos();

    // ── O RECORTE POR UF ──────────────────────────────────────────────────
    //
    // Distribuidora é regional: a Enel não atende o Paraná. Sem a UF vêm todos,
    // que é o certo para quem não disse onde está — uma lista com dez
    // distribuidoras é melhor que uma sem a que ele usa.
    const uf = String(req.query.uf || "").trim().toUpperCase();
    const filtrados = uf
      ? conhecidos.filter((c) => !c.ufs?.length || c.ufs.includes(uf))
      : conhecidos;

    // As logos vêm em bloco, numa consulta só — uma por fornecedor seriam cento
    // e dezoito idas ao banco do painel dentro de um clique.
    const logos = await app.api.center.logosDeConhecidos(filtrados.map((c) => c._id));

    const r = await app.api.supplier.importarConhecidos(filtrados, logos);

    app.insertUserActionHistory(req, user, "import_suppliers", {
      category: "finance",
      local: { target_type: "suppliers", target_id: "catalogo" },
      extra: r,
    });

    res.send({ ...r, rows: (await app.api.supplier.listActive()).map(paraTela(req)) });
  });

  app.put("/suppliers/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const existe = await app.api.supplier.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.supplierNotFound") });

    const ok = await app.api.supplier.update(req.params.id, req.body || {});
    if (!ok) return res.status(400).send({ msg: req.t("errors.supplierNoName") });

    app.insertUserActionHistory(req, user, "update_supplier", {
      category: "finance",
      local: { target_type: "suppliers", target_id: String(req.params.id) },
    });

    res.send(paraTela(req)(await app.api.supplier.data(req.params.id)));
  });

  // ── APAGAR UM FORNECEDOR COM CONTAS É RECUSADO ──────────────────────────
  //
  // O erro diz QUANTAS contas apontam para ele: é o número que faz entender o
  // que ia acontecer — trinta linhas de histórico deixariam de dizer para quem
  // o dinheiro foi.
  //
  // Quem quer só tirá-lo da lista DESATIVA. É a mesma regra da unidade.
  app.delete("/suppliers/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const alvo = await app.api.supplier.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.supplierNotFound") });

    const quantas = await app.api.supplier.quantasContas(req.params.id);
    if (quantas > 0) {
      return res.status(409).send({ msg: req.t("errors.supplierInUse", { count: quantas }) });
    }

    await app.api.supplier.remove(req.params.id);

    app.insertUserActionHistory(req, user, "delete_supplier", {
      category: "finance",
      local: { target_type: "suppliers", target_id: String(req.params.id) },
      extra: { nome: alvo.name },
    });

    res.send({ msg: req.t("ok.supplierRemoved") });
  });

  // A FOTO sobe em `data:` no corpo, como a da unidade: a tela já reduz a
  // imagem antes de enviar, e um `multipart` só para isto traria uma
  // dependência e um caminho de erro a mais.
  app.post("/suppliers/:id/photo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const alvo = await app.api.supplier.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.supplierNotFound") });

    const parsed = app.api.supplierImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.supplierImage.save(req.params.id, parsed.mime, parsed.buffer);

    res.status(201).send({ id: salva.id, url: urlDaFoto(req.instance, salva.id) });
  });

  // A INSTÂNCIA está no caminho porque esta rota é aberta: ela chega sem
  // sessão, e as imagens moram no banco de um cliente.
  //
  // Não é vazamento: o endereço é o id opaco da foto, e ele só aparece embutido
  // na tela de quem já está dentro.
  app.get("/public/supplier-image/:instance/:id", async function (req, res) {
    const instance = instanceContext.normalize(req.params.instance);
    if (!instance) return res.status(404).end();

    const img = await instanceContext.run(instance, () =>
      app.api.supplierImage.data(req.params.id)
    );
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';

    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.send(bytes);
  });
};
