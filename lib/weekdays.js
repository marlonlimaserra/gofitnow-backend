// Os dias da semana, para tudo que acontece em dias fixos: treino e plano
// alimentar.
//
// Guardados como chave em inglês, não como número nem como texto traduzido:
// número obrigaria a combinar com quem chama onde a semana começa (0 é domingo
// ou segunda?), e texto traduzido quebraria o dia ao trocar de idioma.
//
// Num arquivo só porque a ORDEM é a mesma coisa nos dois lugares. Duas cópias
// seriam duas verdades sobre qual dia vem primeiro, e um dia elas divergiriam.
const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// A ordem gravada é sempre a da semana e a lista não repete: quem manda
// ["friday","monday","friday"] recebe ["monday","friday"] de volta. Assim
// qualquer tela pode exibir na lata, sem ordenar de novo.
function weekdaysOf(value) {
  if (!Array.isArray(value)) return [];
  const pedidos = new Set(value.map((d) => String(d).trim().toLowerCase()));
  return WEEKDAYS.filter((d) => pedidos.has(d));
}

module.exports = { WEEKDAYS, weekdaysOf };
