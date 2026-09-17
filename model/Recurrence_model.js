const { ObjectId } = require("mongodb");
const recorrencia = require("../lib/recorrencia.js");

// AS RECORRÊNCIAS DE UMA PESSOA — a mensalidade, a anuidade, o pacote trimestral.
//
//   { student, description, amount, currency, cadencia, startsAt, endsAt, active }
//
// Pedido do Marlon: *"todo mês eu pago 800 reais pra minha personal. Mas na
// academia eu pago anual"*.
//
// ── A RECORRÊNCIA NÃO É UMA COBRANÇA. Ela é a REGRA ──────────────────────
//
// O que a pessoa deve continua sendo a cobrança, com o vencimento dela, o
// pagamento dela e o status dela. A recorrência só diz "de novo, todo mês" — e
// some da conta: ela não entra em nenhum total, porque uma regra infinita somaria
// dinheiro infinito.
//
// Isso é o que permite editar o combinado sem mexer no passado. Subir a
// mensalidade de 800 para 900 muda as PRÓXIMAS; as doze que já foram cobradas
// continuam valendo 800, que é o que de fato aconteceu.
//
// ── QUANDO A COBRANÇA NASCE ──────────────────────────────────────────────
//
// Na LEITURA da tela do dinheiro — a aba da pessoa e o Financeiro geral —, e não
// num agendador.
//
// Este servidor não tem agendador nenhum, e montar um para isto custaria o que
// ele não paga: eleição de líder entre os workers (senão dois geram a mesma
// mensalidade), varredura de todas as instâncias fora do contexto assíncrono que
// garante o isolamento (`lib/escopo.js`), e um processo a mais para vigiar. A
// geração preguiçosa não precisa de nada disso: ela roda DENTRO da requisição,
// já escopada no cliente certo, e só para quem está olhando.
//
// O que se abre mão: a cobrança não existe até alguém abrir o financeiro. Na
// prática quem abre o financeiro é justamente quem age sobre ela — e a leitura
// que a criaria é a mesma que a mostraria. Se um dia existir aviso automático de
// vencimento, aí sim entra um agendador, e ele chamará ESTE método.
//
// ── E A GERAÇÃO É IDEMPOTENTE POR ÍNDICE, não por `if` ───────────────────
//
// Cada cobrança gerada leva `recurrence` e `periodo` (o vencimento em ISO), com
// índice ÚNICO sobre o par. Duas abas abertas ao mesmo tempo disputam a mesma
// inserção e o banco recusa a segunda — a checagem antes é economia, não
// garantia. Um `if` sozinho perderia a corrida, e o estrago seria a pessoa
// cobrada duas vezes pelo mesmo mês.
function Recurrence_model(app) {
  this.app = app;
}

Recurrence_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("recurrences");
};

const centavos = (v) => Math.max(0, Math.round(Number(v) || 0));

// O dia puro, como o vencimento de toda cobrança deste sistema: meia-noite UTC.
// Sem isto, uma recorrência cadastrada às 21h em São Paulo começaria no dia
// seguinte.
function dia(valor, padrao = null) {
  const d = recorrencia.diaUTC(valor);
  return d || padrao;
}

// ── O QUE SE PODE GRAVAR ─────────────────────────────────────────────────
//
// Tabela de campo → limpeza, e não um objeto montado inteiro. É a lição que
// `updateCharge` custou caro: montar o documento completo a cada escrita
// transforma um PUT parcial em apagamento silencioso — cinco cobranças reais
// perderam valor e vencimento assim em 17/09/2026.
const CAMPOS = {
  description: (v) => String(v || "").trim().slice(0, 200),
  amount: (v) => centavos(v),
  cadencia: (v) => recorrencia.normalizar(v),
  startsAt: (v) => dia(v, new Date()),
  // `endsAt` VAZIO é "para sempre", e precisa ser gravável: tirar a data de fim
  // de uma recorrência que tinha uma é uma edição legítima. Por isso `null`
  // explícito em vez de "campo ausente".
  endsAt: (v) => (v ? dia(v) : null),
  active: (v) => v !== false,
};

