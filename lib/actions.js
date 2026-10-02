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
  { key: "create_person", category: "people" },
  { key: "update_person", category: "people" },
  { key: "update_person_avatar", category: "people" },
  { key: "delete_person_avatar", category: "people" },
  { key: "delete_person", category: "people" },
  { key: "unlink_person", category: "people" },
  { key: "revoke_person_access", category: "people" },
  { key: "reset_invite_link", category: "people" },
  { key: "create_diet", category: "diets" },
  { key: "update_diet", category: "diets" },
  { key: "delete_diet", category: "diets" },
  { key: "update_diet_meals", category: "diets" },
  { key: "create_anamnesis", category: "anamnesis" },
  { key: "update_anamnesis", category: "anamnesis" },
  { key: "create_anamnesis_link", category: "anamnesis" },
  { key: "send_anamnesis_link", category: "anamnesis" },
  { key: "create_supplement", category: "supplements" },
  { key: "update_supplement", category: "supplements" },
  { key: "delete_supplement", category: "supplements" },
  { key: "create_exam", category: "exams" },
  { key: "update_exam", category: "exams" },
  { key: "delete_exam", category: "exams" },
  { key: "create_prescription", category: "prescriptions" },
  { key: "update_prescription", category: "prescriptions" },
  { key: "delete_prescription", category: "prescriptions" },
  { key: "create_assessment", category: "assessments" },
  { key: "update_assessment", category: "assessments" },
  { key: "delete_assessment", category: "assessments" },
  { key: "create_appointment", category: "schedule" },
  { key: "update_appointment", category: "schedule" },
  { key: "delete_appointment", category: "schedule" },
  { key: "create_service", category: "schedule" },
  { key: "update_service", category: "schedule" },
  { key: "delete_service", category: "schedule" },
  { key: "update_availability", category: "schedule" },
  { key: "create_booking_page", category: "schedule" },
  { key: "update_booking_page", category: "schedule" },
  { key: "delete_booking_page", category: "schedule" },
  { key: "update_currency", category: "admin" },
  { key: "update_timezone", category: "admin" },
  { key: "update_ai_settings", category: "admin" },

  // O assistente agindo por FERRAMENTA (porta MCP).
  //
  // Uma chave só, e não uma por ferramenta: o que muda entre elas é o nome, que
  // vai no `extra` e no alvo. Treze chaves aqui seriam treze rótulos para
  // traduzir e uma lista de filtro que ninguém lê até o fim — e a pergunta que
  // se faz ao histórico é "o que o assistente fez?", não "quantas vezes ele
  // chamou pessoa_editar".
  { key: "mcp_tool", category: "admin" },
  { key: "create_charge", category: "finance" },
  { key: "update_charge", category: "finance" },
  { key: "delete_charge", category: "finance" },
  { key: "create_payment", category: "finance" },
  { key: "update_payment", category: "finance" },
  { key: "delete_payment", category: "finance" },
  { key: "create_payment_method", category: "finance" },
  { key: "update_payment_method", category: "finance" },
  { key: "delete_payment_method", category: "finance" },
  { key: "create_food", category: "foods" },
  { key: "update_food", category: "foods" },
  { key: "delete_food", category: "foods" },

  // ── Treinos ─────────────────────────────────────────────────────────────
  { key: "create_workout", category: "workouts" },
  { key: "update_workout", category: "workouts" },
  { key: "delete_workout", category: "workouts" },
  { key: "duplicate_workout", category: "workouts" },
  { key: "update_workout_exercises", category: "workouts" },
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
  // Os GRUPOS de permissão (26/09/2026). Mesma categoria dos tipos: quem lê o
  // log procurando "quem mexeu em permissão" tem de achar os dois juntos.
  { key: "create_permission_group", category: "admin" },
  { key: "update_permission_group", category: "admin" },
  { key: "delete_permission_group", category: "admin" },
  { key: "create_api_key", category: "admin" },
  { key: "revoke_api_key", category: "admin" },
  { key: "claim_domain", category: "admin" },
  { key: "claim_custom_domain", category: "admin" },
  { key: "remove_custom_domain", category: "admin" },
  { key: "update_theme", category: "admin" },
  { key: "upload_brand_image", category: "admin" },

  // ── O CATÁLOGO ESTAVA ATRASADO (02/10/2026) ───────────────────────────
  //
  // *"verifique a ação, acho que tem muito mais coisa agora, pois aparecendo
  // um monte em inglês"*.
  //
  // Cinquenta e sete ações eram GRAVADAS pelo código e nunca entraram aqui.
  // O arquivo diz, logo no topo, que isso não quebra nada — a tela cai na
  // própria chave como rótulo —, e foi exatamente o que aconteceu: o filtro
  // de Logs virou uma lista com "create_equipment" e "create_group_class" no
  // meio das frases em português.
  //
  // A lição não é "faltou disciplina": é que uma ação nova custa DUAS
  // escritas em arquivos diferentes, e a segunda não dói na hora. O teste de
  // `test/lib/acoesDoCatalogo.test.js` passou a cobrar as duas juntas.
  { key: "create_lead", category: "leads" },
  { key: "update_lead", category: "leads" },
  { key: "delete_lead", category: "leads" },
  { key: "convert_lead", category: "leads" },
  { key: "update_lead_avatar", category: "leads" },
  { key: "delete_lead_avatar", category: "leads" },
  { key: "create_custom_field", category: "configuration" },
  { key: "update_custom_field", category: "configuration" },
  { key: "delete_custom_field", category: "configuration" },
  { key: "create_custom_field_group", category: "configuration" },
  { key: "delete_custom_field_group", category: "configuration" },
  { key: "create_department", category: "configuration" },
  { key: "delete_department", category: "configuration" },
  { key: "create_aulao", category: "schedule" },
  { key: "delete_aulao", category: "schedule" },
  { key: "create_group_class", category: "schedule" },
  { key: "update_group_class", category: "schedule" },
  { key: "delete_group_class", category: "schedule" },
  { key: "enroll_group_class", category: "schedule" },
  { key: "create_checkin", category: "schedule" },
  { key: "create_employee", category: "employees" },
  { key: "update_employee", category: "employees" },
  { key: "delete_employee", category: "employees" },
  { key: "create_employee_record", category: "employees" },
  { key: "create_equipment", category: "structure" },
  { key: "create_maintenance", category: "structure" },
  { key: "create_supply_move", category: "structure" },
  { key: "create_payable", category: "finance" },
  { key: "update_payable", category: "finance" },
  { key: "delete_payable", category: "finance" },
  { key: "create_supplier", category: "finance" },
  { key: "update_supplier", category: "finance" },
  { key: "delete_supplier", category: "finance" },
  { key: "create_recurrence", category: "finance" },
  { key: "update_recurrence", category: "finance" },
  { key: "delete_recurrence", category: "finance" },
  { key: "create_membership", category: "memberships" },
  { key: "update_membership", category: "memberships" },
  { key: "delete_membership", category: "memberships" },
  { key: "create_unit", category: "units" },
  { key: "update_unit", category: "units" },
  { key: "delete_unit", category: "units" },
  { key: "create_diet_template", category: "templates" },
  { key: "update_diet_template", category: "templates" },
  { key: "delete_diet_template", category: "templates" },
  { key: "create_document_template", category: "templates" },
  { key: "update_document_template", category: "templates" },
  { key: "create_person_document", category: "people" },
  { key: "waive_person_document", category: "people" },
  { key: "create_pendency", category: "people" },
  { key: "resolve_pendency", category: "people" },
  { key: "set_user_category", category: "admin" },
  { key: "update_account_language", category: "admin" },
  { key: "update_words", category: "admin" },
  { key: "update_assessment_photo_sides", category: "assessments" },
  { key: "create_idea", category: "support" },
  { key: "open_ticket", category: "support" },
];

