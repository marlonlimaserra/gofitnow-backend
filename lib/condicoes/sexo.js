// *"sexo seria masculino feminino e sem sexo"* (10/10/2026). Eu tinha
// inventado um `other` que não existe no cadastro: o formulário oferece dois, e
// desmarcar volta para vazio.
//
// "sem" não é um valor gravado — é a AUSÊNCIA, e ela tem TRÊS formas no banco:
// o campo vazio (quem desmarcou), o nulo, e o campo que não existe (fichas
// anteriores a ele). As três são a mesma resposta para quem pergunta, e um
// `{sex: ""}` pegaria só a primeira.
module.exports = {
  chave: "sexo",
  categoria: "contato",
  icone: "Users",
  tipo: "opcao",
  campo: "sex",
  opcoes: ["male", "female", "sem"],
  montar: (v, op) => {
    if (v === "sem") {
      return op === "nao_e" ? { sex: { $nin: [null, ""] } } : { sex: { $in: [null, ""] } };
    }
    return op === "nao_e" ? { sex: { $ne: v } } : { sex: v };
  },
};
