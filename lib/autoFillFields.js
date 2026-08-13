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
  { key: "workout.name", group: "workout" },
  { key: "workout.goal", group: "workout" },
  { key: "workout.tip", group: "workout", multiline: true },
  { key: "workout.calories", group: "workout" },
  { key: "workout.totalSessions", group: "workout" },
  { key: "session.name", group: "workout" },
  { key: "diet.name", group: "diet" },
  { key: "diet.goal", group: "diet" },
  { key: "person.goal", group: "people" },
];

const KEYS = FIELDS.map((f) => f.key);

function isValid(key) {
  return KEYS.includes(String(key));
}

// O catálogo com os textos do idioma pedido. `group` sai como TEXTO aqui — a
// tela agrupa os campos por ele — enquanto no FIELDS acima é a chave.
function localized(t) {
  return FIELDS.map((f) => ({
    ...f,
    label: t(`autoFill.fields.${f.key}.label`),
    hint: t(`autoFill.fields.${f.key}.hint`),
    group: t(`autoFill.groups.${f.group}`),
  }));
}

module.exports = { FIELDS, KEYS, isValid, localized };
