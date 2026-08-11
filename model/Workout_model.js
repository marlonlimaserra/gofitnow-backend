const { ObjectId } = require("mongodb");

// Workouts and their sessions.
//
//   workouts          → the student's workout (name, goal, period, teacher)
//   workout_sessions  → each day/split, with the exercises embedded
//
// Exercises live INSIDE the session instead of in their own collection: a
// session holds ~10 exercises and they are never read without the session. A
// separate collection would only add a join on every screen load.
//
// Everything is scoped to the session's trainer — the student is always
// verified as belonging to them before any operation.
function Workout_model(app) {
  this.app = app;
}

Workout_model.prototype.workoutsCollection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("workouts");
};

Workout_model.prototype.sessionsCollection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("workout_sessions");
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
  const sessions = await this.sessionsCollection();

  const docs = await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .sort({ startDate: -1, createdAt: -1 })
    .toArray();

  // A single aggregation for every workout, instead of one count per row.
  const counts = await sessions
    .aggregate([
      { $match: { workout: { $in: docs.map((d) => d._id) } } },
      { $group: { _id: "$workout", total: { $sum: 1 } } },
    ])
    .toArray();

  const byWorkout = new Map(counts.map((c) => [String(c._id), c.total]));

  // Os grupos musculares que aparecem em cada treino, para as etiquetas da
  // listagem. Vai num pipeline próprio porque o $unwind dos exercícios
  // multiplicaria as linhas e estragaria a contagem de sessões acima — o que
  // importa é não fazer uma consulta POR TREINO, e isto continua sendo uma só.
  const groups = await sessions
    .aggregate([
      { $match: { workout: { $in: docs.map((d) => d._id) } } },
      { $unwind: "$exercises" },
      { $match: { "exercises.muscleGroup": { $nin: [null, ""] } } },
      { $group: { _id: "$workout", groups: { $addToSet: "$exercises.muscleGroup" } } },
    ])
    .toArray();

  // $addToSet não tem ordem; ordenar aqui deixa a etiqueta no mesmo lugar entre
  // um carregamento e o outro.
  const groupsByWorkout = new Map(
    groups.map((g) => [String(g._id), (g.groups || []).sort((a, b) => a.localeCompare(b, "pt-BR"))])
  );

  return docs.map((d) => ({
    ...d,
    status: statusOf(d),
    sessionCount: byWorkout.get(String(d._id)) || 0,
    muscleGroups: groupsByWorkout.get(String(d._id)) || [],
  }));
};

Workout_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.workoutsCollection();
  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  if (!doc) return undefined;
  return { ...doc, status: statusOf(doc) };
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
  const sessions = await this.sessionsCollection();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  if (r.deletedCount === 0) return false;

  // Orphan sessions are useless — they go with it.
  await sessions.deleteMany({ workout: new ObjectId(id) });
  return true;
};

