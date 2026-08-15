const { ObjectId } = require("mongodb");
// A ordem da semana mora em lib/weekdays.js: é a MESMA para treino e para plano
// alimentar, e duas cópias seriam duas verdades sobre qual dia vem primeiro.
const { WEEKDAYS, weekdaysOf } = require("../lib/weekdays.js");

// Os treinos, com os exercícios dentro.
//
//   workouts → um treino: nome, período, professor e os exercícios
//
// Houve um segundo nível aqui: `workouts` era o plano ("Hipertrofia", 12/08 a
// 12/09) e `workout_sessions` era cada dia dele ("Segunda-feira"), com os
// exercícios. Montar um treino custava quatro passos — cadastrar o plano, abrir,
// criar a sessão, abrir a sessão — e o nível do meio não ganhava nada em troca:
// ninguém abria um plano sem entrar num dia.
//
// Agora cada DIA é um treino. Quem treina três vezes por semana tem três treinos
// na lista, cada um com o próprio período. O preço é repetir período e professor
// entre eles, e é o que o "copiar treino" resolve em um clique.
//
// Os exercícios ficam DENTRO do documento, e não numa collection própria: são uns
// dez, nunca são lidos sem o treino, e separá-los só acrescentaria um join em
// toda abertura de tela.
//
// Tudo é escopado ao profissional — a pessoa é sempre conferida como sendo dele
// antes de qualquer operação.
function Workout_model(app) {
  this.app = app;
}

Workout_model.prototype.workoutsCollection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("workouts");
};

// ── Where the workout sits in time ───────────────────────────────────────
// "current" | "past" | "future". Compared by day (YYYY-MM-DD), not by
// timestamp: a workout ending today is still current for the whole day.
function today() {
  return new Date().toISOString().slice(0, 10);
}

function statusOf(w) {
  const d = today();
  if (w.endDate && w.endDate < d) return "past";
  if (w.startDate && w.startDate > d) return "future";
  return "current";
}

Workout_model.prototype.statusOf = statusOf;

// ── Workouts ─────────────────────────────────────────────────────────────

Workout_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.workoutsCollection();

  const docs = await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .sort({ startDate: -1, createdAt: -1 })
    .toArray();

  // A ordem da lista é escolhida à mão, arrastando os cards. Os treinos criados
  // antes de `order` existir não têm o campo, e ordenar por ele os jogaria todos
  // para a frente ou para trás de uma vez — a lista mudaria sozinha debaixo de
  // quem estava olhando.
  //
  // Então a primeira listagem CONGELA a sequência que a tela já mostrava (data
  // decrescente) e grava como ordem. Acontece uma vez por pessoa: da segunda em
  // diante todo mundo tem posição explícita e o `sort` abaixo é quem manda.
  const semOrdem = docs.some((d) => typeof d.order !== "number");
  if (semOrdem && docs.length) {
    docs.forEach((d, i) => {
      d.order = i;
    });
    await col.bulkWrite(
      docs.map((d) => ({
        updateOne: { filter: { _id: d._id }, update: { $set: { order: d.order } } },
      }))
    );
  } else {
    docs.sort((a, b) => a.order - b.order);
  }

  // Contado aqui, em memória, e não por agregação: os exercícios moram dentro do
  // documento que já foi lido. Antes eram duas agregações numa segunda collection
  // — o custo de ter dois níveis, que sumiu junto com eles.
  return docs.map((d) => {
    const exercises = d.exercises || [];

    return {
      ...d,
      status: statusOf(d),
      exerciseCount: exercises.length,
      setCount: exercises.reduce((t, e) => t + (e.sets || []).length, 0),
      // Ordenado para a etiqueta não trocar de lugar entre um carregamento e o
      // outro.
      muscleGroups: [...new Set(exercises.map((e) => e.muscleGroup).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "pt-BR")
      ),
    };
  });
};

