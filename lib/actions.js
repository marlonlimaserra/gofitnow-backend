// Catálogo das ações registradas no histórico.
//
// A CHAVE é o que fica gravado e nunca muda — renomear uma quebraria a leitura
// de tudo que já foi salvo. O rótulo é só apresentação e pode mudar à vontade.
//
// Uma ação que não estiver aqui ainda aparece na tela, com a própria chave
// como rótulo: o log nunca depende deste arquivo estar atualizado.
const ACTIONS = [
  // ── Acesso ──────────────────────────────────────────────────────────────
  { key: "login", label: "Entrou", category: "auth" },
  { key: "login_failed", label: "Falha no login", category: "auth" },
  { key: "logout", label: "Saiu", category: "auth" },
  { key: "register", label: "Criou a própria conta", category: "auth" },
  { key: "forgot_password", label: "Pediu redefinição de senha", category: "auth" },
  { key: "reset_password", label: "Redefiniu a senha pelo e-mail", category: "auth" },
  { key: "change_password", label: "Trocou a senha", category: "auth" },
  { key: "update_profile", label: "Editou o próprio perfil", category: "auth" },

  // ── Pessoas ─────────────────────────────────────────────────────────────
  { key: "view_person", label: "Abriu uma ficha", category: "people" },
  { key: "lookup_person", label: "Consultou um e-mail", category: "people" },
  { key: "create_person", label: "Cadastrou uma pessoa", category: "people" },
  { key: "update_person", label: "Editou uma ficha", category: "people" },
  { key: "delete_person", label: "Excluiu uma pessoa", category: "people" },
  { key: "unlink_person", label: "Removeu da própria lista", category: "people" },
  { key: "revoke_person_access", label: "Tirou o acesso de uma pessoa", category: "people" },
  { key: "request_access", label: "Pediu acesso a alguém", category: "people" },
  { key: "cancel_access_request", label: "Cancelou um pedido de acesso", category: "people" },
  { key: "approve_access", label: "Liberou acesso a um profissional", category: "people" },
  { key: "deny_access", label: "Recusou um profissional", category: "people" },

  // ── Treinos ─────────────────────────────────────────────────────────────
  { key: "create_workout", label: "Criou um treino", category: "workouts" },
  { key: "update_workout", label: "Editou um treino", category: "workouts" },
  { key: "delete_workout", label: "Excluiu um treino", category: "workouts" },
  { key: "duplicate_workout", label: "Duplicou um treino", category: "workouts" },
  { key: "create_session", label: "Criou uma sessão", category: "workouts" },
  { key: "update_session", label: "Editou uma sessão", category: "workouts" },
  { key: "delete_session", label: "Excluiu uma sessão", category: "workouts" },
  { key: "update_session_exercises", label: "Alterou exercícios da sessão", category: "workouts" },

  // ── Exercícios ──────────────────────────────────────────────────────────
  { key: "create_exercise", label: "Criou um exercício", category: "exercises" },
  { key: "update_exercise", label: "Editou um exercício", category: "exercises" },
  { key: "delete_exercise", label: "Excluiu um exercício", category: "exercises" },

  // ── Administração ───────────────────────────────────────────────────────
  { key: "create_professional", label: "Cadastrou um profissional", category: "admin" },
  { key: "update_professional", label: "Editou um profissional", category: "admin" },
  { key: "delete_professional", label: "Excluiu um profissional", category: "admin" },
  { key: "update_user", label: "Editou um usuário", category: "admin" },
  { key: "delete_user", label: "Excluiu um usuário", category: "admin" },
  { key: "create_role", label: "Criou um tipo de usuário", category: "admin" },
  { key: "update_role", label: "Alterou permissões de um tipo", category: "admin" },
  { key: "delete_role", label: "Excluiu um tipo de usuário", category: "admin" },
];

const CATEGORIES = [
  { key: "auth", label: "Acesso" },
  { key: "people", label: "Pessoas" },
  { key: "workouts", label: "Treinos" },
  { key: "exercises", label: "Exercícios" },
  { key: "admin", label: "Administração" },
];

// O que o alvo de uma ação é, em português, para a coluna "Recurso".
const TARGET_TYPES = {
  users: "Usuário",
  people: "Pessoa",
  roles: "Tipo de usuário",
  workouts: "Treino",
  workout_sessions: "Sessão",
  exercises: "Exercício",
  access_requests: "Pedido de acesso",
};

module.exports = { ACTIONS, CATEGORIES, TARGET_TYPES };