// Copies the whole workout (with its sessions) to the same or another student.
// `name` é opcional: quando a tela pede o nome da cópia, ela chega aqui e o
// treino novo já nasce com ele — em vez de criar como "(cópia)" e renomear num
// segundo request, que deixaria o nome errado se a segunda chamada falhasse.
Workout_model.prototype.duplicate = async function (trainerId, id, studentId, name) {
  const source = await this.data(trainerId, id);
  if (!source) return undefined;

  const escolhido = name !== undefined && String(name).trim() ? String(name).trim() : null;

  const newId = await this.insert(trainerId, studentId || source.student, {
    ...source,
    name: escolhido || source.name + " (cópia)",
  });

  const sessions = await this.sessionsCollection();
  const rows = await sessions.find({ workout: new ObjectId(id) }).sort({ order: 1 }).toArray();

  for (const s of rows) {
    // eslint-disable-next-line no-unused-vars
    const { _id, workout, createdAt, updatedAt, ...rest } = s;
    await sessions.insertOne({
      ...rest,
      workout: newId,
      trainer: new ObjectId(trainerId),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return newId;
};

// ── Sessions ─────────────────────────────────────────────────────────────

Workout_model.prototype.listSessions = async function (workoutId) {
  const col = await this.sessionsCollection();
  const docs = await col.find({ workout: new ObjectId(workoutId) }).sort({ order: 1 }).toArray();

  // The screen shows "N exercises · N sets" on each card.
  return docs.map((s) => ({
    ...s,
    exerciseCount: (s.exercises || []).length,
    setCount: (s.exercises || []).reduce((t, e) => t + (e.sets || []).length, 0),
  }));
};

Workout_model.prototype.dataSession = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.sessionsCollection();
  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  if (!doc) return undefined;

  return {
    ...doc,
    exerciseCount: (doc.exercises || []).length,
    setCount: (doc.exercises || []).reduce((t, e) => t + (e.sets || []).length, 0),
  };
};

Workout_model.prototype.insertSession = async function (trainerId, workoutId, obj) {
  const col = await this.sessionsCollection();

  // A new session goes to the end of the queue.
  const last = await col.findOne({ workout: new ObjectId(workoutId) }, { sort: { order: -1 } });

  const r = await col.insertOne({
    workout: new ObjectId(workoutId),
    trainer: new ObjectId(trainerId),
    name: String(obj.name).trim(),
    order: last ? last.order + 1 : 0,
    calories: obj.calories !== undefined && obj.calories !== "" ? Number(obj.calories) : null,
    exercises: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// Copia uma sessão com os exercícios e as séries dela.
//
// O destino é opcional: sem ele a cópia fica no MESMO treino, que é o caso
// comum ("segunda e quarta são iguais"). Com ele, vai para outro treino — que
// pode ser de outra pessoa, já que o controller confere que o treino de destino
// é deste profissional.
//
// A cópia entra no FIM da fila do destino, como toda sessão nova: inserir no
// meio empurraria as outras e mudaria uma ordem que ninguém pediu para mudar.
Workout_model.prototype.duplicateSession = async function (trainerId, id, workoutId, name) {
  const source = await this.dataSession(trainerId, id);
  if (!source) return undefined;

  const col = await this.sessionsCollection();
  const destino = workoutId ? new ObjectId(workoutId) : source.workout;

  const last = await col.findOne({ workout: destino }, { sort: { order: -1 } });
  const escolhido = name !== undefined && String(name).trim() ? String(name).trim() : null;

  // Cópia PROFUNDA dos exercícios: `structuredClone` evita que as séries da
  // cópia e as da original apontem para os mesmos objetos — mexer numa mudaria
  // a outra, que é o pior tipo de bug para descobrir depois.
  const exercises = structuredClone(source.exercises || []);

  const r = await col.insertOne({
    workout: destino,
    trainer: new ObjectId(trainerId),
    name: escolhido || source.name + " (cópia)",
    order: last ? last.order + 1 : 0,
    calories: source.calories ?? null,
    exercises,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Workout_model.prototype.updateSession = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.sessionsCollection();

  const set = { updatedAt: new Date() };
  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.calories !== undefined) set.calories = obj.calories === "" ? null : Number(obj.calories);
  if (obj.order !== undefined) set.order = Number(obj.order);

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: set }
  );
  return r.matchedCount > 0;
};

Workout_model.prototype.deleteSession = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.sessionsCollection();
  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Saves the session's WHOLE exercise list (order, sets, tips). The screen edits
// it all together and saves once — updating exercise by exercise would need
// stable ids inside the array for no gain.
Workout_model.prototype.saveSessionExercises = async function (trainerId, id, exercises) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.sessionsCollection();

  const cleaned = (exercises || []).map((e, i) => ({
    // `exerciseId` points at the catalog, but name/thumbnail are copied: if the
    // exercise leaves the catalog, the assembled workout stays readable.
    exerciseId: ObjectId.isValid(e.exerciseId) ? new ObjectId(e.exerciseId) : null,
    name: String(e.name || "").trim(),
    // O grupo é copiado pela MESMA razão do nome e da miniatura: a tela do treino
    // mostra as etiquetas de grupo de cada sessão, e um exercício que saia do
    // catálogo não pode apagar a etiqueta de um treino já montado.
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