Workout_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.workoutsCollection();
  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  if (!doc) return undefined;

  const exercises = doc.exercises || [];
  return {
    ...doc,
    status: statusOf(doc),
    exerciseCount: exercises.length,
    setCount: exercises.reduce((t, e) => t + (e.sets || []).length, 0),
  };
};

Workout_model.prototype.insert = async function (trainerId, studentId, obj) {
  const col = await this.workoutsCollection();

  // O treino novo entra no FIM da lista da pessoa. A posição é contada aqui e
  // não vem do corpo do pedido: quem cria não escolhe lugar na fila, e a cópia
  // de um treino precisa nascer no fim em vez de dividir a casa com a original
  // (ela é criada com `...source`, que traria o `order` de lá).
  const quantos = await col.countDocuments({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
  });

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    name: String(obj.name).trim(),
    goal: obj.goal ? String(obj.goal).trim() : "",
    teacherName: obj.teacherName ? String(obj.teacherName).trim() : "",
    startDate: obj.startDate ? String(obj.startDate) : "",
    endDate: obj.endDate ? String(obj.endDate) : "",
    calories: obj.calories !== undefined && obj.calories !== "" ? Number(obj.calories) : null,
    totalSessions:
      obj.totalSessions !== undefined && obj.totalSessions !== ""
        ? Number(obj.totalSessions)
        : null,
    tip: obj.tip ? String(obj.tip).trim() : "",
    weekdays: weekdaysOf(obj.weekdays),
    order: quantos,
    // Nasce com a lista vazia em vez de sem o campo: a tela abre direto nos
    // exercícios, e `undefined` obrigaria toda leitura a se defender.
    exercises: [],
    kind: "individual",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Workout_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.workoutsCollection();

  const set = { updatedAt: new Date() };
  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.goal !== undefined) set.goal = String(obj.goal).trim();
  if (obj.teacherName !== undefined) set.teacherName = String(obj.teacherName).trim();
  if (obj.startDate !== undefined) set.startDate = String(obj.startDate);
  if (obj.endDate !== undefined) set.endDate = String(obj.endDate);
  if (obj.tip !== undefined) set.tip = String(obj.tip).trim();
  if (obj.calories !== undefined) set.calories = obj.calories === "" ? null : Number(obj.calories);
  if (obj.totalSessions !== undefined)
    set.totalSessions = obj.totalSessions === "" ? null : Number(obj.totalSessions);
  if (obj.weekdays !== undefined) set.weekdays = weekdaysOf(obj.weekdays);

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: set }
  );
  return r.matchedCount > 0;
};

// A página da lista GERAL de treinos, montada no banco.
//
// Mesma razão de `pageStudents`: devolver tudo e cortar no navegador não passa
// de alguns milhares de registros. Aqui pesa ainda mais, porque cada treino
// carrega os exercícios dentro — a lista inteira seriam dezenas de milhares de
// séries trafegando para mostrar uma contagem.
//
// É agregação porque duas coisas que a tela ordena não existem no documento: o
// NOME da pessoa (mora em users) e a CONTAGEM de exercícios (é o tamanho de um
// array).
const ORDEM_TREINOS = {
  name: "name",
  person: "personName",
  goal: "goal",
  teacher: "teacherName",
  period: "startDate",
  weekdays: "primeiroDia",
  exercises: "exerciseCount",
  createdAt: "createdAt",
};

// "Passado" e "futuro" comparados por dia (YYYY-MM-DD), como `statusOf` faz em
// memória. Data vazia nunca classifica: um treino sem fim não é passado.
function filtroDeStatus(status, hoje) {
  const passado = { endDate: { $ne: "", $lt: hoje } };
  const futuro = { startDate: { $ne: "", $gt: hoje } };

  if (status === "past") return passado;
  if (status === "future") return futuro;
  if (status === "current") return { $nor: [passado, futuro] };
  return null;
}

