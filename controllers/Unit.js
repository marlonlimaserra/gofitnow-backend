// AS UNIDADES DA CASA — os lugares onde ela atende.
//
// Pedido do Marlon em 18/09/2026: *"quero cadastrar unidades de academia sabe?
// não precisa ser exatamente de academia... foto da unidade, endereços de
// contatos, ícone da unidade etc... aí o aluno pode fazer parte ou não, de
// apenas 1 unidade"*.
//
// ── DUAS PERMISSÕES, e a diferença importa ───────────────────────────────
//
// LER é `people.view`: quem abre a ficha de alguém precisa ver e escolher a
// unidade dela, e essa é a permissão que a lista de pessoas já exige.
//
// MEXER é `users.manage` — a mesma de quem configura a instalação. Cadastrar
// uma unidade não é trabalho do dia a dia: acontece quando a casa abre uma
// filial, e é uma decisão de quem administra.
//
// ── A FOTO SAI SEM SESSÃO, e é de propósito ──────────────────────────────
//
// Mesma escolha da capa do plano: o endereço é o id do documento, opaco, e os
// bytes saem por uma rota nossa — o balde continua privado. Sem sessão porque
// um dia a unidade aparece na vitrine, e uma foto que exige login não aparece
// dentro do site de ninguém.
const instanceContext = require("../lib/instance.js");
const arquivos = require("../lib/arquivos.js");
const dominio = require("../lib/domain.js");

module.exports = function (app) {
  const baseUrl = dominio.apiBaseUrl;

  // O ENDEREÇO da foto, montado aqui e não guardado na unidade. O documento
  // guarda só o ID: guardar a URL inteira prenderia a unidade ao endereço do
  // backend do dia em que a foto subiu.
  const urlDaFoto = (instancia, id) =>
    id ? `${baseUrl()}/public/unit-image/${instancia}/${id}` : null;

  const paraTela = (req) => (u) => ({ ...u, photoUrl: urlDaFoto(req.instance, u.photo) });

  app.get("/units", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    // `?todos=1` traz também as desativadas — é a tela de configuração. Quem
    // escolhe a unidade de alguém só quer as que estão no ar.
    const rows =
      req.query.todos === "1" ? await app.api.unit.list() : await app.api.unit.listActive();

    res.send({ rows: rows.map(paraTela(req)) });
  });

  app.post("/units", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const id = await app.api.unit.insert(req.body || {});
    // Sem nome não há unidade: é o único campo que a tela exige, e o servidor
    // não pode confiar só nela.
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    app.insertUserActionHistory(req, user, "create_unit", {
      category: "settings",
      local: { target_type: "units", target_id: String(id) },
    });

    res.status(201).send(paraTela(req)(await app.api.unit.data(id)));
  });

  // A ORDEM antes do `:id`: sem isso, "order" cairia na rota de baixo como se
  // fosse um id — e um id inválido vira 404 em vez de reordenar.
  app.put("/units/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const ok = await app.api.unit.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.unitSaved") });
  });

  app.put("/units/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const existe = await app.api.unit.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.unitNotFound") });

    await app.api.unit.update(req.params.id, req.body || {});

    app.insertUserActionHistory(req, user, "update_unit", {
      category: "settings",
      local: { target_type: "units", target_id: String(req.params.id) },
    });

    res.send(paraTela(req)(await app.api.unit.data(req.params.id)));
  });

  // ── APAGAR UMA UNIDADE COM GENTE DENTRO É RECUSADO ─────────────────────
  //
  // O erro diz QUANTAS pessoas estão nela: é o número que faz entender o que
  // ia acontecer. Quem quer tirá-la do ar sem mexer em ninguém DESATIVA.
  app.delete("/units/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const alvo = await app.api.unit.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.unitNotFound") });

    const quantas = await app.api.unit.quantasPessoas(req.params.id);
    if (quantas > 0) {
      return res.status(409).send({ msg: req.t("errors.unitInUse", { count: quantas }) });
    }

    await app.api.unit.remove(req.params.id);

    app.insertUserActionHistory(req, user, "delete_unit", {
      category: "settings",
      local: { target_type: "units", target_id: String(req.params.id) },
      extra: { nome: alvo.name },
    });

    res.send({ msg: req.t("ok.unitRemoved") });
  });

  // A FOTO sobe em `data:` no corpo, como a capa do plano: a tela já reduz a
  // imagem antes de enviar, e um `multipart` só para isto traria uma
  // dependência e um caminho de erro a mais.
  app.post("/units/:id/photo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const alvo = await app.api.unit.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.unitNotFound") });

    const parsed = app.api.unitImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.unitImage.save(req.params.id, parsed.mime, parsed.buffer);

    res.status(201).send({ id: salva.id, url: urlDaFoto(req.instance, salva.id) });
  });

  // OS BYTES, sem sessão. A instância vai no CAMINHO porque aqui não há de
  // onde tirá-la: `<img src>` não manda cabeçalho nosso, e `/public/` não passa
  // pelo portão de instância.
  app.get("/public/unit-image/:instance/:id", async function (req, res) {
    const instancia = instanceContext.normalize(req.params.instance);
    if (!instancia) return res.status(404).end();

    const img = await instanceContext.run(instancia, () => app.api.unitImage.data(req.params.id));
    // 404 seco: aqui não há quem leia mensagem traduzida.
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.setHeader("Content-Type", img.mime);
    res.setHeader("ETag", etag);
    // Cache longo e `immutable`: o id nunca é reaproveitado — trocar a foto
    // gera outro documento —, então este endereço não segura imagem velha.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
  });
};
