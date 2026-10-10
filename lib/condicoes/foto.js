module.exports = {
  chave: "foto",
  categoria: "contato",
  icone: "Image",
  tipo: "booleano",
  montar: (v) => (v ? { avatarAt: { $ne: null } } : { avatarAt: null }),
};
