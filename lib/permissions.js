// THE permission catalog. Single source of truth: the roles screen builds its
// checkboxes from this, the seed builds the system roles from this, and every
// route checks a key that exists here.
//
// A key is "<area>.<action>" and NEVER changes once shipped — it is stored
// inside every role document, so renaming one would silently revoke access.
// To retire a permission, drop it here and remove it from the roles.
//
// `label` and `hint` are what the admin reads on screen, so they are
// Portuguese; everything else follows the project's English convention.
const GROUPS = [
  {
    key: "people",
    title: "Pessoas",
    description: "Quem o profissional acompanha",
    items: [
      {
        key: "people.view",
        label: "Ver pessoas",
        hint: "Abrir a lista e a ficha de quem já está vinculado.",
      },
      {
        key: "people.create",
        label: "Adicionar pessoa",
        hint: "Cadastrar uma nova ficha e pedir acesso a quem já tem conta.",
      },
      {
        key: "people.edit",
        label: "Editar ficha",
        hint: "Alterar dados, medidas e observações.",
      },
      {
        key: "people.delete",
        label: "Remover da lista",
        hint: "Desfazer o vínculo. A pessoa continua existindo se outro profissional a acompanhar.",
      },
      {
        key: "people.access",
        label: "Gerenciar o acesso da pessoa",
        hint: "Definir ou tirar a senha de quem foi cadastrado por você.",
      },
    ],
  },
  {
    key: "workouts",
    title: "Treinos",
    description: "Planos e sessões de treino",
    items: [
      { key: "workouts.view", label: "Ver treinos", hint: "Abrir os treinos e as sessões." },
      {
        key: "workouts.manage",
        label: "Montar treinos",
        hint: "Criar, editar, duplicar e excluir treinos, sessões e exercícios da sessão.",
      },
    ],
  },
  {
    key: "exercises",
    title: "Exercícios",
    description: "O catálogo de exercícios do profissional",
    items: [
      { key: "exercises.view", label: "Ver o catálogo", hint: "Consultar exercícios e grupos." },
      {
        key: "exercises.manage",
        label: "Editar o catálogo",
        hint: "Criar, alterar e excluir exercícios.",
      },
    ],
  },
  {
    key: "clients",
    title: "Clientes",
    description: "Os profissionais da plataforma",
    items: [
      { key: "clients.view", label: "Ver clientes", hint: "Abrir o menu Clientes." },
      {
        key: "clients.manage",
        label: "Gerenciar clientes",
        hint: "Cadastrar, editar e excluir profissionais.",
      },
    ],
  },
  {
    key: "users",
    title: "Usuários",
    description: "Todas as contas da plataforma",
    items: [
      { key: "users.view", label: "Ver usuários", hint: "Abrir o menu Usuários." },
      {
        key: "users.manage",
        label: "Gerenciar usuários",
        hint: "Editar, desativar e excluir qualquer conta.",
      },
    ],
  },
  {
    key: "logs",
    title: "Histórico",
    description: "O registro de tudo que foi feito na plataforma",
    items: [
      {
        key: "logs.view",
        label: "Ver o histórico",
        hint: "Consultar quem fez o quê, quando e de qual endereço.",
      },
    ],
  },
  {
    key: "roles",
    title: "Tipos de usuário",
    description: "Os próprios tipos e o que cada um pode",
    items: [
      { key: "roles.view", label: "Ver tipos", hint: "Abrir o menu Tipos de usuário." },
      {
        key: "roles.manage",
        label: "Gerenciar tipos",
        hint: "Criar tipos e mudar as permissões de cada um. Quem tem isso pode dar qualquer poder a si mesmo.",
      },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items.map((i) => i.key));

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

module.exports = { GROUPS, ALL, sanitize, isValid };
