const permissions = require("./permissions.js");

// A documentação das chamadas que uma chave de API pode fazer.
//
// Só rotas de DADOS. Ficam de fora, de propósito:
//   - /auth/*      — login, logout, redefinição de senha. Quem tem chave já
//                    está autenticado; oferecer login por chave seria uma
//                    segunda forma de virar sessão.
//   - /me/avatar   — envio de imagem, que é da tela.
//   - /health, /   — não têm dado de ninguém.
//
// Cada entrada diz a PERMISSÃO exigida. É a mesma chave que a rota verifica, e
// é o que responde a pergunta "por que recebi 403": a chave age como a pessoa,
// então ela precisa ter a permissão no tipo de usuário dela.
const ROTAS = [
  // ── Pessoas ─────────────────────────────────────────────────────────────
  { method: "GET", path: "/people", permission: "people.view", group: "people", key: "listPeople" },
  { method: "GET", path: "/people/summary", permission: "people.view", group: "people", key: "peopleSummary" },
  { method: "GET", path: "/people/:id", permission: "people.view", group: "people", key: "getPerson" },
  { method: "POST", path: "/people", permission: "people.create", group: "people", key: "createPerson" },
  { method: "PUT", path: "/people/:id", permission: "people.edit", group: "people", key: "updatePerson" },
  { method: "DELETE", path: "/people/:id", permission: "people.delete", group: "people", key: "unlinkPerson" },

  // ── Treinos ─────────────────────────────────────────────────────────────
  { method: "GET", path: "/people/:personId/workouts", permission: "workouts.view", group: "workouts", key: "listWorkouts" },
  { method: "GET", path: "/workouts", permission: "workouts.view", group: "workouts", key: "listAllWorkouts" },
  { method: "GET", path: "/workouts/:id", permission: "workouts.view", group: "workouts", key: "getWorkout" },
  { method: "POST", path: "/people/:personId/workouts", permission: "workouts.manage", group: "workouts", key: "createWorkout" },
  { method: "PUT", path: "/workouts/:id", permission: "workouts.manage", group: "workouts", key: "updateWorkout" },
  { method: "DELETE", path: "/workouts/:id", permission: "workouts.manage", group: "workouts", key: "deleteWorkout" },
  { method: "POST", path: "/workouts/:id/duplicate", permission: "workouts.manage", group: "workouts", key: "duplicateWorkout" },
  { method: "PUT", path: "/people/:personId/workouts/order", permission: "workouts.manage", group: "workouts", key: "reorderWorkouts" },

  // ── Sessões ─────────────────────────────────────────────────────────────

  // ── Exercícios ──────────────────────────────────────────────────────────
  { method: "GET", path: "/exercises", permission: "exercises.view", group: "exercises", key: "listExercises" },
  { method: "GET", path: "/exercises/groups", permission: "exercises.view", group: "exercises", key: "exerciseGroups" },
  { method: "GET", path: "/exercises/:id", permission: "exercises.view", group: "exercises", key: "getExercise" },
  { method: "POST", path: "/exercises", permission: "exercises.manage", group: "exercises", key: "createExercise" },
  { method: "PUT", path: "/exercises/:id", permission: "exercises.manage", group: "exercises", key: "updateExercise" },
  { method: "DELETE", path: "/exercises/:id", permission: "exercises.manage", group: "exercises", key: "deleteExercise" },

  // ── Conta ───────────────────────────────────────────────────────────────
  { method: "GET", path: "/me", permission: null, group: "account", key: "getMe" },
];

// Os parâmetros de consulta que valem a pena documentar. Sem isto quem integra
// descobre `?search=` lendo o código do frontend.
const QUERY = {
  listPeople: ["search"],
  listAllWorkouts: ["search", "personId"],
  listExercises: ["search", "group", "page", "limit"],
};

// O corpo esperado, campo a campo, para as rotas que recebem um. Só os nomes:
// o significado vai na tradução.
const BODY = {
  createPerson: ["name", "email", "phone", "birthDate", "sex", "goal", "weight", "height", "password"],
  updatePerson: ["name", "phone", "birthDate", "sex", "goal", "weight", "height", "notes", "active"],
  createWorkout: ["name", "goal", "teacherName", "startDate", "endDate", "calories", "totalSessions", "tip", "weekdays"],
  updateWorkout: ["name", "goal", "teacherName", "startDate", "endDate", "calories", "totalSessions", "tip", "weekdays"],
  duplicateWorkout: ["name", "studentId"],
  reorderWorkouts: ["ids"],
  setWorkoutExercises: ["exercises"],
  createExercise: ["name", "muscleGroup", "videoUrl", "defaultTip"],
  updateExercise: ["name", "muscleGroup", "videoUrl", "defaultTip"],
};

// A documentação no idioma pedido, agrupada como a tela mostra.
//
// `permissionLabel` sai do MESMO catálogo que a tela de Tipos de usuário usa —
// assim a documentação não pode divergir do nome que o admin vê ao conceder.
function localized(t) {
  const grupos = [];

  for (const rota of ROTAS) {
    let grupo = grupos.find((g) => g.key === rota.group);
    if (!grupo) {
      grupos.push((grupo = { key: rota.group, title: t(`apiDocs.groups.${rota.group}`), items: [] }));
    }

    grupo.items.push({
      key: rota.key,
      method: rota.method,
      path: rota.path,
      summary: t(`apiDocs.routes.${rota.key}`),
      permission: rota.permission,
      permissionLabel: rota.permission ? t(`permissions.items.${rota.permission}.label`) : null,
      query: QUERY[rota.key] || [],
      body: BODY[rota.key] || [],
    });
  }

  return grupos;
}

// Toda permissão citada aqui tem de existir no catálogo: documentar uma que
// não existe mandaria quem integra procurar um checkbox que não há.
function validate() {
  const invalidas = ROTAS.filter((r) => r.permission && !permissions.isValid(r.permission));
  return invalidas.map((r) => `${r.method} ${r.path} → ${r.permission}`);
}

module.exports = { ROTAS, QUERY, BODY, localized, validate };
