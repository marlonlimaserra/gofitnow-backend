// ── ESTE NÃO MORA NA PESSOA ──────────────────────────────────────────────
//
// *"faltou o status"* (10/10/2026). Ativo/inativo é do VÍNCULO entre o
// profissional e a pessoa — dois professores acompanhando o mesmo aluno podem
// discordar —, e o filtro básico o resolve ANTES do pipeline, escolhendo quais
// ids entram.
//
// Aqui isso não serve: dentro de um OU não dá para expressar "ativo OU tem
// foto" recortando ids. Então a condição pede que a JUNÇÃO com o vínculo suba
// antes do filtro — é o que `precisaDoVinculo` avisa ao modelo, e é a mesma
// coisa que ordenar por status já fazia.
//
// Custa caro (a junção é correlacionada por pessoa), e por isso só sobe quando
// alguém de fato filtra por status.
module.exports = {
  chave: "status",
  categoria: "acesso",
  icone: "CircleCheck",
  tipo: "opcao",
  campo: "active",
  opcoes: ["ativo", "inativo"],
  precisaDoVinculo: true,
  // O campo que a junção produz é 1/0, com 1 por padrão: vínculo sem `active`
  // gravado é ativo, como em todo o resto do sistema.
  montar: (v, op) => {
    const alvo = v === "ativo" ? 1 : 0;
    return op === "nao_e" ? { active: { $ne: alvo } } : { active: alvo };
  },
};
