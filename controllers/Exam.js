const limiteDoPlano = require("../lib/limiteDoPlano.js");
const { catalogoPara } = require("../lib/examMarkers.js");

module.exports = function (app) {
  // Os exames de sangue de uma pessoa.
  //
  // Espelha as rotas de suplementação de propósito: mesma forma de URL, mesmo
  // lugar para o escopo, mesma dupla de permissões. Quem integrou uma integra a
  // outra sem reler nada.
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  app.get("/people/:personId/exams", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exams.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const rows = await app.api.exam.list(trainer._id, student._id);

    res.send({
      rows,
      // O catálogo vai na resposta, já resolvido para o SEXO desta pessoa
      // (faixa de testosterona de homem e de mulher não dividem nem a ordem de
      // grandeza). Vai daqui e não cravado na tela pelo mesmo motivo das
      // unidades da suplementação: acrescentar um marcador amanhã é mexer num
      // lugar só, e nenhum navegador com cache fica oferecendo um catálogo que o
      // servidor já não reconhece.
      // `sex` é o campo da ficha (model/User_model.js) — não `gender`. Ler o
      // campo errado aqui devolvia a faixa masculina para TODAS as pessoas.
      catalog: catalogoPara(student.sex),
    });
  });

  app.post("/people/:personId/exams", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exams.manage");
    if (trainer === false) return;

    // O teto do plano — ver lib/limiteDoPlano.js.
    if (await limiteDoPlano.barrou(app, req, res, "exams", limiteDoPlano.contarNa(app, "exams"))) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    // A data da coleta é a IDENTIDADE do exame — é a coluna da tabela de
    // evolução. Sem ela o lançamento não tem onde existir.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.collectedAt || ""))) {
      res.status(400).send({ msg: req.t("errors.requireExamDate") });
      return;
    }
    // Exame sem nenhum marcador é uma coluna vazia na tabela: não há o que
    // comparar, e a tela ficaria com uma data órfã sem explicação.
    if (!app.api.exam.campos(body).markers.length) {
      res.status(400).send({ msg: req.t("errors.requireExamMarkers") });
      return;
    }

    const id = await app.api.exam.insert(trainer._id, student._id, body);
    const criado = await app.api.exam.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_exam", {
      category: "exams",
      local: { target_type: "exams", target_id: id + "", person: student._id },
      extra: {
        collectedAt: criado.collectedAt,
        markers: criado.markers.length,
        person: student.name,
        personId: student._id + "",
      },
    });

    res.status(201).send(criado);
  });

  app.put("/exams/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exams.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.collectedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.collectedAt))) {
      res.status(400).send({ msg: req.t("errors.requireExamDate") });
      return;
    }
    if (body.markers !== undefined && !app.api.exam.campos(body).markers.length) {
      res.status(400).send({ msg: req.t("errors.requireExamMarkers") });
      return;
    }

    const antes = await app.api.exam.data(trainer._id, req.params.id);

    const ok = await app.api.exam.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.examNotFound") });
      return;
    }

    const depois = await app.api.exam.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_exam", {
      category: "exams",
      local: { target_type: "exams", target_id: req.params.id + "", person: antes?.student },
      extra: { collectedAt: depois.collectedAt },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/exams/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exams.manage");
    if (trainer === false) return;

    const alvo = await app.api.exam.data(trainer._id, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.examNotFound") });
      return;
    }

    await app.api.exam.delete(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_exam", {
      category: "exams",
      local: { target_type: "exams", target_id: req.params.id + "", person: alvo?.student },
      extra: { collectedAt: alvo.collectedAt },
    });

    res.send({ msg: req.t("ok.examRemoved") });
  });
};
