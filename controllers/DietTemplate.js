// Os TEMPLATES DE DIETA: planos alimentares prontos, do profissional para ele mesmo.
//
// Irmão de `WorkoutTemplate`, com uma diferença que muda tudo: aqui o template
// carrega as REFEIÇÕES. Ver o comentário no topo de `DietTemplate_model`.
//
// Atrás de `diets.manage` — um template só existe para acelerar a criação de um
// plano, então quem não pode criar plano não tem o que fazer aqui. O dono vem
// SEMPRE da sessão, nunca do corpo da requisição.
module.exports = function (app) {
  app.get("/diet-templates", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    res.send(await app.api.dietTemplate.list(trainer._id));
  });

  // UM template, com as refeições dentro. É o que o formulário do plano pede ao
  // aplicar — a lista não traz o conteúdo (ver `list`).
  app.get("/diet-templates/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const doc = await app.api.dietTemplate.data(trainer._id, req.params.id);
    if (!doc) return res.status(404).send({ msg: req.t("errors.optionNotFound") });

    res.send(doc);
  });

  app.post("/diet-templates", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      return res.status(400).send({ msg: req.t("errors.requireDietName") });
    }

    // ── NASCER DE UM PLANO QUE JÁ EXISTE ────────────────────────────────────
    //
    // É o caminho principal, e não um extra: ninguém escreve seis refeições numa
    // tela de configuração. O que acontece é montar o plano de alguém, gostar do
    // resultado e querer reusá-lo.
    //
    // O plano é lido AQUI pelo id, e não recebido pronto do navegador: o corpo da
    // requisição não é lugar de confiar para copiar refeições — e o `data` do plano
    // já confere que ele é deste profissional.
    let base = body;

    if (body.fromDiet) {
      const plano = await app.api.diet.data(trainer._id, body.fromDiet);
      if (!plano) return res.status(404).send({ msg: req.t("errors.dietNotFound") });

      base = {
        // O nome vem do corpo quando a pessoa escreveu um: salvar como template é o
        // momento de dar o nome do template, que quase nunca é o nome do plano da
        // pessoa ("Dieta do João" não serve de template).
        name: body.name,
        goal: plano.goal,
        note: plano.note,
        weekdays: plano.weekdays,
        targetKcal: plano.targetKcal,
        targetProtein: plano.targetProtein,
        targetCarbs: plano.targetCarbs,
        targetFat: plano.targetFat,
        // Sem os `_id` das refeições do PLANO: o template é uma cópia, e herdar os
        // ids faria ele apontar para as refeições da dieta de origem. Quem preserva
        // id é a edição do próprio template (ver `DietTemplate_model.limpar`).
        meals: (plano.meals || []).map((r) => ({ ...r, _id: undefined })),
      };
    }

    const id = await app.api.dietTemplate.insert(trainer._id, base);
    const criado = await app.api.dietTemplate.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_diet_template", {
      category: "diets",
      local: { target_type: "diet_templates", target_id: id + "" },
      extra: {
        name: criado.name,
        meals: (criado.meals || []).length,
        // De qual plano saiu, quando saiu de um: é o que responde "de onde veio este
        // template?" seis meses depois.
        fromDiet: body.fromDiet ? String(body.fromDiet) : undefined,
      },
    });

    res.status(201).send(criado);
  });

  app.put("/diet-templates/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      return res.status(400).send({ msg: req.t("errors.requireDietName") });
    }

    const antes = await app.api.dietTemplate.data(trainer._id, req.params.id);
    if (!antes) return res.status(404).send({ msg: req.t("errors.optionNotFound") });

    // `{ ...antes, ...body }` porque `update` regrava o documento inteiro: sem isto,
    // uma edição só do nome apagaria as refeições — o campo ausente no corpo viraria
    // lista vazia.
    await app.api.dietTemplate.update(trainer._id, req.params.id, { ...antes, ...body });
    const depois = await app.api.dietTemplate.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_diet_template", {
      category: "diets",
      local: { target_type: "diet_templates", target_id: req.params.id + "" },
      extra: { name: depois.name },
      // As refeições ficam FORA do diff: um plano alimentar inteiro no histórico de
      // auditoria a cada edição de nome encheria a collection sem ninguém ler.
      diff: app.api.actionHistory.diff({ ...antes, meals: undefined }, { ...depois, meals: undefined }),
    });

    res.send(depois);
  });

  app.delete("/diet-templates/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const antes = await app.api.dietTemplate.data(trainer._id, req.params.id);
    if (!antes) return res.status(404).send({ msg: req.t("errors.optionNotFound") });

    await app.api.dietTemplate.delete(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_diet_template", {
      category: "diets",
      local: { target_type: "diet_templates", target_id: req.params.id + "" },
      extra: { name: antes.name },
    });

    res.send({ msg: req.t("ok.optionRemoved") });
  });

  // ── CRIAR O PLANO DE UMA PESSOA A PARTIR DE UM TEMPLATE ──────────────────
  //
  // Uma rota, e não "cria o plano vazio e depois copia as refeições": em dois
  // passos, uma falha no segundo deixaria a pessoa com um plano vazio e com cara de
  // defeito. Aqui ou nasce completo, ou não nasce.
  //
  // As DATAS vêm do corpo, porque elas são do plano e não do template — é a única
  // coisa que a tela ainda precisa perguntar.
  app.post("/people/:personId/diets/from-template/:templateId", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) return res.status(404).send({ msg: req.t("errors.studentNotFound") });

    const template = await app.api.dietTemplate.data(trainer._id, req.params.templateId);
    if (!template) return res.status(404).send({ msg: req.t("errors.optionNotFound") });

    const body = req.body || {};

    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      return res.status(400).send({ msg: req.t("errors.endBeforeStart") });
    }

    const id = await app.api.diet.insert(trainer._id, student._id, {
      // O nome pode ser trocado na hora de aplicar: "Cutting 1800" serve de template
      // e serve de nome do plano, mas quem quiser "Plano da Maria — agosto" escreve.
      name: body.name || template.name,
      goal: template.goal,
      note: template.note,
      weekdays: template.weekdays,
      targetKcal: template.targetKcal,
      targetProtein: template.targetProtein,
      targetCarbs: template.targetCarbs,
      targetFat: template.targetFat,
      startDate: body.startDate || "",
      endDate: body.endDate || "",
    });

    // As refeições entram em seguida, pelo mesmo caminho que a tela usa para
    // salvá-las (`saveMeals`), que é quem gera `_id` novo para cada uma. Dois planos
    // criados do mesmo template não compartilham id de refeição.
    if ((template.meals || []).length) {
      // Também sem os `_id` do template: dois planos criados do mesmo template
      // ficariam com refeições de id igual, e um dia alguém vai escrever uma
      // consulta por id de refeição sem imaginar que ela repete entre planos.
      await app.api.diet.saveMeals(
        trainer._id,
        id,
        template.meals.map((r) => ({ ...r, _id: undefined }))
      );
    }

    const criada = await app.api.diet.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_diet", {
      category: "diets",
      local: { target_type: "diets", target_id: id + "" },
      extra: {
        name: criada.name,
        person: student.name,
        personId: student._id + "",
        // Qual template gerou este plano. Sem isto, "por que a dieta dela tem estas
        // refeições?" não tem resposta no histórico.
        fromTemplate: String(template._id),
        templateName: template.name,
      },
    });

    res.status(201).send(criada);
  });
};
