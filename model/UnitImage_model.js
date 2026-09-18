const { modeloDeImagens, MIMES, MAX_BYTES } = require("../lib/modeloDeImagens.js");

// A FOTO DE UMA UNIDADE — a fachada, a sala, o que a pessoa vai reconhecer
// quando chegar.
//
// Collection própria pela mesma razão que separou as outras três: a coleta de
// lixo tem um dono da verdade só dela (a unidade salva), e compartilhar faria
// a gravação de um recurso apagar a foto de outro, calada.
//
// O CÓDIGO, esse é compartilhado — ver `lib/modeloDeImagens.js`. Esta seria a
// quarta cópia do mesmo arquivo, e quatro é o número em que se para de copiar.
const UnitImage_model = modeloDeImagens({
  collection: "unit_images",
  dono: "unit",
  prefixo: "unidades",
});

module.exports = UnitImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
