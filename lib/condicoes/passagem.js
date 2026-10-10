module.exports = {
  chave: "passagem",
  categoria: "acesso",
  icone: "DoorOpen",
  tipo: "booleano",
  // `!== false`: quem foi cadastrado antes do campo existir não o tem, e essas
  // pessoas passam. Ler ausência como "bloqueado" acusaria a academia inteira
  // no dia do deploy.
  montar: (v) => (v ? { passagemLiberada: { $ne: false } } : { passagemLiberada: false }),
};
