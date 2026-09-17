// A RECORRÊNCIA — "todo mês, R$ 800" — e as datas que ela produz.
//
// Pedido do Marlon em 17/09/2026: *"quero uma forma de poder cadastrar uma
// recorrência no aluno, exemplo todo mês eu pago 800 reais pra minha personal.
// Mas na academia eu pago anual... é o sistema geraria essa cobrança"*.
//
// ── ESTE ARQUIVO NÃO FALA COM O BANCO ────────────────────────────────────
//
// Ele é só a conta: dada uma data de início, uma cadência e até quando, quais
// vencimentos existem. É onde mora o risco de verdade desta funcionalidade —
// aritmética de mês —, e separado assim ele se testa sem Mongo nenhum.

// ── O CATÁLOGO VIVE AQUI, E A TELA NÃO O CONHECE ─────────────────────────
//
// Mesma decisão dos status de cobrança (`lib/statusDeCobranca.js`), e pelo
// mesmo pedido: *"coloque esse status, em uma variavel no backend, [{},{}]
// assim, se agente adicionar um status novo, a chamada ja traz, e não precisa
// mexer em anda do frontend"*.
//
// Acrescentar "quadrimestral" é uma linha aqui. O seletor da tela ganha a opção
// sozinho, a tradução entra no catálogo do site, e nenhum arquivo do frontend
// muda.
//
// ── DUAS UNIDADES, e não sete regras ─────────────────────────────────────
//
// Toda cadência é `unidade × passo`. Trimestral não é um caso especial: é mês
// vezes três. Sem isso, cada nome novo seria um ramo novo na conta das datas —
// e a conta das datas é justamente onde se erra.
const CADENCIAS = [
  { id: "weekly", unidade: "semana", passo: 1, rotulo: "finance.every.weekly" },
  { id: "biweekly", unidade: "semana", passo: 2, rotulo: "finance.every.biweekly" },
  { id: "monthly", unidade: "mes", passo: 1, rotulo: "finance.every.monthly" },
  { id: "bimonthly", unidade: "mes", passo: 2, rotulo: "finance.every.bimonthly" },
  { id: "quarterly", unidade: "mes", passo: 3, rotulo: "finance.every.quarterly" },
  { id: "semiannual", unidade: "mes", passo: 6, rotulo: "finance.every.semiannual" },
  { id: "annual", unidade: "mes", passo: 12, rotulo: "finance.every.annual" },
];

const IDS = CADENCIAS.map((c) => c.id);
const PADRAO = "monthly";

function existe(id) {
  return IDS.includes(String(id || ""));
}

function normalizar(id) {
  return existe(id) ? String(id) : PADRAO;
}

function cadenciaDe(id) {
  return CADENCIAS.find((c) => c.id === normalizar(id));
}

// O catálogo como a tela o recebe: id, rótulo traduzido e a descrição da conta.
// `t` é o tradutor da requisição — o mesmo caminho do `statusDeCobranca.paraTela`.
function paraTela(t) {
  return CADENCIAS.map((c) => ({
    id: c.id,
    label: t ? t(c.rotulo) : c.rotulo,
    unidade: c.unidade,
    passo: c.passo,
  }));
}

// ── O DIA PURO ───────────────────────────────────────────────────────────
//
// Vencimento é DIA, não instante — é assim que `dueDate` já é gravado em toda
// cobrança deste sistema (meia-noite UTC). Tudo aqui trabalha em UTC de
// propósito: uma conta feita no fuso local faria a mesma recorrência produzir
// 05/10 para quem roda em São Paulo e 04/10 para quem roda no servidor.
function diaUTC(valor) {
  // ── VAZIO É RECUSADO ANTES DE VIRAR `Date` ─────────────────────────────
  //
  // `new Date(null)` não é data inválida: é 01/01/1970. Sem esta linha, uma
  // recorrência sem data de início — gravada antes deste campo existir, ou
  // editada direto no banco — geraria as 24 primeiras mensalidades de 1970 na
  // primeira vez que alguém abrisse o financeiro. O teste pegou.
  //
  // `false` e `""` caem aqui pelo mesmo motivo; ambos viram a época.
  if (valor === null || valor === undefined || valor === "" || typeof valor === "boolean") {
    return null;
  }

  const d = valor instanceof Date ? new Date(valor.getTime()) : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Quantos dias tem aquele mês. `Date.UTC(ano, mes + 1, 0)` é o dia zero do mês
// seguinte, que é o último do mês pedido.
function diasNoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
}

