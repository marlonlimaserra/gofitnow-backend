module.exports = function (app) {
  // The people a professional follows — professional only.
  //
  // The professional id never comes from the body or the query: it always
  // comes from the session, and every read goes through the link, so one
  // professional can never reach a person who did not let them in.
  //
  // The routes are /people. The MODELS and the database still say student,
  // because that is what workouts and sessions point at. The screens say the
  // word each professional chose — aluno, paciente, cliente — for the same
  // record.

  app.get("/people", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    // Paginada no BANCO. A resposta é `{ rows, total }` — antes era um array
    // cru com a lista inteira, e quem consumir a API precisa saber disso.
    res.send(
      await app.api.user.pageStudents(trainer._id, {
        search: req.query.search,
        active: req.query.active,
        sort: req.query.sort,
        dir: req.query.dir,
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  });

  app.get("/people/summary", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    res.send(await app.api.user.studentsSummary(trainer._id));
  });

  app.get("/people/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    const student = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    const notes = await app.api.link.notesOf(trainer._id, req.params.id);
    const active = await app.api.link.activeOf(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "view_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: student.name },
    });

    res.send({ ...app.api.user.filter(student), notes, active });
  });

  // ── Link de cadastro ─────────────────────────────────────────────────────
  //
  // O profissional pega o link e manda por WhatsApp; a própria pessoa preenche.
  // As duas rotas de baixo são PÚBLICAS — é o ponto todo — e por isso são as
  // mais estreitas do arquivo: leem só o token, criam só uma pessoa, e nunca
  // revelam nada do profissional além do primeiro nome.
  app.get("/me/invite", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (trainer === false) return;

    res.send({ token: await app.api.user.inviteToken(trainer._id) });
  });

  // Gerar outro INVALIDA o anterior. É a única defesa de verdade para um link
  // que foi parar num grupo errado.
  app.post("/me/invite/reset", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (trainer === false) return;

    const token = await app.api.user.inviteToken(trainer._id, { renovar: true });

    app.insertUserActionHistory(req, trainer, "reset_invite_link", {
      category: "people",
      local: { target_type: "users", target_id: trainer._id + "" },
    });

    res.send({ token });
  });

  // Quem abriu o link: só para a página poder dizer "cadastro com Marlon".
  //
  // Devolve o PRIMEIRO NOME e nada mais. Um link válido não é credencial para
  // conhecer o e-mail, o telefone ou a lista de ninguém.
  app.get("/invite/:token", async function (req, res) {
    const trainer = await app.api.user.trainerByInviteToken(req.params.token);
    if (!trainer) {
      res.status(404).send({ msg: req.t("errors.inviteNotFound") });
      return;
    }

    res.send({ professional: { name: String(trainer.name || "").split(" ")[0] } });
  });

  app.post("/invite/:token", async function (req, res) {
    const trainer = await app.api.user.trainerByInviteToken(req.params.token);
    if (!trainer) {
      res.status(404).send({ msg: req.t("errors.inviteNotFound") });
      return;
    }

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requirePersonName") });
      return;
    }
    if (!body.email || !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: req.t("errors.requirePersonEmail") });
      return;
    }
    // Senha OBRIGATÓRIA aqui, ao contrário do cadastro feito pelo profissional:
    // quem se cadastra sozinho está pedindo para entrar no app. Uma ficha sem
    // login criada pela própria pessoa não serviria a ninguém.
    if (!body.password || String(body.password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }

    if (await app.api.user.dataByEmail(body.email)) {
      // A mesma mensagem para quem já é desta lista e para quem não é: dizer
      // "esse e-mail já está cadastrado aqui" numa página pública transformaria
      // o link num verificador de quem é cliente de quem.
      res.status(409).send({ msg: req.t("errors.inviteEmailTaken"), code: "email_taken" });
      return;
    }

    // O MESMO tipo que o cadastro feito pelo profissional aplica. Resolvido
    // aqui e nunca lido do corpo: esta rota é pública, e aceitar `role` de fora
    // deixaria qualquer um criar a própria conta de administrador.
    const role = await app.api.role.dataByName(app.api.role.clientName);

    // Só os campos que a pessoa preenche. `active` e vínculo saem do insert.
    const id = await app.api.user.insertStudent(trainer._id, {
      name: body.name,
      email: body.email,
      phone: body.phone,
      birthDate: body.birthDate,
      sex: body.sex,
      goal: body.goal,
      weight: body.weight,
      height: body.height,
      password: body.password,
      role: role?._id,
    });

    const criada = await app.api.user.data(id);

    app.insertUserActionHistory(req, trainer, "create_person", {
      category: "people",
      local: { target_type: "people", target_id: id + "" },
      extra: { name: criada.name, email: criada.email, self_signup: true },
    });

    res.status(201).send({ msg: req.t("ok.inviteDone") });
  });

  app.post("/people", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (trainer === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requirePersonName") });
      return;
    }
    // O e-mail é OBRIGATÓRIO. Ele é a identidade da pessoa dentro desta
    // instância: é por ele que ela entra no app e é achada na busca.
    if (!body.email || !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: req.t("errors.requirePersonEmail") });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }
    {
      // Dentro da instância o e-mail é único, então já existir aqui significa
      // uma coisa só: essa pessoa já está nesta conta.
      //
      // Antes existia um terceiro caso — "ela tem conta em OUTRO profissional"
      // — que abria o pedido de acesso por e-mail. Com um banco por cliente
      // esse caso deixou de existir: a conta de outra instância é outra conta,
      // e não há nada para pedir a ninguém.
      const exists = await app.api.user.dataByEmail(body.email);
      if (exists) {
        res.status(409).send({
          msg: req.t("errors.alreadyInYourList"),
          code: "email_taken",
        });
        return;
      }
    }

    // Someone being followed always starts as "Pessoa". The type is resolved
    // here and never taken from the body, so a crafted request cannot create
    // an account with more power than the screen offers.
    const role = await app.api.role.dataByName(app.api.role.clientName);

    const id = await app.api.user.insertStudent(trainer._id, { ...body, role: role?._id });

    // A observacao e do profissional, nao da pessoa: fica no vinculo.
    if (body.notes) await app.api.link.setNotes(trainer._id, id, body.notes);

    const created = await app.api.user.data(id);

    app.insertUserActionHistory(req, trainer, "create_person", {
      category: "people",
      local: { target_type: "people", target_id: id + "" },
      extra: { name: created.name, email: created.email, hasAccess: !!created.password },
    });

    res.status(201).send(app.api.user.filter(created));
  });

  app.put("/people/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const body = req.body || {};
    const target = await app.api.user.dataStudent(trainer._id, req.params.id);

    if (!target) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requirePersonName") });
      return;
    }
    // Sending the field at all means it has to be valid: a person cannot be
    // left without an e-mail, because that is what makes their record findable
    // by the other professionals who care for them. Not sending it keeps
    // whatever is stored, so a partial update still works.
    if (body.email !== undefined && !app.validator.isEmail(String(body.email).trim())) {
      res.status(400).send({ msg: req.t("errors.requirePersonEmail") });
      return;
    }
    if (body.password && String(body.password).length < 6) {
      res.status(400).send({ msg: req.t("errors.passwordTooShort") });
      return;
    }
    // O e-mail PODE ser trocado aqui.
    //
    // Ficou travado por um bom tempo, e a razão era do mundo de banco único: o
    // e-mail era a identidade da pessoa ENTRE profissionais de contas diferentes,
    // e trocá-lo permitiria apontar a ficha para outra pessoa ou reivindicar o
    // endereço de quem já tinha conta. Com um banco por cliente isso deixou de
    // existir — o mesmo ser humano em duas instâncias já são dois cadastros
    // distintos, e aqui dentro quem cadastrou é quem cuida do dado.
    //
    // O que continua valendo é a UNICIDADE dentro da instância: dois cadastros
    // com o mesmo e-mail seriam duas fichas disputando o mesmo login.
    if (body.email !== undefined) {
      const enviado = String(body.email).trim().toLowerCase();
      const atual = String(target.email || "").trim().toLowerCase();

      if (enviado !== atual) {
        const dono = await app.api.user.dataByEmail(enviado);
        if (dono && String(dono._id) !== String(req.params.id)) {
          res.status(409).send({ msg: req.t("errors.emailInUse"), code: "email_in_use" });
          return;
        }
      }
    }

    try {
      await app.api.user.updateStudent(trainer._id, req.params.id, body);
    } catch (error) {
      // A checagem acima perde a corrida entre duas requisições simultâneas; quem
      // garante é o índice único. Traduzir o 11000 aqui é a diferença entre "esse
      // e-mail já é de outra pessoa" e um 500 sem explicação.
      if (error?.code === 11000) {
        res.status(409).send({ msg: req.t("errors.emailInUse"), code: "email_in_use" });
        return;
      }
      throw error;
    }

    // Observação e status são do VÍNCULO, não da pessoa: cada profissional tem
    // os seus. Marcar inativo aqui não bloqueia o login de ninguém — isso é o
    // `active` da conta, alterado em Usuários.
    if (body.notes !== undefined) {
      await app.api.link.setNotes(trainer._id, req.params.id, body.notes);
    }
    if (body.active !== undefined) {
      await app.api.link.setActive(trainer._id, req.params.id, body.active);
    }

    const updated = await app.api.user.data(req.params.id);

    app.insertUserActionHistory(req, trainer, "update_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: updated.name },
      diff: app.api.actionHistory.diff(target, updated),
    });

    res.send({
      ...app.api.user.filter(updated),
      notes: await app.api.link.notesOf(trainer._id, req.params.id),
      active: await app.api.link.activeOf(trainer._id, req.params.id),
    });
  });

  // Revokes the person's login while keeping the profile.
  app.delete("/people/:id/access", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.access");
    if (trainer === false) return;

    const target = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!target) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    // Only whoever created the profile can take the login away. Getting access
    // by request must never come with the power to lock the person out of an
    // account that is theirs.
    const ok = await app.api.user.revokeStudentAccess(trainer._id, req.params.id);
    if (!ok) {
      res.status(409).send({
        msg: req.t("errors.ownAccountAccess"),
      });
      return;
    }

    await app.api.auth.deleteAllTokensByUser(req.params.id);

    app.insertUserActionHistory(req, trainer, "revoke_person_access", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: target.name },
    });

    res.send({ msg: req.t("ok.accessRevoked") });
  });

  // Excluir apaga MESMO: a pessoa, o vínculo, as sessões abertas e os treinos.
  //
  // Havia aqui um desvio: se a pessoa tivesse senha, ou se outro profissional a
  // acompanhasse, a exclusão virava só um "sai da sua lista" e a ficha
  // sobrevivia. Os dois motivos caíram em 13/08/2026.
  //
  // O primeiro nunca foi verdade: `/auth/register` só cria PROFISSIONAL, então
  // pessoa nenhuma tem conta própria — a senha dela foi o profissional quem
  // deu, na tela de acesso. O segundo não existe ainda: `link.link()` tem um
  // único chamador, o cadastro da pessoa, e não há como um segundo profissional
  // se vincular. O botão prometia uma proteção que não protegia nada e escondia
  // que a exclusão não excluía.
  //
  // Quem quer só tirar o login e manter a ficha tem botão próprio para isso:
  // DELETE /people/:id/access. Se um dia existir pessoa compartilhada entre
  // profissionais, o desvio volta — e aí valendo de verdade.
  app.delete("/people/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.delete");
    if (trainer === false) return;

    const target = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!target) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    await app.api.user.deleteStudent(trainer._id, req.params.id);
    await app.api.auth.deleteAllTokensByUser(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_person", {
      category: "people",
      local: { target_type: "people", target_id: req.params.id + "" },
      extra: { name: target.name, email: target.email },
    });

    res.send({ msg: req.t("ok.personDeleted"), removed: "deleted" });
  });
};
