const Checkin = require("../model/Checkin_model.js");

// A FREQUÊNCIA DE UMA PESSOA — a entrada na academia e as aulas que ela fez.
//
// *"crie esse menu no aluno: frequência de entrada na academia e frequência nas
// aulas. Já comprei o negócio de face ID para a gente testar quando chegar."*
//
// ── AS DUAS FREQUÊNCIAS SÃO COISAS DIFERENTES ───────────────────────────
//
// ENTRAR na academia é passar pela porta: vale para quem treina sozinho na sala
// de musculação, que é a maioria.
//
// FAZER UMA AULA é ter sido marcado presente numa aula coletiva. Elas se
// cruzam mas não se substituem: quem vem todo dia e nunca faz aula tem
// frequência alta e zero aulas, e quem só vem no spinning tem as duas iguais.
//
// Contá-las juntas esconderia justamente a diferença entre os dois alunos.
module.exports = function (app) {
  async function pessoaDoProfissional(req, res, trainer, id) {
    const pessoa = await app.api.user.dataStudent(trainer._id, id);
    if (!pessoa) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return pessoa;
  }

  // O período padrão: doze semanas. É o que cabe num calendário de calor sem
  // virar poeira, e é o tempo em que um sumiço fica visível — três semanas sem
  // vir aparece como um buraco no meio de um trimestre cheio.
  function janela(req) {
    const ate = req.query.ate ? new Date(req.query.ate) : new Date();
    const de = req.query.de
      ? new Date(req.query.de)
      : new Date(ate.getTime() - 84 * 24 * 60 * 60 * 1000);

    // O dia inteiro nas duas pontas: uma entrada às 21h de hoje tem de caber no
    // "até hoje".
    de.setHours(0, 0, 0, 0);
    ate.setHours(23, 59, 59, 999);
    return { de, ate };
  }

  app.get("/people/:personId/frequencia", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const { de, ate } = janela(req);
    const dia = (d) => d.toISOString().slice(0, 10);

    const [entradas, aulas, ultima] = await Promise.all([
      app.api.checkin.daPessoa(req.params.personId, { de, ate }),
      app.api.groupClassCheckin.daPessoa(req.params.personId, { de: dia(de), ate: dia(ate) }),
      // A ÚLTIMA vez que veio é buscada FORA da janela: se a pessoa sumiu há
      // quatro meses, ela não está nos últimos três — e é exatamente dela que
      // se quer saber.
      app.api.checkin.ultimaDe(req.params.personId),
    ]);

    res.send({
      entradas,
      aulas,
      ultima,
      de,
      ate,
      // Quantos dias sem vir. Calculado aqui porque a conta depende do fuso da
      // CASA, e o navegador de quem olha pode estar noutro.
      diasSemVir: ultima ? Math.floor((Date.now() - new Date(ultima).getTime()) / 86400000) : null,
      // A janela de repetição vai junto: a tela explica por que duas passadas
      // na catraca em dois minutos viraram uma entrada só.
      repeticaoMin: Checkin.REPETICAO_MIN,
    });
  });

  // ── REGISTRAR A ENTRADA ─────────────────────────────────────────────────
  //
  // `people.edit`, e não `people.view`: marcar presença é escrever na ficha de
  // alguém. Na prática é a recepção, que já tem essa chave.
  app.post("/people/:personId/checkins", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const r = await app.api.checkin.registrar(req.params.personId, {
      em: (req.body || {}).em,
      origem: (req.body || {}).origem || "balcao",
      unit: pessoa.unit,
      por: trainer,
    });

    if (!r.ok) return res.status(400).send({ msg: req.t("errors.invalidCheckin") });

    // O REPETIDO responde 200. Ele não é falha: é a resposta certa para o
    // segundo clique — e, um dia, para o segundo disparo da catraca.
    if (!r.repetido) {
      app.insertUserActionHistory(req, trainer, "create_checkin", {
        category: "people",
        local: { target_type: "checkins", target_id: String(r.id) },
      });
    }

    res.status(r.repetido ? 200 : 201).send(r);
  });

  app.delete("/people/:personId/checkins/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const ok = await app.api.checkin.remover(req.params.personId, req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.checkinNotFound") });

    res.send({ msg: req.t("ok.checkinRemoved") });
  });

  // ── A PORTA DO LEITOR ───────────────────────────────────────────────────
  //
  // *"já comprei o negócio de face ID para a gente testar quando chegar"*.
  //
  // O aparelho não tem sessão de usuário: ele entra por CHAVE DE API, que é o
  // caminho que este backend já tem para integração. A chave é da conta, e a
  // catraca é um "usuário" que só sabe fazer isto.
  //
  // ── O QUE O APARELHO MANDA, E O QUE ELE NÃO MANDA ─────────────────────
  //
  // Ele manda o ID DA PESSOA. Reconhecer o rosto é trabalho dele, e o template
  // biométrico fica NELE — dado biométrico é sensível na LGPD, e guardá-lo aqui
  // nos poria a responder por uma coisa que o aparelho já resolve.
  //
  // `dispositivo` é texto livre: o dia em que houver um leitor na porta e outro
  // na sala de musculação, é ele que separa os dois.
  app.post("/checkins", async function (req, res) {
    const conta = await app.helpers.apiKeyAuth.protect(req, res);
    if (conta === false) return;

    const { pessoa, em, dispositivo } = req.body || {};
    if (!pessoa) return res.status(400).send({ msg: req.t("errors.invalidCheckin") });

    // A pessoa tem de existir NESTA conta. Sem esta conferência, uma chave
    // vazada poderia registrar entrada para um id de outro cliente — e o escopo
    // automático do banco não protege contra um id que veio de fora.
    const existe = await app.api.user.data(pessoa);
    if (!existe) return res.status(404).send({ msg: req.t("errors.personNotFound") });

    const r = await app.api.checkin.registrar(pessoa, {
      em,
      origem: "catraca",
      unit: existe.unit,
      dispositivo,
    });

    if (!r.ok) return res.status(400).send({ msg: req.t("errors.invalidCheckin") });

    res.status(r.repetido ? 200 : 201).send(r);
  });
};
