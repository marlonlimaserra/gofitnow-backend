const { ObjectId } = require("mongodb");
const { weekdaysOf } = require("../lib/weekdays.js");

// A SUPLEMENTAÇÃO de uma pessoa: creatina, whey, vitamina D, o que o
// profissional indicou e em que momento do dia.
//
//   supplements → uma linha por item indicado
//
// Um documento por ITEM, e não um documento "protocolo" com itens dentro — ao
// contrário do plano alimentar. A diferença é o tempo de vida: refeição só
// existe dentro do plano dela, mas creatina entra em março e continua em
// setembro, enquanto o whey sai no meio. Item independente é o que deixa
// suspender um sem tocar nos outros, e é o que faz o histórico de "desde
// quando" ser por item.
//
// O MOMENTO é a espinha da tela. Quem toma cinco coisas não lê uma lista
// alfabética: lê "ao acordar", "pré-treino", "antes de dormir" — porque é assim
// que o dia acontece. Daí ele ser chave fechada e ordenada, e não texto livre:
// texto livre viraria "pre treino", "Pré treino" e "antes do treino" na mesma
// ficha, e nenhuma tela conseguiria agrupar isso.
const MOMENTOS = [
  "wake",
  "morning",
  "preWorkout",
  "intraWorkout",
  "postWorkout",
  "withMeal",
  "afternoon",
  "night",
  "beforeSleep",
  "any",
];

// As unidades que aparecem na tela. Lista fechada pelo mesmo motivo do momento —
// "g" e "gramas" na mesma ficha viram duas unidades diferentes para o olho de
// quem lê e para qualquer soma futura.
//
// `scoop` está aqui porque é como o rótulo do produto fala, e o profissional
// escreve o que a pessoa vai ler no pote.
const UNIDADES = ["g", "mg", "mcg", "ml", "UI", "cápsula", "comprimido", "scoop", "sachê", "dose"];

function Supplement_model(app) {
  this.app = app;
}

Supplement_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("supplements");
};

Supplement_model.prototype.MOMENTOS = MOMENTOS;
Supplement_model.prototype.UNIDADES = UNIDADES;

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

// Vigente, encerrado ou marcado para começar. Mesma regra do plano alimentar e
// do treino, de propósito: a ficha inteira usa as mesmas três palavras para
// "isto vale hoje", e aprender uma vez basta.
function statusOf(doc) {
  const dia = hoje();
  if (doc.endDate && doc.endDate < dia) return "past";
  if (doc.startDate && doc.startDate > dia) return "future";
  return "current";
}

Supplement_model.prototype.statusOf = statusOf;

function momentoValido(valor) {
  const m = String(valor || "").trim();
  return MOMENTOS.includes(m) ? m : "any";
}

// A unidade que veio, ou a primeira da lista. Fora da lista é recusado em vez de
// gravado: se amanhã aparecer uma unidade nova, ela entra na lista — e aí
// aparece na tela de todo mundo, que é o certo, em vez de existir só na ficha de
// quem digitou.
function unidadeValida(valor) {
  const u = String(valor || "").trim();
  return UNIDADES.includes(u) ? u : "g";
}

function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function comStatus(doc) {
  return { ...doc, status: statusOf(doc) };
}

// A ordem da lista é a do DIA, não a do cadastro: `moment` primeiro (na ordem
// fixa de MOMENTOS), e dentro dele o nome. É a ordem em que a pessoa vai tomar,
// e é a única que dispensa procurar.
function ordemDoDia(a, b) {
  const pa = MOMENTOS.indexOf(a.moment);
  const pb = MOMENTOS.indexOf(b.moment);
  if (pa !== pb) return pa - pb;
  return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
}

Supplement_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.collection();

  const docs = await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .toArray();

  return docs.map(comStatus).sort(ordemDoDia);
};

// A visão da própria pessoa: o que EU tomo, de qualquer profissional — mesma
// regra dos treinos (ver Workout_model.listOfStudent). Só o que vale hoje é
// decisão da rota, não daqui: histórico também é dela.
Supplement_model.prototype.listOfStudent = async function (studentId) {
  const col = await this.collection();

  const docs = await col.find({ student: new ObjectId(studentId) }).toArray();

  return docs.map(comStatus).sort(ordemDoDia);
};

Supplement_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc ? comStatus(doc) : undefined;
};

// Quantos valem HOJE. É o número do selo da aba: "3" ali significa "esta pessoa
// está tomando três coisas agora", e não "três coisas já foram indicadas algum
// dia" — que é o que uma contagem crua diria.
Supplement_model.prototype.countCurrent = async function (trainerId, studentId) {
  const col = await this.collection();
  const dia = hoje();

  return col.countDocuments({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    $and: [
      { $or: [{ endDate: "" }, { endDate: null }, { endDate: { $exists: false } }, { endDate: { $gte: dia } }] },
      { $or: [{ startDate: "" }, { startDate: null }, { startDate: { $exists: false } }, { startDate: { $lte: dia } }] },
    ],
  });
};

function campos(obj) {
  return {
    name: String(obj.name || "").trim(),
    // O que está escrito no pote: "Creatina Growth", "Whey isolado".
    brand: obj.brand ? String(obj.brand).trim().slice(0, 80) : "",
    dose: numeroOuNulo(obj.dose),
    unit: unidadeValida(obj.unit),
    moment: momentoValido(obj.moment),
    // Vazio = todo dia. Guardar os sete dias e "vazio" como coisas diferentes
    // seria criar duas formas de dizer a mesma coisa.
    weekdays: weekdaysOf(obj.weekdays),
    // O texto que o profissional escreve para a pessoa ler: "com água",
    // "afastado do café", "dias de treino apenas".
    notes: obj.notes ? String(obj.notes).trim().slice(0, 600) : "",
    startDate: obj.startDate ? String(obj.startDate) : "",
    endDate: obj.endDate ? String(obj.endDate) : "",
  };
}

Supplement_model.prototype.insert = async function (trainerId, studentId, obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    ...campos(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Supplement_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  // Campo ausente não é campo vazio: a tela manda só o que mudou, e sobrescrever
  // com "" o que não veio apagaria a observação de quem editou só a dose.
  const set = { updatedAt: new Date() };
  const limpos = campos(obj);
  for (const campo of Object.keys(limpos)) {
    if (obj[campo] !== undefined) set[campo] = limpos[campo];
  }

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: set }
  );

  return r.matchedCount > 0;
};

Supplement_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Tudo de uma pessoa, de uma vez. É o que a exclusão em cascata usa quando a
// pessoa sai — sem isto, a suplementação dela ficaria órfã no banco.
Supplement_model.prototype.deleteAllOfStudent = async function (studentId) {
  const col = await this.collection();
  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount;
};

module.exports = Supplement_model;
