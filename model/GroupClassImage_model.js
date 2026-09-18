const { modeloDeImagens, MIMES, MAX_BYTES } = require("../lib/modeloDeImagens.js");

// A CAPA DE UMA AULA COLETIVA — a foto do cartão na grade.
//
// *"faltou poder por a foto de capa, quero que seja card igual o aula"*.
//
// Collection própria pela mesma razão que separou as outras quatro: a coleta de
// lixo tem um dono da verdade só dela (a aula salva), e compartilhar faria a
// gravação de um recurso apagar a foto de outro, calada.
//
// O CÓDIGO é compartilhado — `lib/modeloDeImagens.js`, a fábrica que nasceu
// quando a unidade seria a quarta cópia. Esta é a primeira vez que ela se
// paga: um arquivo de dezoito linhas em vez de cento e cinquenta.
const GroupClassImage_model = modeloDeImagens({
  collection: "group_class_images",
  dono: "groupClass",
  prefixo: "aulas",
});

module.exports = GroupClassImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
