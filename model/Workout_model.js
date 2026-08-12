const { ObjectId } = require("mongodb");

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

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: set }
  );
  return r.matchedCount > 0;
};

Workout_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.workoutsCollection();

  // Os exercícios vão junto por morarem dentro do documento — não há mais uma
  // segunda collection para deixar órfãos.
  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
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
