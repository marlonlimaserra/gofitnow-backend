const arquivos = require("../lib/arquivos.js");
const instanceContext = require("../lib/instance.js");
const dominio = require("../lib/domain.js");
const categorias = require("../lib/categoriasDeConta.js");

// A MESMA normalização do modelo: "ENEL", "Enel" e "enel" são o mesmo
// fornecedor, e é por ela que a sugestão sabe o que a casa já tem.
// O que o Mongo devolve num campo binário não é sempre a mesma coisa: por
// padrão o driver entrega um `Binary` do BSON, cujo `.buffer` é o Buffer de
// verdade, e com `promoteBuffers` entrega o Buffer direto.
//
// A diferença morde: um Buffer TAMBÉM tem `.buffer` — o ArrayBuffer do pool
// interno, de 64 KB —, e testar por ele primeiro transformaria uma logo de 4
// bytes em 65.536. Por isso o Buffer é reconhecido ANTES. É a mesma regra de
// `bytesDaLogo` em `model/Supplier_model.js`.
const bytesDaImagem = (data) => {
  if (Buffer.isBuffer(data)) return data;
  if (data?.buffer) return Buffer.from(data.buffer);
  return Buffer.from(data);
};

const chave = (nome) =>
  String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

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

  // A logo do CATÁLOGO não pertence a instância nenhuma: é a nossa lista de
  // empresas conhecidas, a mesma para todo cliente. Por isso o endereço não
  // leva o nome da casa.
  const urlDaLogoDoCatalogo = (id) => `${baseUrl()}/public/known-supplier-image/${id}`;

  const paraTela = (req) => (f) => ({ ...f, photoUrl: urlDaFoto(req.instance, f.photo) });

  app.get("/suppliers", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    // `todos=1` traz também os desativados — é o que a tela de cadastro usa. O
    // seletor do formulário pede só os ativos: oferecer quem saiu faria alguém
    // lançar uma conta para um fornecedor que a casa já dispensou.
    // ── DUAS LEITURAS, E ELAS PEDEM COISAS DIFERENTES ───────────────────
    //
    // `todos=1` é a ABA que administra os fornecedores: ela pagina, busca,
    // ordena e conta as contas de cada um — e mostra também os DESATIVADOS,
    // porque é a única tela de onde se reativa um.
    //
    // Sem ele é o SELETOR do formulário de conta: ele precisa de todos os
    // nomes ATIVOS de uma vez, sem página nenhuma. Oferecer quem a casa
    // dispensou faria alguém lançar uma conta para ele.
    if (req.query.todos === "1") {
      const r = await app.api.supplier.pagina({
        busca: req.query.q,
        ordem: req.query.sort,
        direcao: req.query.dir,
        pagina: req.query.page,
        limite: req.query.limit,
      });

      return res.send({
        rows: r.rows.map(paraTela(req)),
        total: r.total,
        pagina: r.pagina,
        porPagina: r.porPagina,
        categorias: categorias.paraTela(req.t),
      });
    }

    const rows = await app.api.supplier.listActive();

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

  // ── PROCURAR NO CATÁLOGO DA CASA ────────────────────────────────────────
  //
  // *"o certo seria eu clicar em 'novo fornecedor' e, assim que eu digitar o
  // nome, já aparece um search select que busca da central; aí se ele clicar,
  // já puxa os dados da central, copia foto etc."* (24/09/2026).
  //
  // Sugestão, e não importação: volta o que casa com o que foi digitado, e o
  // trabalho de copiar acontece quando alguém ESCOLHE uma. É a diferença entre
  // ajudar a cadastrar a Enel e entregar cento e dezoito empresas que a casa
  // nunca vai pagar.
  //
  // `finance.manage`, e não `view`: quem procura aqui está cadastrando.
  app.get("/suppliers/catalogo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const achados = await app.api.center.procurarConhecidos(req.query.q);
    const comLogo = await app.api.center.idsComLogo(achados.map((c) => c._id));

    // Os que a casa JÁ tem saem da lista: sugerir de novo a Enel cadastrada
    // levaria a um segundo cadastro com o mesmo nome — e o duplicado só
    // aparece no dia em que alguém lança a conta no errado.
    const daCasa = new Set((await app.api.supplier.list()).map((f) => chave(f.name)));

    res.send({
      rows: achados
        .filter((c) => !daCasa.has(chave(c.name)))
        .map((c) => ({
          id: String(c._id),
          name: c.name,
          categoria: c.categoria || "",
          defaultDescription: c.defaultDescription || "",
          site: c.site || "",
          // A LOGO da marca, e não um ícone genérico: *"tire esse ícone de
          // I.A, coloque a foto da empresa"* (24/09/2026). Uma estrelinha ao
          // lado de "Vivo" não diz nada; a logo da Vivo diz tudo.
          //
          // Uma URL, e não os bytes: a lista aparece a cada tecla, e as
          // imagens é que tornariam isso caro. A rota é pública e cacheada, e
          // a mesma logo serve toda casa que digitar "vivo".
          //
          // `null` quando não existe, para a tela não pedir uma imagem que vai
          // voltar 404 — oito delas por digitação.
          logoUrl: comLogo.has(String(c._id)) ? urlDaLogoDoCatalogo(String(c._id)) : null,
        })),
    });
  });

  // CRIAR A PARTIR DO CATÁLOGO — um, o escolhido, com a logo copiada.
  //
  // A logo é COPIADA, e não apontada: é a mesma promessa do resto do catálogo —
  // o que a casa importou é dela, e uma troca nossa depois não mexe no que já
  // está lá.
  app.post("/suppliers/catalogo/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const conhecido = await app.api.center.conhecido(req.params.id);
    if (!conhecido) return res.status(404).send({ msg: req.t("errors.supplierNotFound") });

    const logos = await app.api.center.logosDeConhecidos([String(conhecido._id)]);
    const r = await app.api.supplier.importarConhecidos([conhecido], logos);

    // Já existia com esse nome: devolve o que a casa tem, em vez de um segundo
    // cadastro igual. Quem clicou queria o fornecedor, não um registro novo.
    const daCasa = (await app.api.supplier.list()).find((f) => chave(f.name) === chave(conhecido.name));
    if (!daCasa) return res.status(500).send({ msg: req.t("errors.supplierNotFound") });

    app.insertUserActionHistory(req, user, "create_supplier", {
      category: "finance",
      local: { target_type: "suppliers", target_id: String(daCasa._id) },
      extra: { doCatalogo: true, criados: r.criados },
    });

    res.status(r.criados ? 201 : 200).send(paraTela(req)(daCasa));
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
  // A LOGO DO CATÁLOGO — pública, como a do fornecedor da casa.
  //
  // Pública pela mesma razão: é uma marca de empresa, não dado de cliente, e
  // uma tag `<img>` não manda cabeçalho de sessão. Sem instância no caminho —
  // o catálogo é um só.
  //
  // Cache de uma semana e `immutable`: a logo da Vivo não muda, e esta rota é
  // chamada a cada tecla digitada em toda casa que cadastra um fornecedor.
  app.get("/public/known-supplier-image/:id", async function (req, res) {
    const img = await app.api.center.logoDeConhecido(req.params.id);
    if (!img?.data || !img.mime) return res.status(404).end();

    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.send(bytesDaImagem(img.data));
  });

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
