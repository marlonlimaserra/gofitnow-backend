const { documentoDieta } = require("../lib/documentoDieta.js");
const { registrarRotasDeDocumento } = require("../lib/rotasDeDocumento.js");

module.exports = function (app) {
  // Os planos alimentares de uma pessoa.
  //
  // Espelham as rotas de treino de propósito: mesma forma de URL, mesmo formato
  // de resposta, mesmo lugar para o escopo. Quem integrou uma integra a outra
  // sem reler nada.
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  app.get("/people/:personId/diets", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const rows = await app.api.diet.list(trainer._id, student._id);

    res.send({
      rows,
      counts: {
        current: rows.filter((d) => d.status === "current").length,
        past: rows.filter((d) => d.status === "past").length,
        future: rows.filter((d) => d.status === "future").length,
        all: rows.length,
      },
    });
  });

  app.post("/people/:personId/diets", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireDietName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const id = await app.api.diet.insert(trainer._id, student._id, body);
    const criada = await app.api.diet.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_diet", {
      category: "diets",
      local: { target_type: "diets", target_id: id + "" },
      extra: { name: criada.name, person: student.name, personId: student._id + "" },
    });

    res.status(201).send(criada);
  });

  app.get("/diets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.view");
    if (trainer === false) return;

    const diet = await app.api.diet.data(trainer._id, req.params.id);
    if (!diet) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    // O nome da pessoa vem junto: fora da ficha dela, "Plano de agosto" não
    // identifica de quem é.
    const student = await app.api.user.data(diet.student);
    res.send({ ...diet, student: student ? { _id: student._id, name: student.name } : null });
  });

  app.put("/diets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireDietName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const antes = await app.api.diet.data(trainer._id, req.params.id);

    const ok = await app.api.diet.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    const depois = await app.api.diet.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_diet", {
      category: "diets",
      local: { target_type: "diets", target_id: req.params.id + "" },
      extra: { name: depois.name },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/diets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const alvo = await app.api.diet.data(trainer._id, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    await app.api.diet.delete(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_diet", {
      category: "diets",
      local: { target_type: "diets", target_id: req.params.id + "" },
      extra: { name: alvo.name },
    });

    res.send({ msg: req.t("ok.dietRemoved") });
  });

  // As refeições, salvas TODAS de uma vez.
  //
  // Mesma escolha da rota de exercícios do treino: a tela edita o dia inteiro e
  // salva uma vez. Uma rota por refeição multiplicaria o número de chamadas sem
  // dar nada em troca — e deixaria o plano num estado meio salvo se uma delas
  // falhasse no meio.
  app.put("/diets/:id/meals", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const { meals } = req.body || {};
    if (!Array.isArray(meals)) {
      res.status(400).send({ msg: req.t("errors.requireMeals") });
      return;
    }

    const ok = await app.api.diet.saveMeals(trainer._id, req.params.id, meals);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    const atualizada = await app.api.diet.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_diet_meals", {
      category: "diets",
      local: { target_type: "diets", target_id: req.params.id + "" },
      extra: { name: atualizada.name, meals: atualizada.mealCount },
    });

    res.send(atualizada);
  });

  // ── O DOCUMENTO DO PLANO ALIMENTAR ────────────────────────────────────
  //
  // As mesmas três rotas da avaliação física, pela mesma fábrica. Pedido do
  // Marlon: *"faça o mesmo para o plano alimentar, todas essas opções, coloque
  // no app e web também"*.
  registrarRotasDeDocumento(app, {
    base: "diets",
    prefixoDoArquivo: "plano-alimentar",
    chaveDoAssunto: "email.diet.subject",
    chaveDeOk: "ok.dietEmailed",
    acao: "email_diet",

    montar: async function (req, res) {
      const trainer = await app.helpers.ReqProtected.can(req, res, "diets.view");
      if (trainer === false) return null;

      // `data` já devolve o plano com as refeições ordenadas pelo horário e com
      // os totais calculados — inclusive a regra de que só a primeira opção de
      // cada grupo conta. A folha não recalcula nada disso: recalcular seria
      // criar uma segunda verdade sobre o mesmo plano.
      const diet = await app.api.diet.data(trainer._id, req.params.id);
      if (!diet) {
        res.status(404).send({ msg: req.t("errors.dietNotFound") });
        return null;
      }

      const [student, fuso] = await Promise.all([
        app.api.user.dataStudent(trainer._id, diet.student),
        app.api.tenant.timezoneOfInstance(),
      ]);

      const html = documentoDieta({
        diet,
        person: student,
        lang: trainer.lang || req.language,
        fuso,
      });

      // A data do arquivo é a de INÍCIO do plano, não a de hoje: dois planos
      // baixados em dias diferentes ficariam com nomes diferentes para o mesmo
      // conteúdo, e o de ontem pareceria outro documento.
      return { trainer, pessoa: student, html, nome: student?.name, data: diet.startDate };
    },
  });
};
