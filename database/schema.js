// Cria as coleções e os índices do GoFitNow. Roda no boot do app (app.js) e
// também sozinho via `npm run db:init`. É idempotente: rodar de novo não
// duplica nada. Coleções e campos são em inglês.
const COLECOES = ["users", "user_tokens", "workouts", "workout_sessions", "exercises"];

module.exports = async function ensureSchema(app) {
  const db = await app.mongodb.connectToServer();

  const existentes = (await db.listCollections({}, { nameOnly: true }).toArray()).map(
    (c) => c.name
  );

  for (const nome of COLECOES) {
    if (!existentes.includes(nome)) {
      await db.createCollection(nome);
      console.log("[schema] coleção criada: " + nome);
    }
  }

  // users — o e-mail é a chave de login, então o único no banco é o que
  // garante de verdade que não entram dois cadastros iguais (a checagem no
  // controller sozinha perde numa corrida entre dois cadastros simultâneos).
  //
  // O índice é PARCIAL porque student sem acesso pode não ter e-mail nenhum:
  // sem o filtro, o segundo student sem e-mail colidiria com o primeiro.
  await db.collection("users").createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_unique" }
  );

  // Listagem de students de um trainer e listagem de trainers pelo admin.
  await db.collection("users").createIndex(
    { type: 1, trainer: 1, createdAt: -1 },
    { name: "by_type_trainer" }
  );
  await db.collection("users").createIndex({ type: 1, name: 1 }, { name: "by_type_name" });
  await db.collection("users").createIndex({ admin: 1 }, { name: "by_admin" });

  // user_tokens — busca por token a cada request; TTL limpa os expirados.
  await db.collection("user_tokens").createIndex({ token: 1 }, { unique: true, name: "token_unique" });
  await db.collection("user_tokens").createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "token_ttl" }
  );
  await db.collection("user_tokens").createIndex({ user: 1 }, { name: "by_user" });

  // workouts — sempre listados por (trainer, student), ordenados por período.
  await db
    .collection("workouts")
    .createIndex({ trainer: 1, student: 1, startDate: -1 }, { name: "by_trainer_student" });

  // workout_sessions — lidas por treino, na ordem definida pelo trainer.
  await db.collection("workout_sessions").createIndex({ workout: 1, order: 1 }, { name: "by_workout" });
  await db.collection("workout_sessions").createIndex({ trainer: 1 }, { name: "by_trainer" });

  // exercises — catálogo por trainer. A ordenação e a busca usam `nameSort`
  // (nome sem espaços, minúsculo e sem acento) — ver Exercise_model.
  await db.collection("exercises").createIndex({ trainer: 1, nameSort: 1 }, { name: "by_trainer_name" });
  await db
    .collection("exercises")
    .createIndex({ trainer: 1, muscleGroup: 1, nameSort: 1 }, { name: "by_trainer_group" });

  console.log("[schema] coleções e índices ok");
};

module.exports.COLECOES = COLECOES;