Workout_model.prototype.pageAll = async function (trainerId, filtros = {}) {
  const col = await this.workoutsCollection();
  const hoje = today();

  const etapas = [{ $match: { trainer: new ObjectId(trainerId) } }];

  if (filtros.studentId && ObjectId.isValid(filtros.studentId)) {
    etapas.push({ $match: { student: new ObjectId(filtros.studentId) } });
  }

  const termo = String(filtros.search || "").trim();
  if (termo) {
    const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    etapas.push({ $match: { name: { $regex: escapado, $options: "i" } } });
  }

  const campo = ORDEM_TREINOS[filtros.sort] || "createdAt";
  const direcao = filtros.dir === "asc" ? 1 : -1;
  const limite = Math.min(Math.max(Number(filtros.limit) || 15, 1), 200);
  const pagina = Math.max(Number(filtros.page) || 1, 1);

  const daAba = filtroDeStatus(filtros.status, hoje);

  // ── O que é calculado ANTES do corte, e o que é calculado depois ──────────
  //
  // A resposta sempre teve só quinze linhas — o corte é do banco, não do
  // navegador. O que não era verdade é que o TRABALHO fosse de quinze: o
  // pipeline juntava a pessoa, somava séries e reunia grupos musculares dos 638
  // treinos para jogar 623 fora no estágio seguinte. Medido no servidor, 65ms
  // por requisição virando 6ms quando o cálculo vem depois do $limit.
  //
  // Antes do corte fica só o que os estágios seguintes precisam para decidir
  // QUAIS quinze são: o status (as contagens das abas contam todo mundo), e os
  // dois campos calculados por onde a tela ordena.
  const juntarPessoa = [
    // Sem sub-pipeline de propósito. `localField/foreignField` com `pipeline`
    // junto desliga a junção indexada do Mongo: 46ms contra 15ms para a mesma
    // junção, medido em 8.0. O preço é o documento inteiro da pessoa entrar no
    // `pessoa` — inclusive senha e salt —, e por isso o campo é DESCARTADO no
    // $project do fim. Tirar aquele `pessoa: 0` vaza hash de senha para a tela.
    { $lookup: { from: "users", localField: "student", foreignField: "_id", as: "pessoa" } },
    { $addFields: { personName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] } } },
  ];

  etapas.push({
    $addFields: {
      // O status calculado no banco, com a mesma regra do statusOf: fim antes
      // de hoje é passado, início depois de hoje é futuro, o resto é atual.
      status: {
        $switch: {
          branches: [
            {
              case: {
                $and: [{ $ne: ["$endDate", ""] }, { $lt: ["$endDate", hoje] }],
              },
              then: "past",
            },
            {
              case: {
                $and: [{ $ne: ["$startDate", ""] }, { $gt: ["$startDate", hoje] }],
              },
              then: "future",
            },
          ],
          default: "current",
        },
      },
      // Os dois baratos: `$size` e `$arrayElemAt` não percorrem série nenhuma, e
      // a tela ordena por eles.
      exerciseCount: { $size: { $ifNull: ["$exercises", []] } },
      primeiroDia: { $ifNull: [{ $arrayElemAt: ["$weekdays", 0] }, ""] },
    },
  });

  // Ordenar pelo nome da pessoa é o único caso em que a junção precisa vir
  // antes: não dá para escolher as quinze primeiras por um campo que ainda não
  // existe. Custa 22ms em vez de 6ms — e continua sendo um terço dos 65ms.
  const ordenaPorPessoa = campo === "personName";
  if (ordenaPorPessoa) etapas.push(...juntarPessoa);

  // As CONTAGENS das abas saem da mesma passagem, e antes do filtro de aba: a
  // aba "Passados" precisa saber quantos atuais existem para escrever o número
  // no botão ao lado.
  etapas.push({
    $facet: {
      counts: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
      pagina: [
        ...(daAba ? [{ $match: daAba }] : []),
        { $addFields: { __vazio: { $cond: [{ $in: [`$${campo}`, [null, ""]] }, 1, 0] } } },
        { $sort: { __vazio: 1, [campo]: direcao, _id: 1 } },
        { $skip: (pagina - 1) * limite },
        { $limit: limite },
        // Daqui para baixo são QUINZE documentos, não a coleção inteira.
        ...(ordenaPorPessoa ? [] : juntarPessoa),
        {
          $addFields: {
            setCount: {
              $sum: {
                $map: {
                  input: { $ifNull: ["$exercises", []] },
                  as: "e",
                  in: { $size: { $ifNull: ["$$e.sets", []] } },
                },
              },
            },
            muscleGroups: {
              $sortArray: {
                input: {
                  $setUnion: [
                    {
                      $filter: {
                        input: { $ifNull: ["$exercises.muscleGroup", []] },
                        as: "g",
                        cond: { $ne: ["$$g", ""] },
                      },
                    },
                    [],
                  ],
                },
                sortBy: 1,
              },
            },
          },
        },
        // Os exercícios NÃO vão na resposta: são o corpo do treino, e a tela
        // mostra só as contagens calculadas acima. `pessoa` sai junto, e é o que
        // impede o documento inteiro da pessoa de chegar ao navegador.
        { $project: { exercises: 0, pessoa: 0, __vazio: 0, primeiroDia: 0 } },
      ],
      total: [...(daAba ? [{ $match: daAba }] : []), { $count: "n" }],
    },
  });

  const [saida] = await col
    .aggregate(etapas, { collation: { locale: "pt", strength: 1 } })
    .toArray();

  const porStatus = Object.fromEntries((saida?.counts || []).map((c) => [c._id, c.n]));
  const counts = {
    current: porStatus.current || 0,
    past: porStatus.past || 0,
    future: porStatus.future || 0,
  };
  counts.all = counts.current + counts.past + counts.future;

  return { rows: saida?.pagina || [], total: saida?.total?.[0]?.n || 0, counts };
};

