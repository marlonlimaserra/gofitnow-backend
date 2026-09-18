// AS AULAS COLETIVAS — a grade que se repete toda semana.
//
// Pedido do Marlon em 18/09/2026: *"crie aqui em configuração 'Aula coletiva',
// vai ser parecido com o aulões, a diferença é que vai resetar todo o dia,
// coloque para configurar horário mínimo para check-in etc, e em qual unidade
// aquela aula vai estar disponível"*.
//
// ── DUAS PERMISSÕES ──────────────────────────────────────────────────────
//
// LER é `people.view`: quem atende precisa ver a grade do dia para saber quem
// vai chegar.
//
// MEXER é `schedule.manage` — a mesma de quem organiza a agenda. Montar a
// grade é exatamente isso: decidir o que a casa oferece e quando.
const limiteDoPlano = require("../lib/limiteDoPlano.js");
const instanceContext = require("../lib/instance.js");
const arquivos = require("../lib/arquivos.js");
const dominio = require("../lib/domain.js");

module.exports = function (app) {
  const baseUrl = dominio.apiBaseUrl;
  // A contagem do teto, fora das rotas: a chamada a `barrou` tem de caber numa
  // linha com o `return` — ver `test/lib/limitesLigados.test.js`.
  const contarAulas = limiteDoPlano.contarNa(app, "group_classes");

  app.get("/group-classes", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const rows =
      req.query.todos === "1"
        ? await app.api.groupClass.list()
        : await app.api.groupClass.listActive();

    res.send({ rows: rows.map(paraTela(req)) });
  });

  // ── A GRADE DE HOJE ─────────────────────────────────────────────────────
  //
  // O que a tela de check-in precisa, numa ida só: quais aulas são hoje, se a
  // janela está aberta e quantos já entraram.
  //
  // O estado é calculado NO SERVIDOR, e não na tela. Dois motivos: o relógio
  // de quem abre a tela pode estar errado — e a janela decide se alguém conta
  // presença —, e o fuso que vale é o da CONTA, que a tela teria de saber
  // aplicar igualzinho. Uma conta feita em dois lugares é uma conta que
  // diverge.
  //
  // Antes do `/:id` porque "today" cairia nele como se fosse um id.
  app.get("/group-classes/today", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const fuso = await app.api.tenant.timezoneOfInstance();
    const agora = new Date();

    const aulas = await app.api.groupClass.listActive();
    const comEstado = aulas
      .map((a) => ({ aula: a, estado: app.api.groupClass.estadoAgora(a, agora, fuso) }))
      .filter((x) => x.estado.hoje);

    const dia = comEstado[0]?.estado?.data;
    const contagem = dia ? await app.api.groupClassCheckin.contagemDoDia(dia) : {};

    res.send({
      // O DIA vai na resposta: é a chave que o check-in usa para gravar, e
      // deixar a tela montá-la do relógio dela seria deixá-la gravar no dia
      // errado quando o relógio estiver errado.
      dia: dia || app.api.groupClass.estadoAgora({ dias: [] }, agora, fuso).data,
      rows: comEstado.map(({ aula, estado }) => ({
        ...paraTela(req)(aula),
        aberta: estado.aberta,
        // CADA horário com a sua janela: a aula das 07:00 e das 18:00 é a
        // mesma aula, mas às 07:10 só a primeira está aberta.
        horarios: estado.horarios,
        presentes: contagem[String(aula._id)] || 0,
      })),
    });
  });

  // O ENDEREÇO da capa, montado aqui e não guardado na aula. O documento
  // guarda só o ID: guardar a URL prenderia a aula ao endereço do backend do
  // dia em que a foto subiu.
  const urlDaCapa = (instancia, id) =>
    id ? `${baseUrl()}/public/group-class-image/${instancia}/${id}` : null;

  const paraTela = (req) => (a) => ({ ...a, coverUrl: urlDaCapa(req.instance, a.cover) });

  app.post("/group-classes", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    if (await limiteDoPlano.barrou(app, req, res, "groupClasses", contarAulas)) return;

    const id = await app.api.groupClass.insert(req.body || {});
    // Sem nome, sem hora ou sem dia não existe aula: ela nunca aconteceria.
    if (!id) return res.status(400).send({ msg: req.t("errors.groupClassIncomplete") });

    app.insertUserActionHistory(req, user, "create_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(id) },
    });

    res.status(201).send(paraTela(req)(await app.api.groupClass.data(id)));
  });

  // A ORDEM antes do `:id`, pela mesma razão do `today`.
  app.put("/group-classes/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const ok = await app.api.groupClass.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.groupClassSaved") });
  });

  app.put("/group-classes/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const existe = await app.api.groupClass.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    const ok = await app.api.groupClass.update(req.params.id, req.body || {});
    if (!ok) return res.status(400).send({ msg: req.t("errors.groupClassIncomplete") });

    app.insertUserActionHistory(req, user, "update_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(req.params.id) },
    });

    res.send(paraTela(req)(await app.api.groupClass.data(req.params.id)));
  });

  // ── APAGAR LEVA O HISTÓRICO JUNTO ──────────────────────────────────────
  //
  // Diferente da unidade, que é RECUSADA quando tem gente: ali as pessoas
  // continuam existindo e ficariam apontando para o nada. Aqui o que fica são
  // os check-ins daquela aula, que não têm vida própria — sem a aula, nenhuma
  // tela os alcança e nada os apagaria.
  app.delete("/group-classes/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.groupClass.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    await app.api.groupClass.remove(req.params.id);
    await app.api.groupClassCheckin.removeAllOf(req.params.id);
    // A capa vai junto: sem isto ela ficaria apontando para uma aula que não
    // existe, e nada a alcançaria.
    await app.api.groupClassImage.removeAllOf(req.params.id).catch(() => {});

    app.insertUserActionHistory(req, user, "delete_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(req.params.id) },
      extra: { nome: alvo.name },
    });

    res.send({ msg: req.t("ok.groupClassRemoved") });
  });

  // A CAPA sobe em `data:` no corpo, como a do plano e a da unidade: a tela já
  // reduz a imagem antes de enviar, e um `multipart` só para isto traria uma
  // dependência e um caminho de erro a mais.
  app.post("/group-classes/:id/cover", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.groupClass.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    const parsed = app.api.groupClassImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.groupClassImage.save(req.params.id, parsed.mime, parsed.buffer);

    res.status(201).send({ id: salva.id, url: urlDaCapa(req.instance, salva.id) });
  });

  // OS BYTES, sem sessão. A instância vai no CAMINHO porque aqui não há de
  // onde tirá-la: `<img src>` não manda cabeçalho nosso, e `/public/` não
  // passa pelo portão de instância.
  app.get("/public/group-class-image/:instance/:id", async function (req, res) {
    const instancia = instanceContext.normalize(req.params.instance);
    if (!instancia) return res.status(404).end();

    const img = await instanceContext.run(instancia, () =>
      app.api.groupClassImage.data(req.params.id)
    );
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
