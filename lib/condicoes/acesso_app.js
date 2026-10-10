module.exports = {
  chave: "acesso_app",
  categoria: "acesso",
  icone: "Smartphone",
  tipo: "booleano",
  // Acesso ao app NÃO é um campo: é ter senha E não estar bloqueado. Foi assim
  // que `hasAccess` sempre foi calculado (ver `User_model.filter`), e repetir a
  // regra aqui como "um campo" criaria uma segunda verdade.
  montar: (v) =>
    v
      ? { password: { $nin: [null, ""] }, appBloqueado: { $ne: true } }
      : { $or: [{ password: { $in: [null, ""] } }, { appBloqueado: true }] },
};
