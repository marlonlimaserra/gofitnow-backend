// THE permission catalog. Single source of truth: the roles screen builds its
// checkboxes from this, the seed builds the system roles from this, and every
// route checks a key that exists here.
//
// A key is "<area>.<action>" and NEVER changes once shipped — it is stored
// inside every role document, so renaming one would silently revoke access.
// To retire a permission, drop it here and remove it from the roles.
//
// Os textos NÃO estão aqui: `title`, `description`, `label` e `hint` vivem em
// lib/i18n/locales, sob `permissions.*`, e são montados por requisição em
// `localized(t)`. Guardar a frase em dois lugares seria garantir que os dois
// divergissem — aqui fica só a estrutura, que é o que nunca muda.
const GROUPS = [
  {
    key: "people",
    items: [
      { key: "people.view" },
      { key: "people.create" },
      { key: "people.edit" },
      { key: "people.delete" },
      { key: "people.access" },
    ],
  },
  {
    key: "workouts",
    items: [
      { key: "workouts.view", label: "Ver treinos", hint: "Abrir os treinos e as sessões." },
      { key: "workouts.manage" },
    ],
  },
  {
    key: "diets",
    items: [
      { key: "diets.view" },
      { key: "diets.manage" },
    ],
  },
  {
    key: "foods",
    items: [
      { key: "foods.view" },
      { key: "foods.manage" },
    ],
  },
  {
    key: "exercises",
    items: [
      { key: "exercises.view", label: "Ver o catálogo", hint: "Consultar exercícios e grupos." },
      { key: "exercises.manage" },
    ],
  },
  {
    key: "users",
    items: [
      { key: "users.view", label: "Ver usuários", hint: "Abrir o menu Usuários." },
      { key: "users.manage" },
    ],
  },
  {
    key: "logs",
    items: [
      { key: "logs.view" },
    ],
  },
  {
    key: "roles",
    items: [
      { key: "roles.view", label: "Ver tipos", hint: "Abrir o menu Tipos de usuário." },
      { key: "roles.manage" },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items.map((i) => i.key));

// Permissões que existiram e foram aposentadas. Ficam listadas aqui para o
// schema poder limpá-las dos tipos já salvos: uma chave órfã dentro de um
// papel não concede nada, mas aparece na contagem e confunde quem lê.
//
// Uma chave NUNCA é reaproveitada com outro significado — por isso a lista
// cresce em vez de sumir.
const RETIRED = [
  // A tela Clientes virou parte de Usuários: cadastrar profissional passou a
  // depender de users.manage.
  "clients.view",
  "clients.manage",
];

// Anything not on the list is dropped instead of stored: a typo in a request
// must not end up saved inside a role, where it would look like a real
// permission that simply never matches.
function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const wanted = new Set(list.map(String));
  return ALL.filter((key) => wanted.has(key));
}

function isValid(key) {
  return ALL.includes(String(key));
}

// O catálogo com os textos do idioma pedido, na forma que a tela espera.
// Montado a cada chamada de propósito: são 6 grupos e 14 itens, e guardar por
// idioma economizaria microssegundos ao custo de um cache para invalidar.
function localized(t) {
  return GROUPS.map((g) => ({
    key: g.key,
    title: t(`permissions.groups.${g.key}.title`),
    description: t(`permissions.groups.${g.key}.description`),
    items: g.items.map((i) => ({
      key: i.key,
      label: t(`permissions.items.${i.key}.label`),
      hint: t(`permissions.items.${i.key}.hint`),
    })),
  }));
}

module.exports = { GROUPS, ALL, RETIRED, sanitize, isValid, localized };
