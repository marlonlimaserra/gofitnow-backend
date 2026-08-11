// Catálogo das ações registradas no histórico.
//
// A CHAVE é o que fica gravado e nunca muda — renomear uma quebraria a leitura
// de tudo que já foi salvo. O rótulo é só apresentação e pode mudar à vontade.
//
// Uma ação que não estiver aqui ainda aparece na tela, com a própria chave
// como rótulo: o log nunca depende deste arquivo estar atualizado.
const ACTIONS = [
  // ── Acesso ──────────────────────────────────────────────────────────────
  { key: "login", category: "auth" },
  { key: "login_failed", category: "auth" },
  { key: "logout", category: "auth" },
  { key: "register", category: "auth" },
  { key: "forgot_password", category: "auth" },
  { key: "reset_password", category: "auth" },
  { key: "change_password", category: "auth" },
  { key: "update_profile", category: "auth" },
  { key: "update_avatar", category: "auth" },
  { key: "delete_avatar", category: "auth" },

  // ── Pessoas ─────────────────────────────────────────────────────────────
  { key: "view_person", category: "people" },
  { key: "lookup_person", category: "people" },
  { key: "create_person", category: "people" },
  { key: "update_person", category: "people" },
  { key: "delete_person", category: "people" },
  { key: "unlink_person", category: "people" },
  { key: "revoke_person_access", category: "people" },
  { key: "request_access", category: "people" },
  { key: "cancel_access_request", category: "people" },
  { key: "approve_access", category: "people" },
  { key: "deny_access", category: "people" },

  // ── Treinos ─────────────────────────────────────────────────────────────
  { key: "create_workout", category: "workouts" },
  { key: "update_workout", category: "workouts" },
  { key: "delete_workout", category: "workouts" },
  { key: "duplicate_workout", category: "workouts" },
  { key: "create_session", category: "workouts" },
  { key: "update_session", category: "workouts" },
  { key: "delete_session", category: "workouts" },
  { key: "update_session_exercises", category: "workouts" },
  { key: "create_workout_template", category: "workouts" },
  { key: "update_workout_template", category: "workouts" },
  { key: "delete_workout_template", category: "workouts" },

  // ── Exercícios ──────────────────────────────────────────────────────────
  { key: "create_exercise", category: "exercises" },
  { key: "update_exercise", category: "exercises" },
  { key: "delete_exercise", category: "exercises" },

  // ── Administração ───────────────────────────────────────────────────────
  { key: "create_professional", category: "admin" },
  { key: "update_professional", category: "admin" },
  { key: "delete_professional", category: "admin" },
  { key: "update_user", category: "admin" },
  { key: "delete_user", category: "admin" },
  { key: "create_role", category: "admin" },
  { key: "update_role", category: "admin" },
  { key: "delete_role", category: "admin" },
  { key: "create_api_key", category: "admin" },
  { key: "revoke_api_key", category: "admin" },
];

const CATEGORIES = [
  { key: "auth" },
  { key: "people" },
  { key: "workouts" },
  { key: "exercises" },
  { key: "admin" },
];

// O que o alvo de uma ação é, para a coluna "Recurso". Só as chaves: o texto
// vem do i18n, em `targetTypes.*`.
const TARGET_TYPE_KEYS = [
  "users",
  "people",
  "roles",
  "workouts",
  "workout_sessions",
  "workout_templates",
  "exercises",
  "access_requests",
  "api_keys",
];

// Os catálogos com os textos do idioma pedido, na forma que a tela espera.
function localizedActions(t) {
  return ACTIONS.map((a) => ({ ...a, label: t(`actions.${a.key}`) }));
}

function localizedCategories(t) {
  return CATEGORIES.map((c) => ({ key: c.key, label: t(`categories.${c.key}`) }));
}

// A tela usa este como mapa chave→texto, não como lista.
function localizedTargetTypes(t) {
  return Object.fromEntries(TARGET_TYPE_KEYS.map((k) => [k, t(`targetTypes.${k}`)]));
}

module.exports = {
  ACTIONS,
  CATEGORIES,
  TARGET_TYPE_KEYS,
  localizedActions,
  localizedCategories,
  localizedTargetTypes,
};
