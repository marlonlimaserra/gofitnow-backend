module.exports = function (app) {
  // A agenda do profissional.
  //
  // Duas leituras, e são perguntas diferentes:
  //
  //   /appointments?from=&to=     → "como está a minha semana"
  //   /people/:id/appointments    → "quando eu vejo esta pessoa"
  //
  // Por isso são duas rotas e não uma com filtro: a primeira precisa do NOME de
  // cada pessoa para desenhar a grade, a segunda já sabe de quem é.

  // Quais profissionais esta conta enxerga.
  //
  // Sem `schedule.team`, é ela mesma e ponto — não adianta pedir a agenda de um
  // colega na query. Com a permissão, a conta escolhe: um, alguns ou todos.
  //
  // A regra é aplicada NO SERVIDOR e não na tela: o filtro do topo da agenda é
  // conveniência, e quem troca um id na URL não pode passar por cima dele.
  async function profissionaisVisiveis(req, user) {
    const daEquipe = await app.api.user.hasPermission(user, "schedule.team");
    if (!daEquipe) return [user._id];

    const pedidos = String(req.query.professionals || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (!pedidos.length) return await app.api.user.professionalIds();

    return pedidos;
  }

  // O conjunto que a conta pode ALCANÇAR — para ler, editar e apagar um
  // compromisso pelo id. Diferente do filtro da tela: aqui não há escolha, é o
  // limite.
  async function alcance(user) {
    const daEquipe = await app.api.user.hasPermission(user, "schedule.team");
    return daEquipe ? await app.api.user.professionalIds() : [user._id];
  }

  async function gerarCobranca(req, trainer, student, compromisso) {
    if (!compromisso?.service) return;

    const servico = await app.api.service.data(compromisso.service);
    if (!servico || !servico.price) return;

    const jaExiste = await app.api.finance.chargeOfAppointment(compromisso._id);
    if (jaExiste) return;

    await app.api.finance.insertCharge(
      student._id,
      {
        amount: servico.price,
        dueDate: compromisso.date,
        description: servico.name,
        appointment: compromisso._id,
        service: servico._id,
      },
      trainer._id,
      // A moeda do SERVIÇO, não a padrão da conta: um serviço vendido em dólar
      // gera cobrança em dólar.
      await app.api.tenant.currencyFor(servico.currency)
    );
  }

  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  // Os nomes de quem aparece na grade, numa consulta só. Com trinta
  // compromissos na semana seriam trinta idas ao banco para escrever trinta
  // nomes.
  // O nome de quem ATENDE, para a grade poder separar as agendas por cor e
  // dizer de quem é cada barra.
  async function comProfissionais(rows) {
    const nomes = await app.api.user.briefByIds(rows.map((r) => r.trainer));

    return rows.map((r) => ({
      ...r,
      professional: nomes[String(r.trainer)] || null,
    }));
  }

  async function comPessoas(rows) {
    const nomes = await app.api.user.briefByIds(rows.map((r) => r.student));

    return rows.map((r) => ({
      ...r,
      person: nomes[String(r.student)] || null,
    }));
  }

  // Quem pode aparecer no seletor do topo da agenda.
  //
  // Só quem tem `schedule.team` recebe a lista: para os demais existe uma
  // agenda só — a própria — e um seletor de um item é enfeite.
  app.get("/professionals", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (user === false) return;

    const daEquipe = await app.api.user.hasPermission(user, "schedule.team");
    if (!daEquipe) {
      res.send({ rows: [{ _id: user._id, name: user.name }] });
      return;
    }

    res.send({ rows: await app.api.user.professionals() });
  });

  app.get("/appointments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (trainer === false) return;

    const { from, to } = req.query;
    if (!from || !to) {
      res.status(400).send({ msg: req.t("errors.requireRange") });
      return;
    }

    const rows = await app.api.appointment.between(
      await profissionaisVisiveis(req, trainer),
      from,
      to
    );

    res.send({ rows: await comProfissionais(await comPessoas(rows)) });
  });

  app.get("/people/:personId/appointments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    // A ficha mostra o atendimento de TODA a equipe para quem pode vê-lo: se a
    // nutricionista marcou uma consulta, ela faz parte do acompanhamento desta
    // pessoa tanto quanto o treino.
    const rows = await app.api.appointment.listOfStudent(await alcance(trainer), student._id);

    res.send({ rows: await comProfissionais(rows) });
  });

  // Quem já ocupa este horário.
  //
  // Consultada pelo formulário ANTES de salvar. Não é validação: a agenda
  // aceita sobreposição, porque atendimento em dupla existe. É aviso — o erro
  // comum é esquecer que o horário estava ocupado, não querer dois de
  // propósito.
  app.get("/appointments/conflicts", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (trainer === false) return;

    const { date, minutes, ignore } = req.query;
    if (!date) {
      res.status(400).send({ msg: req.t("errors.requireRange") });
      return;
    }

    // O choque é no horário de QUEM ATENDE. Conferir na agenda de quem está
    // digitando diria "livre" enquanto o professor já tem alguém às 7h.
    const permitidos = await alcance(trainer);
    const de =
      req.query.trainer && permitidos.some((id) => String(id) === String(req.query.trainer))
        ? req.query.trainer
        : trainer._id;

    const rows = await app.api.appointment.conflicts(de, date, minutes, ignore);
    res.send({ rows: await comPessoas(rows) });
  });

  app.post("/people/:personId/appointments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};
    if (!body.date) {
      res.status(400).send({ msg: req.t("errors.requireDate") });
      return;
    }

    // Para quem o compromisso é. Marcar no horário de um colega exige a
    // permissão de equipe — sem ela, o pedido é ignorado e o compromisso fica
    // com quem o marcou, em vez de virar um erro que não ajuda ninguém.
    const permitidos = await alcance(trainer);
    const alvo =
      body.trainer && permitidos.some((id) => String(id) === String(body.trainer))
        ? body.trainer
        : trainer._id;

    const id = await app.api.appointment.insert(alvo, student._id, body, trainer._id);
    const criado = await app.api.appointment.data(permitidos, id);

    // A COBRANÇA AUTOMÁTICA.
    //
    // Marcou um compromisso de um serviço que tem valor: nasce a cobrança, com
    // vencimento no dia do atendimento. É o que evita a conversa de "quanto
    // ficou mesmo?" três semanas depois.
    //
    // O valor é copiado do serviço, não apontado para ele: reajustar o preço
    // em setembro não pode mudar o que já foi cobrado em agosto.
    //
    // Só na criação, e só uma vez por compromisso — `chargeOfAppointment`
    // garante que remarcar não gere uma segunda.
    await gerarCobranca(req, trainer, student, criado);

    app.insertUserActionHistory(req, trainer, "create_appointment", {
      category: "schedule",
      local: { target_type: "appointments", target_id: id + "" },
      // `criado?.date`: o registro do histórico não pode derrubar uma criação
      // que deu certo. Se a releitura falhar, perde-se a data no log — não o
      // compromisso.
      extra: { person: student.name, personId: student._id + "", date: criado?.date },
    });

    res.status(201).send(criado);
  });

  app.put("/appointments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (trainer === false) return;

    const permitidos = await alcance(trainer);

    const antes = await app.api.appointment.data(permitidos, req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.appointmentNotFound") });
      return;
    }

    const body = req.body || {};
    const novoTrainer =
      body.trainer && permitidos.some((id) => String(id) === String(body.trainer))
        ? body.trainer
        : null;

    await app.api.appointment.update(permitidos, req.params.id, body, novoTrainer);
    const depois = await app.api.appointment.data(permitidos, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_appointment", {
      category: "schedule",
      local: { target_type: "appointments", target_id: req.params.id + "" },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  // Só o status: é o clique do fim da aula.
  //
  // Rota própria porque obrigar a abrir o formulário inteiro para marcar
  // presença faria ninguém marcar — e aí a agenda perde a única informação que
  // ela tem sobre assiduidade.
  app.patch("/appointments/:id/status", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (trainer === false) return;

    const permitidos = await alcance(trainer);

    const antes = await app.api.appointment.data(permitidos, req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.appointmentNotFound") });
      return;
    }

    const ok = await app.api.appointment.setStatus(
      permitidos,
      req.params.id,
      (req.body || {}).status
    );
    if (!ok) {
      res.status(400).send({ msg: req.t("errors.invalidStatus") });
      return;
    }

    const depois = await app.api.appointment.data(permitidos, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_appointment", {
      category: "schedule",
      local: { target_type: "appointments", target_id: req.params.id + "" },
      diff: { status: [antes.status, depois.status] },
    });

    res.send(depois);
  });

  app.delete("/appointments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (trainer === false) return;

    const permitidos = await alcance(trainer);

    const alvo = await app.api.appointment.data(permitidos, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.appointmentNotFound") });
      return;
    }

    await app.api.appointment.delete(permitidos, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_appointment", {
      category: "schedule",
      local: { target_type: "appointments", target_id: req.params.id + "" },
      extra: { date: alvo.date },
    });

    res.send({ msg: req.t("ok.appointmentRemoved") });
  });
};
