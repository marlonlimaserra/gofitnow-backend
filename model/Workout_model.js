const { ObjectId } = require("mongodb");

// Treinos e suas sessões.
//
//   workouts          → o treino do aluno (nome, objetivo, período, professor)
//   workout_sessions  → cada dia/divisão do treino, com os exercícios embutidos
//
// Os exercícios ficam DENTRO da sessão em vez de numa coleção própria: uma
// sessão tem ~10 exercícios e eles nunca são lidos sem a sessão. Coleção
// separada só custaria um join a cada abertura de tela.
//
// Tudo é escopado no trainer da sessão — o aluno é sempre validado como sendo
// dele antes de qualquer operação.
function Workout_model(app) {
  this.app = app;
}

Workout_model.prototype.colWorkouts = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("workouts");
};

Workout_model.prototype.colSessions = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("workout_sessions");
};

// ── Situação do treino no tempo ──────────────────────────────────────────
// "current" | "past" | "future". Comparação por dia (YYYY-MM-DD), não por
// timestamp: um treino que termina hoje ainda é atual o dia inteiro.
function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function situacao(w) {
  const d = hoje();
  if (w.endDate && w.endDate < d) return "past";
  if (w.startDate && w.startDate > d) return "future";
  return "current";
}

Workout_model.prototype.situacao = situacao;

// ── Treinos ──────────────────────────────────────────────────────────────

Workout_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.colWorkouts();
  const sessoes = await this.colSessions();

  const docs = await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .sort({ startDate: -1, createdAt: -1 })
    .toArray();

  // Uma agregação só pra todos os treinos, em vez de um count por linha.
  const contagem = await sessoes
    .aggregate([
      { $match: { workout: { $in: docs.map((d) => d._id) } } },
      { $group: { _id: "$workout", total: { $sum: 1 } } },
    ])
    .toArray();

  const porTreino = new Map(contagem.map((c) => [String(c._id), c.total]));

  return docs.map((d) => ({
    ...d,
    status: situacao(d),
    sessionCount: porTreino.get(String(d._id)) || 0,
  }));
};

Workout_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.colWorkouts();
  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  if (!doc) return undefined;
  return { ...doc, status: situacao(doc) };
};

Workout_model.prototype.insert = async function (trainerId, studentId, obj) {
  const col = await this.colWorkouts();

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
  const col = await this.colWorkouts();

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
  const col = await this.colWorkouts();
  const sessoes = await this.colSessions();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  if (r.deletedCount === 0) return false;

  // Sessões órfãs não servem pra nada — vão junto.
  await sessoes.deleteMany({ workout: new ObjectId(id) });
  return true;
};

// Duplica o treino inteiro (com as sessões) para o mesmo ou outro aluno.
Workout_model.prototype.duplicate = async function (trainerId, id, studentId) {
  const origem = await this.data(trainerId, id);
  if (!origem) return undefined;

  const novoId = await this.insert(trainerId, studentId || origem.student, {
    ...origem,
    name: origem.name + " (cópia)",
  });

  const colS = await this.colSessions();
  const sessoes = await colS.find({ workout: new ObjectId(id) }).sort({ order: 1 }).toArray();

  for (const s of sessoes) {
    // eslint-disable-next-line no-unused-vars
    const { _id, workout, createdAt, updatedAt, ...resto } = s;
    await colS.insertOne({
      ...resto,
      workout: novoId,
      trainer: new ObjectId(trainerId),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return novoId;
};

// ── Sessões ──────────────────────────────────────────────────────────────

Workout_model.prototype.listSessions = async function (workoutId) {
  const col = await this.colSessions();
  const docs = await col.find({ workout: new ObjectId(workoutId) }).sort({ order: 1 }).toArray();

  // A tela mostra "N exercícios · N kcal" em cada card; o total de séries é
  // usado no cabeçalho da sessão.
  return docs.map((s) => ({
    ...s,
    exerciseCount: (s.exercises || []).length,
    setCount: (s.exercises || []).reduce((t, e) => t + (e.sets || []).length, 0),
  }));
};

Workout_model.prototype.dataSession = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.colSessions();
  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  if (!doc) return undefined;

  return {
    ...doc,
    exerciseCount: (doc.exercises || []).length,
    setCount: (doc.exercises || []).reduce((t, e) => t + (e.sets || []).length, 0),
  };
};

Workout_model.prototype.insertSession = async function (trainerId, workoutId, obj) {
  const col = await this.colSessions();

  // Nova sessão entra no fim da fila.
  const ultima = await col.findOne({ workout: new ObjectId(workoutId) }, { sort: { order: -1 } });

  const r = await col.insertOne({
    workout: new ObjectId(workoutId),
    trainer: new ObjectId(trainerId),
    name: String(obj.name).trim(),
    order: ultima ? ultima.order + 1 : 0,
    calories: obj.calories !== undefined && obj.calories !== "" ? Number(obj.calories) : null,
    exercises: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Workout_model.prototype.updateSession = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.colSessions();

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
  const col = await this.colSessions();
  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Grava a lista INTEIRA de exercícios da sessão (ordem, séries, dicas). A tela
// edita tudo junto e salva de uma vez — atualizar exercício por exercício
// exigiria ids estáveis dentro do array sem ganho nenhum.
Workout_model.prototype.saveSessionExercises = async function (trainerId, id, exercicios) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.colSessions();

  const limpos = (exercicios || []).map((e, i) => ({
    // `exerciseId` aponta pro catálogo, mas nome/miniatura são copiados: se o
    // exercício sair do catálogo, o treino já montado continua legível.
    exerciseId: ObjectId.isValid(e.exerciseId) ? new ObjectId(e.exerciseId) : null,
    name: String(e.name || "").trim(),
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
    { $set: { exercises: limpos, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

module.exports = Workout_model;
