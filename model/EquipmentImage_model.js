const { modeloDeImagens, MIMES, MAX_BYTES } = require("../lib/modeloDeImagens.js");

// A FOTO DE UM EQUIPAMENTO — *"permita colocar foto do equipamento"*.
//
// Ela não é enfeite. Duas esteiras do mesmo modelo só se distinguem pelo número
// de série, que está numa etiqueta atrás; a foto é o que faz quem abre a lista
// saber DE QUAL aparelho a ficha fala. E quando o técnico pergunta ao telefone
// "qual é o modelo?", a foto responde mais rápido que o cadastro.
//
// Collection própria, pela mesma razão das outras quatro: a coleta de lixo tem
// um dono da verdade só dela — o equipamento salvo —, e compartilhar faria a
// gravação de um recurso apagar a foto de outro, calada.
const EquipmentImage_model = modeloDeImagens({
  collection: "equipment_images",
  dono: "equipment",
  prefixo: "equipamentos",
});

module.exports = EquipmentImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
