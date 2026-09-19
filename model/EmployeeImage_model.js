const { modeloDeImagens, MIMES, MAX_BYTES } = require("../lib/modeloDeImagens.js");

// A FOTO DE UM FUNCIONÁRIO.
//
// Collection própria pela mesma razão das outras: a coleta de lixo tem um dono
// da verdade só dela (a ficha salva), e compartilhar faria a gravação de um
// recurso apagar a foto de outro, calada.
//
// ── ELA NÃO É SERVIDA POR ROTA ABERTA ───────────────────────────────────
//
// A do fornecedor é: aquilo é a logo da Enel, a mesma que está no site dela.
// Esta é o ROSTO de uma pessoa empregada — dado pessoal, e uma URL aberta vaza
// num print, num histórico de navegador ou num log de proxy. A leitura é por
// `/employee-photo/:id`, com sessão. Ver `controllers/Employee.js`.
const EmployeeImage_model = modeloDeImagens({
  collection: "employee_images",
  dono: "employee",
  prefixo: "funcionarios",
});

module.exports = EmployeeImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
