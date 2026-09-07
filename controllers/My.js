const { catalogoPara } = require("../lib/examMarkers.js");

// A ÁREA DA PESSOA: as rotas que o ALUNO usa para ver o que é dele.
//
// Elas existem porque as rotas da ficha são do PROFISSIONAL: exigem permissão
// (`workouts.view`) e escopo (`dataStudent(trainer, pessoa)`) — um aluno não tem
// nem uma coisa nem outra. Aqui a autorização é a IDENTIDADE: quem pergunta é o
// dono do dado, e o filtro é sempre `student = eu`, cravado do lado do servidor.
// Não existe `:personId` em rota nenhuma — um id na URL seria um convite para
// trocá-lo.
//
// Filtro por pessoa, SEM recorte de profissional, de propósito: numa clínica com
// dois profissionais, o treino que o segundo montou é tão do aluno quanto o do
// primeiro. O aluno não conhece a divisão interna da equipe, e a área dele não
// deveria obrigá-lo a conhecer.
//
// Tudo aqui é LEITURA. O aluno marca horário pela agenda pública (as rotas
// `/public/booking`, que casam a pessoa pelo e-mail) — escrever na ficha
// continua sendo trabalho de quem atende.
module.exports = function (app) {
  // ── O PORTÃO: quem É ACOMPANHADO, e não quem é "do tipo aluno" ────────────
  //
  // A regra era `type === "student"`, com o argumento de que "um profissional
  // tem a ficha inteira, devolver os treinos dele aqui seria uma lista vazia
  // com cara de defeito". O argumento assumia que profissional nunca é
  // atendido — e o Marlon é o contraexemplo: profissional na conta dele,
  // ATENDIDO na conta do Willian, com três dietas e uma avaliação montadas
  // para ele que nenhuma tela alcançava.
  //
  // Ele caía num vão: a home de profissional lista quem ELE acompanha
  // (ninguém), e a área de quem é acompanhado estava fechada pelo tipo.
  //
  // A pergunta certa não é "que tipo de conta é esta?", é "alguém acompanha
  // esta pessoa?". Quem tem vínculo tem o que ver aqui, seja qual for o tipo.
  //
  // NÃO afrouxa nada: o filtro de todas as rotas continua sendo `student = eu`,
  // cravado no servidor. Ninguém passa a ver o dado de outro — passa a ver o
  // PRÓPRIO, que é o que esta área sempre serviu.
  async function aluno(req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return false;

    if (user.type === "student") return user;

    // Um profissional sem ninguém acompanhando-o continua recebendo 403: para
    // ele esta área é mesmo uma lista vazia, e a mensagem manda para a ficha.
    const acompanhado = await app.api.link.countProfessionalsOf(user._id);
    if (!acompanhado) {
      res.status(403).send({ msg: req.t("errors.studentAreaOnly") });
      return false;
    }

    return user;
  }

  // O RESUMO que abre a tela inicial: uma chamada, os números de cada porta e o
  // próximo compromisso. O celular abre a área da pessoa no elevador — quatro
  // requisições para desenhar quatro cartões seria pagar a latência quatro vezes.
  app.get("/my/overview", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const [treinos, dietas, exames, agenda] = await Promise.all([
      app.api.workout.listOfStudent(eu._id),
      app.api.diet.listOfStudent(eu._id),
      app.api.exam.listOfStudent(eu._id),
      app.api.appointment.listAllOfStudent(eu._id),
    ]);

    const agora = new Date();
    const proximo = agenda.find((a) => a.status !== "canceled" && new Date(a.date) >= agora);

    res.send({
      counts: {
        // O que vale HOJE, como os selos da ficha: treino encerrado em março
        // não é "o meu treino".
        workouts: treinos.filter((w) => w.status === "current").length,
        diets: dietas.filter((d) => d.status === "current").length,
        exams: exames.length,
        appointments: agenda.filter((a) => a.status !== "canceled" && new Date(a.date) >= agora)
          .length,
      },
      nextAppointment: proximo || null,
    });
  });

  app.get("/my/workouts", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const rows = await app.api.workout.listOfStudent(eu._id);

    res.send({
      rows,
      counts: {
        current: rows.filter((w) => w.status === "current").length,
        past: rows.filter((w) => w.status === "past").length,
        future: rows.filter((w) => w.status === "future").length,
        all: rows.length,
      },
    });
  });

  app.get("/my/workouts/:id", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    // O filtro é (id, eu): um id de treino de OUTRA pessoa devolve 404 — de
    // fora não se distingue "não existe" de "não é seu", e é assim que deve ser.
    const workout = await app.api.workout.dataOfStudent(eu._id, req.params.id);
    if (!workout) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    // ── A DEMONSTRAÇÃO DE CADA EXERCÍCIO ────────────────────────────────
    //
    // O exercício gravado no treino é um retrato e não carrega a chave do
    // clipe — ela é do catálogo, e um retrato de dois meses atrás apontaria
    // para um clipe já regravado. Ver `Exercise_model.clipesPorExercicio`.
    //
    // Duas consultas para o treino inteiro. Exercício sem clipe não ganha
    // campo, e a tela não desenha nada por ele.
    //
    // Só na tela do TREINO ABERTO, e não na lista: a lista não mostra
    // exercício, então pagar as consultas ali seria trabalho para ninguém.
    const clipes = await app.api.exercise.clipesPorExercicio(
      (workout.exercises || []).map((e) => e.exerciseId)
    );

    res.send({
      ...workout,
      exercises: (workout.exercises || []).map((e) => {
        const c = clipes[String(e.exerciseId)];
        return c ? { ...e, ...c } : e;
      }),
    });
  });

  app.get("/my/diets", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const rows = await app.api.diet.listOfStudent(eu._id);

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

  app.get("/my/exams", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const rows = await app.api.exam.listOfStudent(eu._id);

    // O catálogo resolvido pelo MEU sexo — mesma regra da rota do profissional.
    res.send({ rows, catalog: catalogoPara(eu.sex) });
  });

  app.get("/my/supplements", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const rows = await app.api.supplement.listOfStudent(eu._id);

    // Só o que vale HOJE: a pergunta de quem abre é "o que eu tomo", e um
    // termogênico encerrado em março não é resposta. Os momentos vão junto para
    // a tela agrupar com os mesmos rótulos da ficha.
    res.send({
      rows: rows.filter((s) => s.status === "current"),
      moments: app.api.supplement.MOMENTOS,
    });
  });

  app.get("/my/appointments", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const todos = await app.api.appointment.listAllOfStudent(eu._id);
    const agora = new Date();

    // Repartido AQUI, e não na tela: "o que vem" e "o que já foi" são as duas
    // perguntas da agenda, e as duas pontas (web futura e app) repartirão igual.
    const validos = todos.filter((a) => a.status !== "canceled");

    // Quem atende, para a tela dizer "com a Bruna" — id sozinho não veste tela.
    const nomes = new Map();
    for (const a of validos) {
      const id = String(a.trainer);
      if (!nomes.has(id)) {
        const quem = await app.api.user.data(a.trainer);
        nomes.set(id, quem ? quem.name : "");
      }
    }
    const vestido = (a) => ({ ...a, trainerName: nomes.get(String(a.trainer)) || "" });

    res.send({
      upcoming: validos.filter((a) => new Date(a.date) >= agora).map(vestido),
      past: validos
        .filter((a) => new Date(a.date) < agora)
        .reverse()
        .map(vestido),
    });
  });
};
