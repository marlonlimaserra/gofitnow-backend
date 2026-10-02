// NOME E SOBRENOME — e por que `name` continua existindo.
//
// *"acho melhor agente trabalhar com 'nome' e 'sobrenome'"* (01/10/2026).
//
// ── A FORMA DA MUDANÇA É O QUE IMPORTA ───────────────────────────────────
//
// `name` é lido em **440 lugares** só no backend: PDF de avaliação, corpo de
// e-mail, exportação para planilha, app do aluno, busca, ordenação, cartão de
// aulão, lista de presença. Trocar o campo por dois seria reescrever os 440 —
// e o primeiro esquecido vira uma folha impressa com o nome em branco.
//
// Então a divisão acontece na ENTRADA, e `name` passa a ser **derivado**:
//
//   firstName + lastName  →  name     (gravados juntos, sempre)
//
// Quem escreve preenche dois campos; quem lê continua lendo um. Nenhum dos 440
// soube que algo mudou.
//
// ── O CONTRÁRIO TAMBÉM PRECISA EXISTIR ──────────────────────────────────
//
// Há 223 fichas gravadas com `name` e nada mais, e há entradas que continuam
// chegando com o nome inteiro numa linha só — a importação por planilha, a
// inscrição pela página pública, o cadastro pelo app antigo. `separar` é o que
// atende esses casos: primeira palavra é o nome, o RESTO é o sobrenome.
//
// "O resto", e não "a última palavra": "Marlon Lima Serra" tem sobrenome "Lima
// Serra", e quem se chama "Ana Beatriz Costa Lima" não perde duas palavras no
// caminho. A heurística erra em nome composto ("Ana Beatriz" vira nome "Ana"),
// e isso é aceitável porque **é editável**: a pessoa abre a ficha e arruma. O
// que não poderia acontecer é a heurística PERDER informação, e ela não perde —
// `name` continua gravado inteiro, do jeito que estava.
//
// ── ESPAÇO NO MEIO ─────────────────────────────────────────────────────
//
// `montar` junta com um espaço e apara: sobrenome vazio não pode virar
// "Marlon " com espaço pendurado, porque esse espaço entra no `nameSort`, na
// ordenação da lista e no nome do arquivo de um PDF.

// "Marlon" + "Lima Serra" → "Marlon Lima Serra"
function montar(firstName, lastName) {
  return [String(firstName || "").trim(), String(lastName || "").trim()]
    .filter(Boolean)
    .join(" ");
}

// "Marlon Lima Serra" → { firstName: "Marlon", lastName: "Lima Serra" }
function separar(name) {
  // Espaços repetidos viram um só: um nome colado de duas colunas de planilha
  // chega com dois, e o sobrenome sairia começando com espaço.
  const limpo = String(name || "").trim().replace(/\s+/g, " ");
  if (!limpo) return { firstName: "", lastName: "" };

  const corte = limpo.indexOf(" ");
  if (corte === -1) return { firstName: limpo, lastName: "" };

  return { firstName: limpo.slice(0, corte), lastName: limpo.slice(corte + 1) };
}

// O QUE GRAVAR, a partir do que a tela mandou.
//
// Aceita as duas formas e devolve sempre as três chaves, porque o documento
// precisa das três coerentes entre si:
//
//   • veio `firstName`/`lastName` → `name` é montado
//   • veio só `name`              → as partes são separadas
//
// Devolve `null` quando não há nome nenhum a gravar, para quem chama poder
// distinguir "não mandou" de "mandou vazio" — são coisas diferentes num PATCH.
// ── `anterior` NÃO É DETALHE: SEM ELE, EDITAR UMA PARTE APAGA A OUTRA ───
//
// Descoberto editando de verdade em produção, não em teste: um `PUT` com só
// `{ lastName: "Costa Lima" }` — que é o caminho mais comum, arrumar o
// sobrenome — devolvia `name: "Costa Lima"` e `firstName: ""`. A pessoa perdia
// o próprio nome ao corrigir o sobrenome.
//
// A causa é que "veio uma parte" não é o mesmo que "vieram as duas". O que não
// veio tem de ser lido do que JÁ ESTÁ GRAVADO — e, para as fichas que ainda não
// passaram pela migração, do `name` antigo.
function paraGravar(obj = {}, anterior = {}) {
  const temPartes = obj.firstName !== undefined || obj.lastName !== undefined;

  if (temPartes) {
    // De onde sai o que não veio: o campo gravado, ou — na ficha antiga que
    // ainda não tem as partes — o nome inteiro, separado na hora.
    const base = separar(anterior.name);
    const antesFirst = anterior.firstName !== undefined ? anterior.firstName : base.firstName;
    const antesLast = anterior.lastName !== undefined ? anterior.lastName : base.lastName;

    const firstName = String(
      obj.firstName !== undefined ? obj.firstName : antesFirst || ""
    ).trim();
    const lastName = String(obj.lastName !== undefined ? obj.lastName : antesLast || "").trim();

    return { firstName, lastName, name: montar(firstName, lastName) };
  }

  if (obj.name !== undefined) {
    const name = String(obj.name || "").trim().replace(/\s+/g, " ");
    return { ...separar(name), name };
  }

  return null;
}

module.exports = { montar, separar, paraGravar };
