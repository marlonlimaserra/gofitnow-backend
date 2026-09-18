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

module.exports = function (app) {
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

    res.send({ rows });
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
        ...aula,
        aberta: estado.aberta,
        abreEm: estado.abreEm,
        fechaEm: estado.fechaEm,
        presentes: contagem[String(aula._id)] || 0,
      })),
    });
  });

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

    res.status(201).send(await app.api.groupClass.data(id));
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

    res.send(await app.api.groupClass.data(req.params.id));
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

    app.insertUserActionHistory(req, user, "delete_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(req.params.id) },
      extra: { nome: alvo.name },
    });

    res.send({ msg: req.t("ok.groupClassRemoved") });
  });
};
