module.exports = function (app) {
  // As avaliações físicas de uma pessoa.
  //
  // Mesma forma das rotas de treino e de dieta: quem integrou uma integra esta
  // sem reler nada.
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  app.get("/people/:personId/assessments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    // A pessoa vai junto porque TODA conta desta tela depende dela: idade e
    // sexo entram nas fórmulas de dobras, e sem eles a tela mostraria campos
    // vazios sem explicar por quê.
    res.send({
      rows: await app.api.assessment.list(trainer._id, student._id),
      person: {
        _id: student._id,
        name: student.name,
        sex: student.sex || "",
        birthDate: student.birthDate || "",
      },
    });
  });

  // Abre uma coleta. Ela nasce RASCUNHO e vazia.
  //
  // Nasce no banco antes de ter qualquer número porque é isso que salva o
  // trabalho: a partir daqui cada campo digitado é um PUT, e uma queda de luz
  // custa o último campo em vez da coleta inteira.
  //
  // Por isso não há exigência de peso e altura aqui — elas valem na hora de
  // fechar a coleta, não na de começá-la. E por isso não há registro no
  // histórico de ações: quem abriu um formulário ainda não fez nada.
  app.post("/people/:personId/assessments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    // Um rascunho por pessoa: havendo um em aberto, a tela continua dele. Sem
    // isso, cada clique abandonado deixaria uma coleta vazia para trás.
    const emAberto = await app.api.assessment.draftOf(trainer._id, student._id);
    if (emAberto) {
      res.status(200).send(emAberto);
      return;
    }

    const id = await app.api.assessment.insert(trainer._id, student._id, {
      ...(req.body || {}),
      draft: true,
    });

    res.status(201).send(await app.api.assessment.data(trainer._id, id));
  });

  app.get("/assessments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.view");
    if (trainer === false) return;

    const assessment = await app.api.assessment.data(trainer._id, req.params.id);
    if (!assessment) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    res.send(assessment);
  });

  app.put("/assessments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.manage");
    if (trainer === false) return;

    const body = req.body || {};
    const antes = await app.api.assessment.data(trainer._id, req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    // Peso e altura são o mínimo para FECHAR uma coleta: sem os dois não há
    // IMC, e sem IMC a avaliação não diz nada que a pessoa não soubesse. Num
    // rascunho ainda em preenchimento a exigência não se aplica — ela chegaria
    // antes de o campo existir.
    const fechando = body.draft === false;
    if (fechando && (!body.weight || !body.height)) {
      res.status(400).send({ msg: req.t("errors.requireWeightHeight") });
      return;
    }

    const ok = await app.api.assessment.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    const depois = await app.api.assessment.data(trainer._id, req.params.id);

    // O histórico de ações registra COLETAS, não teclas.
    //
    // Salvando a cada campo digitado, registrar todo PUT encheria o histórico
    // de dezenas de entradas por avaliação e afogaria tudo o mais que a conta
    // fez no dia. O que vale é o momento em que o rascunho vira avaliação — e
    // depois disso, cada edição de verdade.
    if (fechando && antes.draft) {
      app.insertUserActionHistory(req, trainer, "create_assessment", {
        category: "assessments",
        local: { target_type: "assessments", target_id: req.params.id + "" },
        extra: { personId: antes.student + "", weight: depois.weight },
      });
    } else if (!antes.draft) {
      app.insertUserActionHistory(req, trainer, "update_assessment", {
        category: "assessments",
        local: { target_type: "assessments", target_id: req.params.id + "" },
        diff: app.api.actionHistory.diff(antes, depois),
      });
    }

    res.send(depois);
  });

  // ── Fotos de evolução ───────────────────────────────────────────────────
  //
  // Uma rota por LADO, e só quatro lados existem: frente, direita, esquerda e
  // costas. Não há rota que acrescente foto — subir de novo no mesmo lado
  // substitui aquela.
  //
  // É o que impede a avaliação de virar álbum: o teto não é uma contagem que
  // alguém precisa lembrar de checar, é o formato da rota. E é o que faz a
  // comparação funcionar, porque comparar depende de ser sempre o mesmo ângulo.
  async function coletaEFoto(req, res, permissao) {
    const trainer = await app.helpers.ReqProtected.can(req, res, permissao);
    if (trainer === false) return false;

    if (!app.api.assessmentPhoto.isSide(req.params.side)) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return false;
    }

    const assessment = await app.api.assessment.data(trainer._id, req.params.id);
    if (!assessment) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return false;
    }

    return { trainer, assessment };
  }

  app.get("/assessments/:id/photos/:side", async function (req, res) {
    const ctx = await coletaEFoto(req, res, "assessments.view");
    if (ctx === false) return;

    const foto = await app.api.assessmentPhoto.data(req.params.id, req.params.side);
    if (!foto) {
      res.status(404).send({ msg: req.t("errors.noPhotoShort") });
      return;
    }

    // `private` porque é conteúdo de uma sessão — e aqui mais que no avatar:
    // é a foto do corpo de um cliente. Um proxy compartilhado não pode guardar
    // isto e servir para outra pessoa.
    const versao = '"' + new Date(foto.updatedAt).getTime() + '"';

    res.setHeader("Content-Type", foto.mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("ETag", versao);

    if (req.headers["if-none-match"] === versao) {
      res.status(304).end();
      return;
    }

    res.send(foto.data.buffer ? Buffer.from(foto.data.buffer) : foto.data);
  });

  app.put("/assessments/:id/photos/:side", async function (req, res) {
    const ctx = await coletaEFoto(req, res, "assessments.manage");
    if (ctx === false) return;

    const parsed = app.api.assessmentPhoto.parseDataUri((req.body || {}).image);
    if (!parsed) {
      res.status(400).send({ msg: req.t("errors.invalidImage") });
      return;
    }

    const at = await app.api.assessmentPhoto.save(
      req.params.id,
      req.params.side,
      parsed.mime,
      parsed.buffer
    );

    // O carimbo vai para o documento da coleta: é por ele que a listagem sabe
    // quais fotos existem sem tocar nos bytes.
    await app.api.assessment.setPhoto(ctx.trainer._id, req.params.id, req.params.side, at);

    res.send({ side: req.params.side, at });
  });

  app.delete("/assessments/:id/photos/:side", async function (req, res) {
    const ctx = await coletaEFoto(req, res, "assessments.manage");
    if (ctx === false) return;

    await app.api.assessmentPhoto.remove(req.params.id, req.params.side);
    await app.api.assessment.clearPhoto(ctx.trainer._id, req.params.id, req.params.side);

    res.send({ side: req.params.side });
  });

  app.delete("/assessments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.manage");
    if (trainer === false) return;

    const alvo = await app.api.assessment.data(trainer._id, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    // As fotos vão junto: elas são referenciadas pela coleta, e sem isto os
    // bytes ficariam no banco para sempre sem nada apontando para eles.
    await app.api.assessmentPhoto.deleteAllOfAssessment(req.params.id);
    await app.api.assessment.delete(trainer._id, req.params.id);

    // Descartar um rascunho não é apagar uma avaliação: nada foi entregue a
    // ninguém, e registrar isso no histórico seria contar como exclusão o
    // fechar de um formulário.
    if (!alvo.draft) {
      app.insertUserActionHistory(req, trainer, "delete_assessment", {
        category: "assessments",
        local: { target_type: "assessments", target_id: req.params.id + "" },
        extra: { weight: alvo.weight },
      });
    }

    res.send({ msg: req.t("ok.assessmentRemoved") });
  });
};
