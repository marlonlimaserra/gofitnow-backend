// As moedas em que um cliente pode trabalhar.
//
// A conta HABILITA um conjunto delas e escolhe uma como padrão; cada cobrança e
// cada pagamento guardam a sua. Quem vende para fora recebe em duas moedas, e
// obrigar a abrir outra conta para isso seria resolver o nosso problema, não o
// dele.
//
// A consequência é o SALDO: ele deixa de ser um número e passa a ser um por
// moeda. R$ 100 + US$ 100 não é 200 de coisa nenhuma, e somá-los daria um total
// que não existe. Por isso `balanceOf` devolve um mapa, e a tela mostra uma
// linha por moeda — o que também é o que um contador espera ver.
//
// A LISTA é fechada porque o código da moeda vira formatação na tela
// (`Intl.NumberFormat`) e um código inventado quebraria a formatação de todo
// valor da conta. Acrescentar uma moeda é acrescentar uma linha aqui.
const CURRENCIES = [
  { code: "BRL", symbol: "R$", locale: "pt-BR" },
  { code: "USD", symbol: "$", locale: "en-US" },
  { code: "EUR", symbol: "€", locale: "de-DE" },
  { code: "GBP", symbol: "£", locale: "en-GB" },
  { code: "ARS", symbol: "$", locale: "es-AR" },
  { code: "CLP", symbol: "$", locale: "es-CL" },
  { code: "COP", symbol: "$", locale: "es-CO" },
  { code: "MXN", symbol: "$", locale: "es-MX" },
  { code: "PYG", symbol: "₲", locale: "es-PY" },
  { code: "UYU", symbol: "$", locale: "es-UY" },
  { code: "CAD", symbol: "$", locale: "en-CA" },
  { code: "CHF", symbol: "CHF", locale: "de-CH" },
  { code: "AUD", symbol: "$", locale: "en-AU" },
  { code: "JPY", symbol: "¥", locale: "ja-JP" },
  { code: "AOA", symbol: "Kz", locale: "pt-AO" },
  { code: "MZN", symbol: "MT", locale: "pt-MZ" },
];

// O padrão do produto. O sistema nasceu aqui, e a conta que nunca abrir esta
// configuração é brasileira — e trabalha só com o real até dizer o contrário.
const DEFAULT_CURRENCY = "BRL";

const CODES = CURRENCIES.map((c) => c.code);

function isValid(code) {
  return CODES.includes(String(code || "").toUpperCase());
}

// O código gravável: o que veio, se existir; senão o padrão. Nunca vazio —
// um valor sem moeda não sabe se dizer.
function normalize(code) {
  const limpo = String(code || "").toUpperCase();
  return isValid(limpo) ? limpo : DEFAULT_CURRENCY;
}

function find(code) {
  return CURRENCIES.find((c) => c.code === normalize(code));
}

// O conjunto habilitado, limpo: só códigos que existem, sem repetição, e nunca
// vazio. Uma conta sem moeda nenhuma não conseguiria lançar nada.
function normalizeList(lista, padrao) {
  const validos = (Array.isArray(lista) ? lista : [])
    .map((c) => String(c || "").toUpperCase())
    .filter(isValid);

  const unicos = [...new Set(validos)];
  if (!unicos.length) return [normalize(padrao)];

  // A padrão sempre habilitada: ela é a que preenche todo formulário novo, e
  // uma padrão desabilitada deixaria a tela oferecendo o que não se aceita.
  const alvo = normalize(padrao);
  return unicos.includes(alvo) ? unicos : [alvo, ...unicos];
}

module.exports = {
  CURRENCIES,
  CODES,
  DEFAULT_CURRENCY,
  isValid,
  normalize,
  normalizeList,
  find,
};