// ── A K-ÉSIMA OCORRÊNCIA, CONTADA SEMPRE DO INÍCIO ───────────────────────
//
// E o "sempre do início" é a regra que impede o defeito clássico desta conta.
//
// Somar um mês à ocorrência ANTERIOR faz a data ANDAR PARA TRÁS e nunca mais
// voltar: uma mensalidade que vence dia 31 viraria 31/01 → 28/02 (fevereiro não
// tem 31) → 28/03 → 28/04. Quem contratou "todo dia 31" passa a ser cobrado dia
// 28 para o resto da vida, e ninguém entende por quê.
//
// Contando do início, fevereiro é um desvio de um mês só: 31/01 → 28/02 →
// 31/03 → 30/04. O dia volta assim que o mês comporta.
function ocorrencia(inicio, cadenciaId, k) {
  const base = diaUTC(inicio);
  if (!base) return null;

  const { unidade, passo } = cadenciaDe(cadenciaId);

  if (unidade === "semana") {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + 7 * passo * k);
    return d;
  }

  const total = base.getUTCMonth() + passo * k;
  const ano = base.getUTCFullYear() + Math.floor(total / 12);
  // `%` em JavaScript devolve negativo para entrada negativa, e `k` pode ser
  // zero mas o mês base não pode virar -1. `((x % 12) + 12) % 12` é o resto que
  // se quer aqui.
  const mes = ((total % 12) + 12) % 12;

  // O dia CEDE ao mês, e só a ele: 31 em fevereiro vira 28 (ou 29), e o mês
  // seguinte volta a 31. Deixar o `Date` transbordar sozinho daria 03/03, que é
  // uma cobrança num mês que não é o dela.
  const dia = Math.min(base.getUTCDate(), diasNoMes(ano, mes));

  return new Date(Date.UTC(ano, mes, dia));
}

// A ETIQUETA de uma ocorrência: o vencimento em ISO, e é ela que torna a geração
// IDEMPOTENTE.
//
// Guardada na cobrança junto do id da recorrência, com índice único sobre o par.
// É o que faz duas requisições simultâneas — duas abas abertas, dois workers —
// não criarem a mesma mensalidade duas vezes: a segunda inserção bate no índice
// e é descartada pelo banco, não por um `if` que corre risco de perder a corrida.
//
// O vencimento, e não o número da ocorrência: mudar a cadência de uma
// recorrência renumeraria todas as ocorrências, e o que já foi gerado nasceria
// de novo com outro número.
function etiqueta(data) {
  const d = diaUTC(data);
  return d ? d.toISOString().slice(0, 10) : "";
}

// ── QUANTO NA FRENTE SE GERA ─────────────────────────────────────────────
//
// Uma recorrência é infinita; a geração não pode ser. O corte é o VENCIMENTO:
// só nasce a cobrança que vence até hoje + 15 dias.
//
// Quinze dias porque é o que faz a mensalidade aparecer em "a receber" antes de
// vencer — que é o ponto de ter a lista — sem encher a tela com o ano inteiro.
// Numa recorrência anual, ela aparece duas semanas antes e não passa doze meses
// pendurada no total.
const ANTECEDENCIA_DIAS = 15;

// E o teto de quantas nascem por passada.
//
// Uma recorrência mensal cadastrada com início em 2020 tem setenta ocorrências
// atrasadas. Gerar as setenta de uma vez numa abertura de tela é uma surpresa
// cara e difícil de desfazer — e quase sempre é engano de digitação, não
// intenção. O teto para em 24 e a próxima passada continua de onde parou: quem
// realmente quis doze meses atrás os recebe, só que em duas leituras.
const TETO_POR_PASSADA = 24;

// ── AS OCORRÊNCIAS QUE AINDA FALTAM ──────────────────────────────────────
//
// `jaGeradas` é o conjunto de etiquetas que já viraram cobrança. Passá-lo é o
// que permite chamar isto a cada leitura da tela sem produzir nada de novo
// quando não há nada de novo — o índice único é a rede, não o plano.
function pendentes({
  inicio,
  fim = null,
  cadencia = PADRAO,
  hoje = new Date(),
  jaGeradas = new Set(),
  teto = TETO_POR_PASSADA,
  antecedencia = ANTECEDENCIA_DIAS,
}) {
  const base = diaUTC(inicio);
  if (!base) return [];

  const limite = diaUTC(hoje);
  if (!limite) return [];
  limite.setUTCDate(limite.getUTCDate() + antecedencia);

  const ultimo = fim ? diaUTC(fim) : null;

  const saida = [];

  // Sem `while (true)`: o corte é o limite de data, mas uma cadência semanal com
  // início muito antigo daria milhares de voltas antes de passar do teto de
  // quantidade. O contador de voltas é a trava de segurança — ele nunca é o que
  // decide, exceto quando algo saiu do esperado.
  const MAX_VOLTAS = 5000;

  for (let k = 0; k < MAX_VOLTAS; k++) {
    const data = ocorrencia(base, cadencia, k);
    if (!data) break;
    if (data > limite) break;
    if (ultimo && data > ultimo) break;

    const tag = etiqueta(data);
    if (!jaGeradas.has(tag)) saida.push({ data, etiqueta: tag });

    if (saida.length >= teto) break;
  }

  return saida;
}

module.exports = {
  CADENCIAS,
  IDS,
  PADRAO,
  ANTECEDENCIA_DIAS,
  TETO_POR_PASSADA,
  existe,
  normalizar,
  cadenciaDe,
  paraTela,
  ocorrencia,
  etiqueta,
  pendentes,
  diaUTC,
};