Recurrence_model.prototype.insert = async function (studentId, obj, createdBy, currency) {
  const col = await this.collection();

  const doc = {
    student: new ObjectId(studentId),
    currency: currency || null,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  for (const [campo, limpar] of Object.entries(CAMPOS)) doc[campo] = limpar(obj[campo]);

  const r = await col.insertOne(doc);
  return r.insertedId;
};

Recurrence_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  return r.matchedCount > 0;
};

Recurrence_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

Recurrence_model.prototype.listOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.collection();
  return col.find({ student: new ObjectId(studentId) }).sort({ createdAt: -1 }).toArray();
};

// ── APAGAR A REGRA NÃO APAGA O QUE JÁ FOI COBRADO ────────────────────────
//
// As cobranças geradas ficam. Elas têm pagamento, comprovante e histórico — são
// dinheiro que aconteceu, e a regra que as criou é só a explicação de por que
// nasceram. Apagar o passado junto com o combinado seria apagar o caixa.
//
// Quem quer só parar de gerar não apaga: desativa (`active: false`). O botão de
// apagar existe para o cadastro errado, feito e desfeito no mesmo minuto.
Recurrence_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

Recurrence_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;
  const col = await this.collection();
  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount;
};

// ── A GERAÇÃO ────────────────────────────────────────────────────────────
//
// `gerar({ student })` para a aba de uma pessoa; `gerar({})` para o Financeiro
// geral, que olha a conta inteira.
//
// Devolve quantas nasceram. Nunca estoura: ela é chamada no caminho de LEITURA
// de duas telas, e uma recorrência com data estranha não pode derrubar o
// financeiro de ninguém. Falha aqui vira linha de log — a próxima leitura tenta
// de novo, porque tudo aqui é idempotente.
Recurrence_model.prototype.gerar = async function ({ student = null, hoje = new Date() } = {}) {
  try {
    const col = await this.collection();

    const filtro = { active: true };
    if (student) {
      if (!ObjectId.isValid(student)) return 0;
      filtro.student = new ObjectId(student);
    }

    const regras = await col.find(filtro).toArray();
    if (!regras.length) return 0;

    const cobrancas = await this.app.api.finance.charges();

    // O QUE JÁ EXISTE, numa consulta só — e não uma por regra. Dez recorrências
    // numa conta fariam dez idas ao banco em toda abertura da tela do dinheiro.
    const geradas = await cobrancas
      .find(
        { recurrence: { $in: regras.map((r) => r._id) } },
        { projection: { recurrence: 1, periodo: 1 } }
      )
      .toArray();

    const porRegra = new Map();
    for (const c of geradas) {
      const chave = String(c.recurrence);
      if (!porRegra.has(chave)) porRegra.set(chave, new Set());
      porRegra.get(chave).add(String(c.periodo || ""));
    }

    let criadas = 0;

    for (const regra of regras) {
      // Valor zero não vira cobrança: seria uma linha de R$ 0,00 por mês, para
      // sempre, num cadastro que alguém deixou pela metade.
      if (!regra.amount) continue;

      const faltando = recorrencia.pendentes({
        inicio: regra.startsAt,
        fim: regra.endsAt,
        cadencia: regra.cadencia,
        hoje,
        jaGeradas: porRegra.get(String(regra._id)) || new Set(),
      });

      for (const ocorrencia of faltando) {
        try {
          await cobrancas.insertOne({
            student: regra.student,
            currency: regra.currency || null,
            createdBy: regra.createdBy || null,
            appointment: null,
            service: null,
            aulao: null,
            // O VÍNCULO e a ETIQUETA: é o par que o índice único protege.
            recurrence: regra._id,
            periodo: ocorrencia.etiqueta,
            amount: regra.amount,
            dueDate: ocorrencia.data,
            description: regra.description || "",
            status: "open",
            note: "",
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          criadas++;
        } catch (erro) {
          // 11000 é o índice único fazendo o trabalho dele: outra requisição
          // criou esta mesma mensalidade entre a nossa leitura e a nossa
          // escrita. Não é erro — é a corrida sendo resolvida do jeito certo.
          if (erro?.code !== 11000) throw erro;
        }
      }
    }

    return criadas;
  } catch (erro) {
    console.error("[recorrencia] geração falhou:", erro?.message || erro);
    return 0;
  }
};

module.exports = Recurrence_model;
