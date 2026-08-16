const instanceContext = require("../lib/instance.js");
const rateLimit = require("../lib/rateLimit.js");
const slots = require("../lib/slots.js");

module.exports = function (app) {
  // A agenda pública: onde o cliente marca sozinho.
  //
  // Estas rotas são as ÚNICAS do sistema que respondem sem sessão nenhuma, e
  // isso muda todas as decisões daqui:
  //
  //   - a instância é resolvida pelo HOST, no registro central, como a tela de
  //     login faz. Nada no corpo do pedido escolhe o banco;
  //   - a resposta não entrega nome de cliente, nem quem já marcou: só "há
  //     vaga" ou "não há". Uma agenda pública que dissesse "10h — Ana Souza"
  //     seria uma lista de clientes na rua;
  //   - a sobreposição é RECUSADA, e não avisada como na agenda interna: aqui
  //     não há um profissional olhando a tela para decidir.

  // De qual cliente é este endereço. Sem host conhecido não há o que responder
  // — e responder algo daria a um domínio qualquer apontado para nós uma cara
  // de porta oficial.
  async function instanciaDoHost(req, res) {
    const host = String(
      req.query.host || req.headers["x-forwarded-host"] || req.headers.host || ""
    );

    const registro = await app.api.center.byHost(host);
    if (!registro || registro.active === false || registro.active === 0) {
      res.status(404).send({ msg: "unknown" });
      return false;
    }

    return registro.instance;
  }

  // A PÁGINA pedida pelo apelido da URL.
  //
  // Sem apelido, a agenda de sempre: todo mundo com grade ligada e todo serviço
  // ativo. É o que mantém `/g` funcionando para quem nunca criou página
  // nenhuma — e o que faz este recurso nascer sem migração.
  //
  // Com apelido que não existe (ou de página pausada), devolve `false` e a
  // rota responde 404: pausar uma página tem de pausá-la de verdade.
  async function paginaDoApelido(slug) {
    if (!slug) return null;
    return (await app.api.bookingPage.bySlug(slug)) || false;
  }

  // O HORÁRIO que vale para um pedido.
  //
  // Uma página com horário próprio é a dona do calendário dela: quem ela
  // escolheu atende no horário dela, e não na grade guardada de cada um. Foi a
  // decisão do produto — cada agenda tem seu horário, e a grade por profissional
  // saiu da tela.
  //
  // Sem página (o `/g` de sempre), vale a grade do profissional, exatamente
  // como antes. É o que mantém o link antigo funcionando sem migração nenhuma.
  //
  // Os BLOQUEIOS vêm sempre da conta de quem atende: férias e folga não são
  // assunto da página, e valem em todas elas.
  //
  // Uma função só, usada nas TRÊS rotas públicas. Se a listagem usasse o horário
  // da página e a marcação não, ele seria enfeite: bastaria mandar outra hora no
  // corpo do pedido para marcar fora dele.
  function horarioQueVale(pagina, grade) {
    if (slots.temHorario(pagina?.hours)) {
      return {
        semana: pagina.hours,
        // Passo, antecedência e horizonte da PÁGINA. Uma página velha, criada
        // antes de eles existirem, cai no que a conta já usava.
        passo: pagina.slotStep || grade?.slotStep,
        antecedencia: pagina.minNoticeHours ?? grade?.minNoticeHours,
        horizonte: pagina.horizonDays || grade?.horizonDays,
        bloqueios: grade?.blocks || [],
      };
    }

    // Sem horário próprio, é preciso ter grade LIGADA: é a regra de sempre.
    if (!grade || !grade.active) return null;

    return {
      semana: grade.weekdays,
      passo: grade.slotStep,
      antecedencia: grade.minNoticeHours,
      horizonte: grade.horizonDays,
      bloqueios: grade.blocks,
    };
  }

  // Quem atende nesta página.
  //
  // Com horário próprio, quem a página escolheu — sem depender de cada um ter
  // ligado a própria agenda, que já não se configura em lugar nenhum. Lista
  // vazia continua querendo dizer TODOS.
  //
  // Sem horário próprio, quem tem grade ligada: o `/g` de sempre.
  async function quemAtende(pagina) {
    // O rosto e a apresentação só saem daqui quando a PÁGINA pediu.
    //
    // O nome sempre sai — sem ele não há o que escolher. Foto e texto são outra
    // coisa: publicar o rosto de alguém numa página aberta é decisão de quem
    // publica, e ela mora no interruptor da página. Filtrar aqui, e não na
    // tela, é o que impede o dado de sair na resposta e alguém lê-lo no console
    // com a página "escondendo" na aparência.
    const mostrar = pagina?.showProfessional === true;
    const publico = (dados) =>
      mostrar
        ? { _id: dados._id, name: dados.name, avatarAt: dados.avatarAt || null, bio: dados.bio || "" }
        : { _id: dados._id, name: dados.name };

    if (slots.temHorario(pagina?.hours)) {
      const todos = await app.api.user.professionals();
      return todos
        .filter((p) => app.api.bookingPage.ofereceProfissional(pagina, p._id))
        .map(publico);
    }

    const grades = await app.api.availability.listActive();
    if (!grades.length) return [];

    const nomes = await app.api.user.briefByIds(grades.map((g) => g.professional));

    return grades
      .filter((g) => nomes[String(g.professional)])
      .filter((g) => app.api.bookingPage.ofereceProfissional(pagina, g.professional))
      .map((g) => publico({ ...nomes[String(g.professional)], _id: g.professional }));
  }

  // O que a página pública precisa para se desenhar: quem atende e os serviços
  // que cada um oferece.
  app.get("/public/booking", async function (req, res) {
    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const dados = await instanceContext.run(instancia, async () => {
      const pagina = await paginaDoApelido(req.query.slug);
      if (pagina === false) return false;

      const profissionais = await quemAtende(pagina);
      if (!profissionais.length) return { professionals: [], services: [] };

      const servicos = await app.api.service.list({ apenasAtivos: true });
      const moedas = await app.api.tenant.currencyOfInstance();

      return {
        // O nome e o texto de abertura são da PÁGINA: é o que diz a quem chegou
        // pelo anúncio que ele está no lugar certo.
        // A tela precisa saber em que relógio desenhar as horas: quem marca pode
        // estar em outro fuso, e o horário oferecido é o do estúdio.
        timezone: await app.api.tenant.timezoneOfInstance(),
        page: pagina
          ? {
              slug: pagina.slug,
              name: pagina.name,
              intro: pagina.intro,
              showProfessional: pagina.showProfessional === true,
            }
          : undefined,
        // Nome e id sempre; foto e apresentação só com o interruptor da página
        // ligado. Nada de e-mail, telefone ou papel: é uma página aberta.
        professionals: profissionais,

        // O RECORTE de serviços da página. Lista vazia quer dizer tudo.
        services: servicos
          .filter((s) => app.api.bookingPage.ofereceServico(pagina, s._id))
          .map((s) => ({
            _id: s._id,
            name: s.name,
            description: s.description,
            minutes: s.minutes,
            price: s.price,
            currency: s.currency || moedas.currency,
            capacity: s.capacity,
            // Quem oferece: a página usa para filtrar o serviço pelo
            // profissional escolhido. Vazio significa todos.
            professionals: s.professionals || [],
          })),
      };
    });

    if (dados === false) {
      res.status(404).send({ msg: "unknown" });
      return;
    }

    res.send(dados);
  });

  // Os horários livres de um profissional, para um serviço, num intervalo.
  // A FOTO de quem atende, para quem não entrou.
  //
  // `/avatars/:id` exige sessão, e é o certo lá: é a foto de um usuário
  // identificado, não um arquivo público. Aqui a foto é publicada de propósito —
  // mas só o que a página publicou:
  //
  //   1. a instância sai do HOST, como em toda rota pública daqui;
  //   2. a página precisa existir e estar com o interruptor ligado;
  //   3. o profissional precisa ser um dos que ELA oferece.
  //
  // Sem o passo 3, um id de aluno nesta rota devolveria a foto dele — e ids
  // vazam em URL, em log e em corpo de requisição.
  app.get("/public/booking/photo/:userId", async function (req, res) {
    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const foto = await instanceContext.run(instancia, async () => {
      const pagina = await paginaDoApelido(req.query.slug);
      if (pagina === false || !pagina?.showProfessional) return null;

      const oferecidos = await quemAtende(pagina);
      const ehDaPagina = oferecidos.some((p) => String(p._id) === String(req.params.userId));
      if (!ehDaPagina) return null;

      return app.api.avatar.data(req.params.userId);
    });

    if (!foto) {
      res.status(404).send({ msg: "no_photo" });
      return;
    }

    // `public` aqui, ao contrário de `/avatars/:id`: esta imagem foi publicada,
    // então um proxy pode guardá-la. A URL leva a versão (?v=), e é ela que
    // impede o cache longo de segurar uma foto trocada.
    res.setHeader("Content-Type", foto.mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(foto.data.buffer ? Buffer.from(foto.data.buffer) : foto.data);
  });

  app.get("/public/booking/slots", async function (req, res) {
    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const { professional, service, from, to } = req.query;
    if (!professional || !service || !from) {
      res.status(400).send({ msg: "missing" });
      return;
    }

    const resposta = await instanceContext.run(instancia, async () => {
      // O RECORTE vale aqui também.
      //
      // Filtrar só a listagem seria enfeite: bastaria trocar um id na URL para
      // pedir os horários de um serviço que a página não oferece — e depois
      // marcá-lo. Quem restringe, restringe de verdade.
      const pagina = await paginaDoApelido(req.query.slug);
      if (pagina === false) return { days: [] };
      if (pagina && !app.api.bookingPage.ofereceServico(pagina, service)) return { days: [] };
      if (pagina && !app.api.bookingPage.ofereceProfissional(pagina, professional)) return { days: [] };

      // A grade guardada da conta. Com página de horário próprio ela pode nem
      // existir — quem manda é a página; daqui saem só os bloqueios.
      const grade = await app.api.availability.of(professional);
      const horario = horarioQueVale(pagina, grade);
      if (!horario) return { days: [] };

      const servico = await app.api.service.data(service);
      if (!servico || !servico.active) return { days: [] };

      // O serviço tem de ser oferecido POR ESTE profissional. Sem esta
      // verificação, trocar um id na URL marcaria com quem não faz aquilo.
      const oferece =
        !servico.professionals?.length ||
        servico.professionals.some((p) => String(p) === String(professional));
      if (!oferece) return { days: [] };

      const inicio = new Date(from);
      const fim = to ? new Date(to) : new Date(inicio.getTime() + 7 * 86400000);
      if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) return { days: [] };

      // Uma consulta só para o intervalo inteiro: um dia por vez seriam sete
      // idas ao banco para desenhar uma semana.
      const ocupados = await app.api.appointment.between([professional], inicio, fim);

      // O relógio de quem atende. "08:00" na grade é hora de PAREDE, e o
      // servidor roda em UTC: sem isto, o cliente via 05:00 onde o estúdio
      // cadastrou 08:00.
      const fuso = await app.api.tenant.timezoneOfInstance();

      // O MESMO instante para todos os dias: lendo o relógio a cada dia, um
      // pedido que atravessasse o minuto daria respostas diferentes para a
      // mesma pergunta.
      const agora = new Date();
      const dias = [];

      for (let d = new Date(inicio); d < fim; d.setDate(d.getDate() + 1)) {
        const livres = slots.livresDoDia({
          dia: new Date(d),
          semana: horario.semana,
          passo: horario.passo,
          duracao: servico.minutes,
          compromissos: ocupados,
          bloqueios: horario.bloqueios,
          serviceId: servico._id,
          capacidade: servico.capacity,
          agora,
          antecedenciaHoras: horario.antecedencia,
          horizonteDias: horario.horizonte,
          fuso,
          // Os ocupados vêm junto, apagados na tela. O que sai daqui continua
          // sendo só HORÁRIO — nunca de quem é o compromisso que o tomou.
          incluirOcupados: true,
        });

        if (livres.length) {
          dias.push({
            date: new Date(d).toISOString(),
            // `seats` só quando a turma tem mais de uma vaga: num atendimento
            // individual, dizer "1 vaga" em cada horário é ruído.
            slots: livres.map((l) => ({
              start: l.start.toISOString(),
              seats: servico.capacity > 1 ? l.seats : undefined,
              // Só quando é verdade: um `taken: false` em cada horário livre
              // seria a maior parte do corpo da resposta.
              taken: l.seats === 0 ? true : undefined,
            })),
          });
        }
      }

      return { days: dias };
    });

    res.send(resposta);
  });

  // A marcação.
  app.post("/public/booking", async function (req, res) {
    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    // Rota aberta, escrita no banco: sem teto, um laço qualquer encheria a
    // agenda de um cliente em minutos.
    //
    // `checkShared`, não `check`: com o cluster ligado, um contador por worker
    // faria o teto de 10 valer 10 × número de workers. E o campo é `allowed` —
    // `limite.ok` é sempre `undefined`, e negá-lo devolvia 429 para TODO MUNDO,
    // ou seja, a agenda pública não marcava nada.
    const limite = await rateLimit.checkShared(`booking:${req.ip}`, 10);
    if (!limite.allowed) {
      res.setHeader("Retry-After", limite.retryAfter);
      res.status(429).send({ msg: "tooMany" });
      return;
    }

    const body = req.body || {};
    const nome = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const telefone = String(body.phone || "").trim();

    // O CADASTRO BÁSICO é obrigatório: sem nome e sem um contato, o
    // profissional recebe um horário ocupado por ninguém e não tem como
    // confirmar.
    if (!nome || (!email && !telefone)) {
      res.status(400).send({ msg: "requireContact" });
      return;
    }

    if (email && !app.validator.isEmail(email)) {
      res.status(400).send({ msg: "invalidEmail" });
      return;
    }

    const resultado = await instanceContext.run(instancia, async () => {
      // A checagem que de fato protege: aqui é onde o horário vira compromisso.
      const pagina = await paginaDoApelido(body.slug);
      if (pagina === false) return { erro: "unavailable" };
      if (pagina && !app.api.bookingPage.ofereceServico(pagina, body.service)) {
        return { erro: "unavailable" };
      }
      if (pagina && !app.api.bookingPage.ofereceProfissional(pagina, body.professional)) {
        return { erro: "unavailable" };
      }

      const grade = await app.api.availability.of(body.professional);
      const horario = horarioQueVale(pagina, grade);
      if (!horario) return { erro: "unavailable" };

      const servico = await app.api.service.data(body.service);
      if (!servico || !servico.active) return { erro: "unavailable" };

      const inicio = new Date(body.date);
      if (Number.isNaN(inicio.getTime())) return { erro: "unavailable" };

      // A DISPONIBILIDADE É CONFERIDA DE NOVO, AQUI.
      //
      // A lista que o cliente viu tem segundos de idade, e nesse tempo outra
      // pessoa pode ter marcado o mesmo horário. Confiar na tela seria deixar
      // a última vaga ser vendida duas vezes.
      const dia = new Date(inicio);
      dia.setHours(0, 0, 0, 0);
      const amanha = new Date(dia.getTime() + 86400000);

      const ocupados = await app.api.appointment.between([body.professional], dia, amanha);
      const fuso = await app.api.tenant.timezoneOfInstance();

      const livres = slots.livresDoDia({
        dia,
        // O horário da página vale AQUI também — é aqui que o horário vira
        // compromisso.
        semana: horario.semana,
        passo: horario.passo,
        duracao: servico.minutes,
        compromissos: ocupados,
        bloqueios: horario.bloqueios,
        serviceId: servico._id,
        capacidade: servico.capacity,
        agora: new Date(),
        antecedenciaHoras: horario.antecedencia,
        horizonteDias: horario.horizonte,
        fuso,
      });

      const ainda = livres.some((l) => l.start.getTime() === inicio.getTime());
      if (!ainda) return { erro: "taken" };

      // A pessoa: a que já existe com este contato, ou uma nova.
      //
      // Reaproveitar pelo e-mail evita uma ficha nova a cada marcação — e é o
      // que faz o histórico de quem já é cliente continuar sendo dele.
      const existente = email ? await app.api.user.dataByEmail(email) : undefined;

      let studentId;
      if (existente) {
        studentId = existente._id;
        // A pessoa já existe, mas talvez não com ESTE profissional. Sem o
        // vínculo, o compromisso apareceria na agenda dele e a pessoa não
        // apareceria na lista — e ele não conseguiria abrir a ficha dela.
        await app.api.link.link(body.professional, studentId, "booking");
      } else {
        studentId = await app.api.user.insertStudent(body.professional, {
          name: nome,
          email: email || "",
          phone: telefone,
        });
      }

      const id = await app.api.appointment.insert(
        body.professional,
        studentId,
        {
          date: inicio,
          minutes: servico.minutes,
          service: servico._id,
          title: servico.name,
          note: String(body.note || "").trim().slice(0, 500),
        },
        body.professional
      );

      const criado = await app.api.appointment.data([body.professional], id);

      // A cobrança automática vale aqui também: quem marcou um serviço com
      // valor já sai devendo, como sairia se o profissional tivesse marcado.
      if (servico.price) {
        const jaExiste = await app.api.finance.chargeOfAppointment(id);
        if (!jaExiste) {
          await app.api.finance.insertCharge(
            studentId,
            {
              amount: servico.price,
              dueDate: inicio,
              description: servico.name,
              appointment: id,
              service: servico._id,
            },
            body.professional,
            await app.api.tenant.currencyFor(servico.currency)
          );
        }
      }

      return { ok: true, date: criado?.date, service: servico.name, minutes: servico.minutes };
    });

    if (resultado.erro) {
      // 409 no horário tomado: é conflito de estado, e a tela reage a ele
      // recarregando os horários em vez de mostrar "erro".
      res.status(resultado.erro === "taken" ? 409 : 400).send({ msg: resultado.erro });
      return;
    }

    res.status(201).send(resultado);
  });

  // ── As páginas, do lado de dentro ───────────────────────────────────────
  //
  // Quem mexe aqui mexe no que o público vê, então a permissão é a mesma de
  // configurar a agenda.

  app.get("/booking-pages", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (user === false) return;

    res.send({ rows: await app.api.bookingPage.list() });
  });

  app.post("/booking-pages", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const body = req.body || {};

    if (!String(body.name || "").trim()) {
      res.status(400).send({ msg: req.t("errors.bookingPageName") });
      return;
    }

    // O apelido cai para o nome quando não vem escrito: "Avaliação gratuita"
    // vira `avaliacao-gratuita`, e quem não liga para o endereço não precisa
    // pensar nele.
    const conferido = app.api.bookingPage.conferirApelido(body.slug || body.name);
    if (!conferido.ok) {
      res.status(400).send({ msg: req.t(conferido.motivo), code: "invalid_slug" });
      return;
    }

    if (!(await app.api.bookingPage.slugLivre(conferido.slug))) {
      res.status(409).send({ msg: req.t("errors.bookingPageSlugTaken"), code: "slug_taken" });
      return;
    }

    const id = await app.api.bookingPage.insert({ ...body, slug: conferido.slug }, user._id);
    const criada = await app.api.bookingPage.data(id);

    app.insertUserActionHistory(req, user, "create_booking_page", {
      category: "schedule",
      local: { target_type: "booking_pages", target_id: String(id) },
      extra: { name: criada.name, slug: criada.slug },
    });

    res.status(201).send(criada);
  });

  app.put("/booking-pages/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.bookingPage.data(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.bookingPageNotFound") });
      return;
    }

    const body = req.body || {};

    if (body.name !== undefined && !String(body.name).trim()) {
      res.status(400).send({ msg: req.t("errors.bookingPageName") });
      return;
    }

    if (body.slug !== undefined) {
      const conferido = app.api.bookingPage.conferirApelido(body.slug);
      if (!conferido.ok) {
        res.status(400).send({ msg: req.t(conferido.motivo), code: "invalid_slug" });
        return;
      }

      if (!(await app.api.bookingPage.slugLivre(conferido.slug, req.params.id))) {
        res.status(409).send({ msg: req.t("errors.bookingPageSlugTaken"), code: "slug_taken" });
        return;
      }

      body.slug = conferido.slug;
    }

    await app.api.bookingPage.update(req.params.id, { ...alvo, ...body });
    const salva = await app.api.bookingPage.data(req.params.id);

    app.insertUserActionHistory(req, user, "update_booking_page", {
      category: "schedule",
      local: { target_type: "booking_pages", target_id: String(req.params.id) },
      extra: { name: salva.name, slug: salva.slug, active: salva.active },
    });

    res.send(salva);
  });

  app.delete("/booking-pages/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.bookingPage.data(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.bookingPageNotFound") });
      return;
    }

    await app.api.bookingPage.delete(req.params.id);

    app.insertUserActionHistory(req, user, "delete_booking_page", {
      category: "schedule",
      local: { target_type: "booking_pages", target_id: String(req.params.id) },
      extra: { name: alvo.name, slug: alvo.slug },
    });

    res.send({ msg: req.t("ok.bookingPageRemoved") });
  });

  // ── Configuração, do lado de dentro ─────────────────────────────────────

  app.get("/availability", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (user === false) return;

    const daEquipe = await app.api.user.hasPermission(user, "schedule.team");
    const ids = daEquipe ? await app.api.user.professionalIds() : [user._id];

    const rows = [];
    for (const id of ids) {
      const grade = await app.api.availability.of(id);
      rows.push({ professional: id, ...(grade || {}) });
    }

    res.send({ rows });
  });

  app.put("/availability/:professionalId", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    // Mexer na grade de OUTRO profissional exige a permissão de equipe — é a
    // mesma regra da agenda.
    const daEquipe = await app.api.user.hasPermission(user, "schedule.team");
    const alvo =
      daEquipe || String(req.params.professionalId) === String(user._id)
        ? req.params.professionalId
        : user._id;

    const salva = await app.api.availability.save(alvo, req.body || {});

    app.insertUserActionHistory(req, user, "update_availability", {
      category: "schedule",
      local: { target_type: "availability", target_id: String(alvo) },
      extra: { active: salva.active },
    });

    res.send(salva);
  });
};
