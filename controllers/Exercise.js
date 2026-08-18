module.exports = function (app) {
  // O catálogo de exercícios: o compartilhado, que é igual para todo mundo, mais
  // o que ESTA conta criou. Os dois na mesma lista, em ordem alfabética — quem
  // monta treino não precisa saber de onde cada um veio, só que o "Afundo +
  // remada cross + alter" dele está ali, ao lado do original.
  //
  // Escrever é sempre na conta. Não existe caminho no app para alterar o
  // compartilhado: `Exercise_model.update` e `.delete` filtram por instância, e
  // uma tentativa em cima de um compartilhado devolve 404 por não achar nada
  // que seja seu. O botão da tela para esse caso é "Editar", e ele CRIA a sua
  // versão em vez de mudar a de todos — foi o pedido que trouxe isto aqui.

  // Muscle groups in use, for the filter dropdown.
  app.get("/exercises/groups", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    res.send(await app.api.exercise.groups());
  });

  // ?search=&group=&page=&limit=&mine=1
  //
  // `mine=1` é a tela "Meus exercícios", nas configurações: a mesma lista sem o
  // catálogo compartilhado, para poder editar e apagar o que é seu sem procurar
  // entre mil e quatrocentos que não são.
  app.get("/exercises", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    res.send(
      await app.api.exercise.list({
        search: req.query.search,
        muscleGroup: req.query.group,
        page: req.query.page,
        limit: req.query.limit,
        onlyMine: req.query.mine === "1",
        // `demo=1` — só o que já tem a demonstração em 3D. É o filtro que
        // separa o que está pronto do que ainda falta animar.
        comClipe: req.query.demo === "1",
      })
    );
  });

  app.post("/exercises", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
    if (trainer === false) return;

    const body = req.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireExerciseName") });
      return;
    }

    const id = await app.api.exercise.insert(body);
    const created = await app.api.exercise.data(id);

    app.insertUserActionHistory(req, trainer, "create_exercise", {
      category: "exercises",
      local: { target_type: "exercises", target_id: id + "" },
      extra: { name: created.name, muscleGroup: created.muscleGroup },
    });

    res.status(201).send(created);
  });

  // A DEMONSTRAÇÃO EM 3D, servida como imagem — uma por PADRÃO de movimento.
  //
  // Rota pública porque `<img src>` não manda cabeçalho de sessão — e pode ser
  // pública sem susto: é um boneco fazendo agachamento, igual para todos os
  // clientes, sem nome, foto ou dado de ninguém dentro.
  //
  // Um ano e `immutable`, e a tela põe a data da gravação no endereço (`?v=`).
    //
    // As duas coisas andam juntas: `immutable` é a promessa de que o endereço
    // nunca muda de conteúdo, e o endereço é o nome do MOVIMENTO, que regravar
    // mantém. Sem o `?v=` a promessa é mentira — e o preço foi cobrado: o
    // catálogo inteiro regravado, no ar, conferido byte a byte, e a tela
    // mostrando os clipes antigos porque o navegador nem perguntou.
  app.get("/public/clips/:slug.webp", async function (req, res) {
    const clipe = await app.api.exercise.clip(req.params.slug);

    if (!clipe) {
      res.status(404).send({ msg: "no_clip" });
      return;
    }

    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(clipe.dados);
  });

  app.get("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.view");
    if (trainer === false) return;

    const exercise = await app.api.exercise.data(req.params.id);
    if (!exercise) {
      res.status(404).send({ msg: req.t("errors.exerciseNotFound") });
      return;
    }

    res.send(exercise);
  });

  app.put("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
    if (trainer === false) return;

    const body = req.body || {};
    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireExerciseName") });
      return;
    }

    const ok = await app.api.exercise.update(req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.exerciseNotFound") });
      return;
    }

    const updated = await app.api.exercise.data(req.params.id);

    app.insertUserActionHistory(req, trainer, "update_exercise", {
      category: "exercises",
      local: { target_type: "exercises", target_id: req.params.id + "" },
      extra: { name: updated.name },
    });

    res.send(updated);
  });

  // Apagar NÃO desmonta treino nenhum: a série guarda o próprio nome e as
  // próprias cargas, então o treino já montado continua inteiro.
  app.delete("/exercises/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "exercises.manage");
    if (trainer === false) return;

    const ok = await app.api.exercise.delete(req.params.id);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.exerciseNotFound") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "delete_exercise", {
      category: "exercises",
      local: { target_type: "exercises", target_id: req.params.id + "" },
    });

    res.send({ msg: req.t("ok.exerciseRemoved") });
  });
};
