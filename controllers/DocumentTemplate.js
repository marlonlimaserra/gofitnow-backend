const { camposParaTela, documentoModelo } = require("../lib/documentoModelo.js");
const { logoDaCasa } = require("../lib/logoDaCasa.js");

// OS MODELOS DE DOCUMENTO — Configurações → Modelos de documento.
//
// *"em configurações, quero mais um menu chamado template de documento, pois
// geralmente a academia pede pro aluno assinar uns termos etc."*
//
// ── AS PERMISSÕES SÃO AS QUE JÁ EXISTEM ─────────────────────────────────
//
// `people.view` para LER a lista, porque quem abre a ficha de um aluno precisa
// escolher um modelo no seletor "Gerar documento". `users.manage` para MEXER,
// que é a mesma chave das unidades: cadastrar o termo que a casa inteira usa é
// decisão de quem administra, não de quem atende.
//
// Uma chave nova (`documents.*`) teria de ser concedida a todos os tipos de
// usuário que já existem — e até alguém fazer isso, a tela nasceria invisível
// para o dono da conta.
module.exports = function (app) {
  app.get("/document-templates", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    // `?ativos=1` é o que o seletor da ficha pede: um modelo desativado não
    // deve aparecer para gerar, mas continua na tela de configuração.
    const rows = await app.api.documentTemplate.listar({
      somenteAtivos: req.query.ativos === "1",
    });

    res.send({
      rows,
      // Os campos que o editor oferece, já traduzidos — o mesmo caminho dos
      // outros catálogos: um campo novo aparece na tela sem tocar no frontend.
      campos: camposParaTela(req.t),
    });
  });

  app.get("/document-templates/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const modelo = await app.api.documentTemplate.data(req.params.id);
    if (!modelo) return res.status(404).send({ msg: req.t("errors.templateNotFound") });

    res.send(modelo);
  });

  app.post("/document-templates", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const id = await app.api.documentTemplate.insert(req.body || {});
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    const arquivo = app.api.documentTemplate.parseArquivo((req.body || {}).arquivo);
    if (arquivo) await app.api.documentTemplate.saveArquivo(id, arquivo);

    app.insertUserActionHistory(req, user, "create_document_template", {
      category: "admin",
      local: { target_type: "document_templates", target_id: String(id) },
    });

    res.status(201).send(await app.api.documentTemplate.data(id));
  });

  app.put("/document-templates/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const existe = await app.api.documentTemplate.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.templateNotFound") });

    const ok = await app.api.documentTemplate.update(req.params.id, req.body || {});
    if (!ok) return res.status(400).send({ msg: req.t("errors.requireName") });

    const arquivo = app.api.documentTemplate.parseArquivo((req.body || {}).arquivo);
    if (arquivo) await app.api.documentTemplate.saveArquivo(req.params.id, arquivo);

    app.insertUserActionHistory(req, user, "update_document_template", {
      category: "admin",
      local: { target_type: "document_templates", target_id: String(req.params.id) },
    });

    res.send(await app.api.documentTemplate.data(req.params.id));
  });

  app.delete("/document-templates/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const ok = await app.api.documentTemplate.remove(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.templateNotFound") });

    res.send({ msg: req.t("ok.templateRemoved") });
  });

  // ── A PRÉVIA de um modelo em TEXTO ──────────────────────────────────────
  //
  // *"coloca lá o visualizador para eu poder ver o documento sem precisar
  // baixar"*.
  //
  // É a MESMA folha que o aluno recebe — mesmo papel, mesma logo, mesmo
  // cabeçalho —, só que sem pessoa nenhuma. Os campos viram a linha sublinhada
  // que eles já viram quando o dado falta, e é exatamente isso que se quer ver:
  // onde o nome vai cair, e se a frase em volta faz sentido com ele.
  //
  // Gerar a prévia com um aluno de mentira ("João da Silva") seria mais bonito
  // e pior: esconderia justamente o caso que quebra o texto, que é o campo
  // vazio.
  app.get("/document-templates/:id/previa", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const modelo = await app.api.documentTemplate.data(req.params.id);
    if (!modelo) return res.status(404).send({ msg: req.t("errors.templateNotFound") });
    if (modelo.tipo !== "html") {
      return res.status(400).send({ msg: req.t("errors.templateNotText") });
    }

    const [fuso, casa] = await Promise.all([
      app.api.tenant.timezoneOfInstance(),
      app.api.tenant.dataOfInstance(),
    ]);

    const html = documentoModelo({
      modelo,
      // Sem pessoa de propósito — ver acima.
      pessoa: null,
      casa,
      marca: await logoDaCasa(casa?.theme),
      lang: req.lang,
      fuso,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // `no-store`: a prévia carrega a logo e o nome da casa, e muda a cada
    // edição do modelo. Um proxy guardando isto serviria o termo de ontem.
    res.setHeader("Cache-Control", "private, no-store");
    res.send(html);
  });

  // ── O ARQUIVO de um modelo do tipo `arquivo` ────────────────────────────
  //
  // `people.view` para ler: é o termo em branco da casa, e quem atende precisa
  // conseguir imprimi-lo para o aluno assinar.
  //
  // Serve com a mesma régua dos outros anexos: só imagem e PDF saem `inline`;
  // o resto vira download, e `nosniff` vai em tudo. Ver `controllers/Employee.js`
  // para o porquê.
  app.get("/document-templates/:id/arquivo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const arquivo = await app.api.documentTemplate.arquivoDe(req.params.id);
    if (!arquivo) return res.status(404).send({ msg: req.t("errors.noAttachment") });

    const abre = app.api.personDocument.podeSairInline(arquivo.mime);
    const nome = String(arquivo.name || "documento").replace(/["\\]/g, "");

    res.setHeader("Content-Type", abre ? arquivo.mime : "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", `${abre ? "inline" : "attachment"}; filename="${nome}"`);

    res.send(arquivo.data?.buffer ? Buffer.from(arquivo.data.buffer) : arquivo.data);
  });
};
