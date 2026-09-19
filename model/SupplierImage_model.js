const { modeloDeImagens, MIMES, MAX_BYTES } = require("../lib/modeloDeImagens.js");

// A FOTO DE UM FORNECEDOR — a logo da distribuidora, a fachada da loja, o
// rosto do professor terceirizado.
//
// Collection própria pela mesma razão das outras: a coleta de lixo tem um dono
// da verdade só dela (o fornecedor salvo), e compartilhar faria a gravação de
// um recurso apagar a foto de outro, calada.
const SupplierImage_model = modeloDeImagens({
  collection: "supplier_images",
  dono: "supplier",
  prefixo: "fornecedores",
});

module.exports = SupplierImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