// Todos os treinos do profissional, de todas as pessoas.
//
// Diferente do `list`, que é a lista DENTRO de uma pessoa: aqui a pergunta é
// "o que eu montei ultimamente", e por isso a ordem é sempre por data de
// criação, decrescente — não a ordem manual dos cards, que só faz sentido
// dentro da ficha de alguém.
//
// O filtro por `student` é opcional; o escopo por `trainer` nunca é.
Workout_model.prototype.listAll = async function (trainerId, filtros = {}) {
  const col = await this.workoutsCollection();

  const query = { trainer: new ObjectId(trainerId) };
  if (filtros.studentId && ObjectId.isValid(filtros.studentId)) {
    query.student = new ObjectId(filtros.studentId);
  }

  // A busca por nome vai no banco, com escape: um treino chamado "C+" viraria
  // quantificador inválido numa expressão regular montada na mão.
  const termo = String(filtros.search || "").trim();
  if (termo) {
    query.name = { $regex: termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  return docs.map((d) => {
    const exercises = d.exercises || [];

    return {
      ...d,
      // Os exercícios NÃO vão na resposta: são o corpo do treino, e uma lista
      // de duzentos treinos carregaria alguns milhares de séries que a tela não
      // usa. O que ela mostra é a contagem.
      exercises: undefined,
      status: statusOf(d),
      exerciseCount: exercises.length,
      setCount: exercises.reduce((t, e) => t + (e.sets || []).length, 0),
      muscleGroups: [...new Set(exercises.map((e) => e.muscleGroup).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "pt-BR")
      ),
    };
  });
};

// Grava a ordem escolhida na tela. Recebe os ids da pessoa na sequência nova,
// inteira, e numera 0..n.
//
// É uma rota só, e não um PUT por treino: arrastar é UM gesto, e um PUT por
// card encheria o histórico de auditoria com uma linha "treino alterado" para
// cada vizinho que só andou uma casa.
Workout_model.prototype.saveOrder = async function (trainerId, studentId, ids) {
  if (!Array.isArray(ids) || !ids.length) return false;

  const validos = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (!validos.length) return false;

  const col = await this.workoutsCollection();
  await col.bulkWrite(
    validos.map((_id, i) => ({
      updateOne: {
        // O filtro repete dono e pessoa: só o id deixaria um profissional
        // reordenar treino alheio mandando ids que não são dele.
        filter: { _id, trainer: new ObjectId(trainerId), student: new ObjectId(studentId) },
        update: { $set: { order: i, updatedAt: new Date() } },
      },
    }))
  );

  return true;
};

Workout_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.workoutsCollection();

  // Os exercícios vão junto por morarem dentro do documento — não há mais uma
  // segunda collection para deixar órfãos.
  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Todos os treinos de uma pessoa, de uma vez. Chamado quando a pessoa é
// excluída.
//
// Não filtra por profissional: quem chama já conferiu que pode apagar a pessoa,
// e um treino que sobrasse aqui ficaria apontando para um `student` que não
// existe mais — invisível em toda tela e impossível de alcançar de novo.
Workout_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;
  const col = await this.workoutsCollection();

  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount || 0;
};

// Copia o treino inteiro — exercícios e séries — para a mesma pessoa ou outra.
//
// `name` é opcional: quando a tela pede o nome da cópia, ele chega aqui e o
// treino novo já nasce com ele, em vez de nascer como "(cópia)" e ser renomeado
// num segundo request — que deixaria o nome errado se a segunda chamada falhasse.
Workout_model.prototype.duplicate = async function (trainerId, id, studentId, name) {
  const source = await this.data(trainerId, id);
  if (!source) return undefined;

  const escolhido = name !== undefined && String(name).trim() ? String(name).trim() : null;

  const newId = await this.insert(trainerId, studentId || source.student, {
    ...source,
    name: escolhido || source.name + " (cópia)",
  });

  // Cópia PROFUNDA: `structuredClone` evita que as séries da cópia e as da
  // original apontem para os mesmos objetos — mexer numa mudaria a outra, que é o
  // pior tipo de defeito para descobrir depois.
  const col = await this.workoutsCollection();
  await col.updateOne(
    { _id: newId },
    { $set: { exercises: structuredClone(source.exercises || []), updatedAt: new Date() } }
  );

  return newId;
};

// ── Exercícios ───────────────────────────────────────────────────────────
//
// Salva a lista INTEIRA de uma vez (ordem, séries, dicas). A tela edita tudo
// junto e salva uma vez — atualizar exercício a exercício exigiria ids estáveis
// dentro do array sem ganho nenhum.
Workout_model.prototype.saveExercises = async function (trainerId, id, exercises) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.workoutsCollection();

  const cleaned = (exercises || []).map((e, i) => ({
    // `exerciseId` aponta para o catálogo, mas nome, grupo e miniatura são
    // COPIADOS: se o exercício sair do catálogo, o treino já montado continua
    // legível — e a etiqueta de grupo muscular da listagem não some.
    exerciseId: ObjectId.isValid(e.exerciseId) ? new ObjectId(e.exerciseId) : null,
    name: String(e.name || "").trim(),
    muscleGroup: e.muscleGroup ? String(e.muscleGroup).trim() : "",
    thumbUrl: e.thumbUrl || null,
    videoUrl: e.videoUrl || null,
    order: i,
    method: e.method ? String(e.method).trim() : "",
    goal: e.goal ? String(e.goal).trim() : "",
    tip: e.tip ? String(e.tip).trim() : "",
    sets: (e.sets || []).map((s) => ({
      unit: s.unit || "reps", // "reps" | "seconds" | "minutes" | "meters"
      quantity: s.quantity !== undefined && s.quantity !== "" ? String(s.quantity) : "",
      load: s.load !== undefined && s.load !== "" ? String(s.load) : "",
      intensity: s.intensity !== undefined && s.intensity !== "" ? String(s.intensity) : "",
      speed: s.speed || "",
      rest: s.rest !== undefined && s.rest !== "" ? String(s.rest) : "",
    })),
  }));

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: { exercises: cleaned, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

module.exports = Workout_model;