const CATEGORIES = [
  { key: "auth" },
  { key: "people" },
  { key: "workouts" },
  { key: "diets" },
  { key: "anamnesis" },
  { key: "supplements" },
  { key: "exams" },
  { key: "prescriptions" },
  { key: "assessments" },
  { key: "schedule" },
  { key: "finance" },
  { key: "foods" },
  { key: "exercises" },
  { key: "admin" },

  // ── AS SETE QUE ENTRARAM COM O CATÁLOGO EM DIA (02/10/2026) ───────────
  //
  // Elas vieram junto com as cinquenta e sete ações que faltavam. Jogar tudo
  // em `admin` teria sido mais rápido e desfaria o filtro: separar é a razão
  // de a categoria existir, e "administração" com metade do sistema dentro
  // não separa nada.
  { key: "leads" },
  { key: "employees" },
  { key: "structure" },
  { key: "memberships" },
  { key: "units" },
  { key: "templates" },
  { key: "configuration" },
  { key: "support" },
];

// O que o alvo de uma ação é, para a coluna "Recurso". Só as chaves: o texto
// vem do i18n, em `targetTypes.*`.
const TARGET_TYPE_KEYS = [
  "permission_groups",
  "users",
  "people",
  "roles",
  "workouts",
  "workout_templates",
  "exercises",
  "diets",
  "anamnesis",
  "supplements",
  "exams",
  "prescriptions",
  "assessments",
  "appointments",
  "services",
  "availability",
  "charges",
  "payments",
  "payment_methods",
  "foods",
  "api_keys",
  "tenants",
  "mcp",

  // ── OS RECURSOS QUE FALTAVAM (02/10/2026) ──────────────────────────────
  //
  // *"recurso também, tem um monte em inglês"*. Mesma história das ações: o
  // código grava `target_type` que esta lista não conhece, e o filtro mostra
  // "memberships" e "payables" crus no meio de "Pagamento" e "Pessoa".
  "aulao",
  "booking_pages",
  "brand_images",
  "checkins",
  "custom_field_groups",
  "custom_fields",
  "departments",
  "diet_templates",
  "document_templates",
  "employee_records",
  "employees",
  "equipment_maintenances",
  "equipments",
  "group_classes",
  "idea_posts",
  "leads",
  "memberships",
  "payables",
  "pendencies",
  "person_documents",
  "recurrences",
  "suppliers",
  "supply_moves",
  "tickets",
  "units",
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
