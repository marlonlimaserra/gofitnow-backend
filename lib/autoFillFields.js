// Os campos que aceitam "auto preencher": aqueles onde o profissional digita
// as mesmas coisas o tempo todo.
//
// A CHAVE fica gravada em cada valor salvo e nunca muda — renomear uma
// esconderia tudo que já foi guardado para aquele campo. O rótulo é só
// apresentação.
//
// Para oferecer um campo novo, basta acrescentar aqui: a tela do perfil se
// monta a partir desta lista, e o formulário pede pela chave.
const FIELDS = [
  {
    key: "workout.name",
    label: "Nome do treino",
    hint: "Ex.: Hipertrofia 4 semanas",
    group: "Treino",
  },
  {
    key: "workout.goal",
    label: "Objetivo do treino",
    hint: "Ex.: Ganho de massa muscular",
    group: "Treino",
  },
  {
    key: "workout.tip",
    label: "Dica do treino",
    hint: "O que você costuma orientar",
    group: "Treino",
    multiline: true,
  },
  {
    key: "workout.calories",
    label: "Gasto calórico do treino",
    hint: "Ex.: 400",
    group: "Treino",
  },
  {
    key: "workout.totalSessions",
    label: "Total de sessões do treino",
    hint: "Ex.: 12",
    group: "Treino",
  },
  {
    key: "session.name",
    label: "Nome da sessão",
    hint: "Ex.: Treino A — Peito e tríceps",
    group: "Treino",
  },
  {
    key: "person.goal",
    label: "Objetivo da ficha",
    hint: "Ex.: Emagrecimento",
    group: "Pessoas",
  },
];

const KEYS = FIELDS.map((f) => f.key);

function isValid(key) {
  return KEYS.includes(String(key));
}

module.exports = { FIELDS, KEYS, isValid };
