// COMPARAR DOIS TELEFONES QUE FORAM DIGITADOS POR PESSOAS DIFERENTES.
//
// ── O problema ────────────────────────────────────────────────────────────
//
// O telefone é gravado como foi digitado (`String(obj.phone).trim()`), então a
// mesma pessoa existe no banco como "(11) 98765-0001", "11987650001" e
// "+55 11 98765-0001". Nenhum é errado; todos são o mesmo número.
//
// Isto nasceu para a inscrição pelo WhatsApp na página pública do aulão: quem
// chega digita o número, e o sistema precisa saber se essa pessoa JÁ é aluna do
// estúdio. Comparação exata falha quase sempre — e falhar aqui não dá erro:
// cria um aluno duplicado, com o histórico do original partido em dois.
//
// ── A REGRA, E PARA QUE LADO ELA ERRA ─────────────────────────────────────
//
// Só os dígitos; fora o código do país (55) e zeros à esquerda (o "0" do DDD
// discado). O que sobra tem de ser IGUAL.
//
//   "+55 (11) 98765-0001" ─┐
//   "011987650001"         ├─→ 11987650001   casam
//   "11987650001"         ─┘
//
//   "98765-0001"           →     987650001   NÃO casa com as de cima
//
// A última é a decisão: um número sem DDD não casa com um que tem. Poderia —
// bastaria comparar os últimos nove dígitos — e aí "98765-0001" de São Paulo
// casaria com "98765-0001" de Belém. Inscrever a pessoa ERRADA num aulão é pior
// que pedir o nome de novo: o duplicado é chato e se resolve; o outro põe o
// aluno de alguém numa aula que ele não pediu, com cobrança.
//
// Então erra para o lado de PERGUNTAR. Ver `mesmoTelefone`.
//
// ── Por que não um campo normalizado no banco ─────────────────────────────
//
// Seria melhor: um `phoneSort`, como o `nameSort` que já existe, com índice. Mas
// exigiria tocar em todo caminho que grava telefone (cadastro, edição, convite,
// importação, portal) e uma migração das bases atuais.
//
// A comparação em memória serve hoje porque as coleções são pequenas: a maior
// instância tem 217 pessoas, e ler `{_id, phone}` de todas custa menos que um
// documento de treino. Quando alguma passar de alguns milhares, isto vira
// varredura por requisição numa rota PÚBLICA — e aí o campo com índice deixa de
// ser luxo. Está escrito aqui para não se descobrir por lentidão.

// O código do país, quando escrito. Só o do Brasil: aceitar qualquer prefixo de
// um a três dígitos como "país" transformaria um número de onze dígitos em
// oito, e aí números diferentes passariam a casar.
const PAIS = "55";

// Celular brasileiro com DDD tem 11 dígitos; fixo tem 10. Menos que isso é
// número sem DDD, e é o caso que esta regra deixa de propósito sem casar.
const COM_DDD = 10;

function digitos(valor) {
  return String(valor ?? "").replace(/\D+/g, "");
}

// A forma comparável de um telefone, ou "" quando não há número nenhum.
function chave(valor) {
  let d = digitos(valor);
  if (!d) return "";

  // Zeros à esquerda: o "0" que se disca antes do DDD, e o "00" de chamada
  // internacional.
  d = d.replace(/^0+/, "");

  // O 55 sai apenas quando o que sobra ainda tem DDD. Sem esta condição,
  // "5598765000" (um fixo de Maranhão com DDD 55) perderia o próprio DDD e
  // viraria outro número.
  if (d.startsWith(PAIS) && d.length - PAIS.length >= COM_DDD) {
    d = d.slice(PAIS.length);
  }

  return d;
}

// Os dois são o mesmo número?
//
// Vazio nunca casa com nada — nem com outro vazio. Duas fichas sem telefone não
// são a mesma pessoa, e tratá-las como iguais faria a primeira inscrição sem
// número adotar qualquer ficha vazia que existisse no banco.
function mesmoTelefone(a, b) {
  const x = chave(a);
  const y = chave(b);
  if (!x || !y) return false;
  return x === y;
}

module.exports = { digitos, chave, mesmoTelefone, COM_DDD };
