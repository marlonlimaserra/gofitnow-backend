const { ObjectId } = require("mongodb");

// O NUMEROZINHO DE CADA ABA da ficha da pessoa.
//
// Pedido do Marlon: "o numerozinho do lado se tiver — só de bater o olho eu já sei
// que tem coisa ali". Uma requisição, cinco números, respondida quando a ficha abre.
//
// ── O que cada número CONTA, e por que não é "quantos existem" ────────────
//
// O selo serve para dizer "olha aqui", e para isso ele precisa contar o que PEDE
// ATENÇÃO — não o histórico. Uma pessoa com trinta treinos antigos e nenhum vigente
// mostraria "30" para sempre, e o número deixaria de significar qualquer coisa:
//
//   Treinos    treinos VIGENTES hoje       (não os que acabaram)
//   Dieta      planos VIGENTES hoje        (mesma regra)
//   Financeiro cobranças EM ABERTO         (o que falta receber)
//   Agenda     compromissos FUTUROS        (o que ainda vai acontecer)
//   Avaliação  todas as avaliações         (aqui o histórico É o conteúdo)
//
// A avaliação é a exceção de propósito: uma medida de março não "vence", ela é o
// registro. Já um treino de março que terminou não é trabalho pendente de ninguém.
//
// ── Por que uma rota só, e não cinco ──────────────────────────────────────
//
// Porque os cinco selos aparecem juntos, na mesma abertura de tela. Cinco
// requisições dariam cinco estados de carregamento para uma informação que é uma —
// e cinco chances de uma delas falhar e deixar um selo mentindo.
//
// ── Por que `countDocuments` e não `list().length` ────────────────────────
//
// Porque as listas devolvem os documentos inteiros: uma dieta traz refeições e
// alimentos, um treino traz sessões e exercícios. Contar assim para desenhar cinco
// números seria trazer o conteúdo de cinco telas para não mostrar nenhuma.
//
// O preço é que o filtro é REPETIDO aqui em vez de reusado — e é a parte frágil
// deste arquivo. Cada contagem abaixo diz de qual `list` ela é o espelho; se aquela
// mudar de filtro, esta tem de mudar junto, senão o selo passa a discordar da lista
// que ele anuncia. Os testes conferem os dois lados.
//
// ── Permissão por aba ─────────────────────────────────────────────────────
//
// Cada número só é calculado se a conta alcança aquela aba. Não é só economia: sem
// isso, quem não pode ver o financeiro descobriria "esta pessoa tem 3 cobranças em
// aberto" por um selo numa aba que ele nem consegue abrir.
module.exports = function (app) {
  // Hoje em `YYYY-MM-DD`. Treinos e dietas guardam a data como TEXTO nesse formato
  // (ver `statusOf` nos dois modelos), então a comparação é de string — e é ela que
  // define "vigente" lá. Repetir o mesmo formato aqui é o que faz os dois
  // concordarem.
  function hoje() {
    return new Date().toISOString().slice(0, 10);
  }

  // Vigente = já começou (ou não tem começo) e ainda não terminou (ou não tem fim).
  // É o `statusOf === "current"` dos modelos de treino e dieta, escrito como filtro
  // de banco.
  function vigenteHoje() {
    const dia = hoje();
    return {
      $and: [
        { $or: [{ startDate: { $lte: dia } }, { startDate: null }, { startDate: { $exists: false } }] },
        { $or: [{ endDate: { $gte: dia } }, { endDate: null }, { endDate: { $exists: false } }] },
      ],
    };
  }

  // O alcance da AGENDA: só a própria, ou a da equipe inteira com `schedule.team`.
  // Igual ao `alcance()` do controller de compromissos — a contagem tem de ver
  // exatamente o que a aba vai listar.
  async function alcanceDaAgenda(user) {
    const daEquipe = await app.api.user.hasPermission(user, "schedule.team");
    return daEquipe ? await app.api.user.professionalIds() : [user._id];
  }

  app.get("/people/:personId/tab-counts", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.verify(req, res);
    if (trainer === false) return;

    // A pessoa tem de ser desta conta. Mesma guarda das outras rotas da ficha: de
    // fora não se distingue "não existe" de "é de outro profissional".
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) return res.status(404).send({ msg: req.t("errors.studentNotFound") });

    const pode = async (permissao) => app.api.user.hasPermission(trainer, permissao);

    const [verTreinos, verDietas, verFinanceiro, verAgenda, verAvaliacoes] = await Promise.all([
      pode("workouts.view"),
      pode("diets.view"),
      pode("finance.view"),
      pode("schedule.view"),
      pode("assessments.view"),
    ]);

    const doAluno = new ObjectId(String(student._id));
    const doProfissional = new ObjectId(String(trainer._id));

    async function contar(collection, query) {
      const db = await app.mongodb.connectToServer();
      return db.collection(collection).countDocuments(query);
    }

    const [workouts, diet, finance, schedule, assessment] = await Promise.all([
      // Espelho de `Workout_model.list` (trainer + student) + `statusOf === current`.
      verTreinos
        ? contar("workouts", { trainer: doProfissional, student: doAluno, ...vigenteHoje() })
        : 0,

      // Espelho de `Diet_model.list`, mesma regra de vigência.
      verDietas
        ? contar("diets", { trainer: doProfissional, student: doAluno, ...vigenteHoje() })
        : 0,

      // Espelho de `Finance_model.listCharges`, só as em aberto. `status` ausente
      // conta como aberta: é o que `insertCharge` grava por omissão.
      verFinanceiro
        ? contar("charges", {
            student: doAluno,
            $or: [{ status: "open" }, { status: null }, { status: { $exists: false } }],
          })
        : 0,

      // Espelho de `Appointment_model.listOfStudent`, só o que ainda vai acontecer e
      // não foi cancelado. `date` aqui é Date de verdade, não texto.
      verAgenda
        ? (async () => {
            const ids = (await alcanceDaAgenda(trainer)).map((id) => new ObjectId(String(id)));
            if (!ids.length) return 0;

            return contar("appointments", {
              trainer: { $in: ids },
              student: doAluno,
              date: { $gte: new Date() },
              status: { $ne: "canceled" },
            });
          })()
        : 0,

      // Espelho de `Assessment_model.list`. Sem recorte de data: aqui o histórico é
      // o conteúdo.
      verAvaliacoes
        ? contar("assessments", { trainer: doProfissional, student: doAluno })
        : 0,
    ]);

    res.send({ workouts, diet, finance, schedule, assessment });
  });
};
