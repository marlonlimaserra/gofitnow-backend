const { ObjectId } = require("mongodb");
const { CHAVES } = require("../lib/examMarkers.js");

// Os EXAMES DE SANGUE de uma pessoa: o painel hormonal, a tireoide, a glicemia —
// o que fecha o ciclo de acompanhamento (anamnese → conduta → exame → ajuste).
//
//   exams → um documento por COLETA, com os marcadores dentro
//
// Um documento por coleta, e não por marcador, porque é assim que o exame
// existe no mundo: a pessoa foi ao laboratório NUM dia e voltou com um laudo. É
// o laudo que se lança, se corrige e se apaga — apagar "a coleta de março"
// marcador por marcador seria vinte cliques para desfazer um lançamento.
//
// O dado central da aba não é o valor isolado: é a SÉRIE. "Testosterona 480"
// não diz nada; "250 em março, 480 em junho" diz tudo. Por isso os marcadores
// carregam uma CHAVE do catálogo (lib/examMarkers.js) sempre que possível — é a
// chave que costura o valor de março com o de junho na tabela de evolução.
// Marcador fora do catálogo entra por nome livre e costura pelo nome.
//
// A FAIXA DE REFERÊNCIA é gravada NO LANÇAMENTO, copiada do catálogo e editável.
// Cada laboratório imprime a sua, e o que vale é a do laudo que o profissional
// tem na mão — além disso, mudar o catálogo amanhã não pode reescrever se o
// exame do ano passado estava "alto" ou não.
const TETOS = {
  lab: 80,
  notes: 600,
  markerName: 60,
  unit: 20,
  // Um laudo generoso tem ~40 linhas; 80 é folga, não limite prático. O teto
  // existe porque `markers` é um array que vem do cliente, e array sem teto é
  // convite para um documento de megabytes.
  markers: 80,
};

function Exam_model(app) {
  this.app = app;
}

Exam_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("exams");
};

function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// "2026-08-21" ou nada. É texto e não Date pelo mesmo motivo das outras datas de
// ficha: o dia da coleta é um dia do calendário, não um instante — 21/08 tem de
// ser 21/08 em qualquer fuso.
function diaValido(valor) {
  const s = String(valor || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// Um marcador como o banco o guarda. A regra de identidade: chave do catálogo
// quando houver; senão o nome livre. Os dois juntos não existem — um marcador do
// catálogo com nome digitado viraria duas identidades para a mesma linha.
function marcadorLimpo(m) {
  if (!m || typeof m !== "object") return null;

  const key = CHAVES.has(m.key) ? m.key : "";
  const name = key ? "" : String(m.name || "").trim().slice(0, TETOS.markerName);
  if (!key && !name) return null;

  const value = numeroOuNulo(m.value);
  if (value === null) return null;

  return {
    key,
    name,
    value,
    unit: String(m.unit || "").trim().slice(0, TETOS.unit),
    low: numeroOuNulo(m.low),
    high: numeroOuNulo(m.high),
  };
}

// FORA DA FAIXA, calculado na LEITURA e nunca gravado. Gravar o veredito
// congelaria um julgamento que depende da faixa — e a faixa é editável. O que se
// guarda é o fato (valor e faixa); o "alto/baixo" é conta de uma linha.
function flagOf(m) {
  if (m.low !== null && m.value < m.low) return "low";
  if (m.high !== null && m.value > m.high) return "high";
  return null;
}

function comFlags(doc) {
  return { ...doc, markers: (doc.markers || []).map((m) => ({ ...m, flag: flagOf(m) })) };
}

function campos(obj) {
  const marcadores = Array.isArray(obj.markers) ? obj.markers : [];

  return {
    collectedAt: diaValido(obj.collectedAt),
    lab: obj.lab ? String(obj.lab).trim().slice(0, TETOS.lab) : "",
    notes: obj.notes ? String(obj.notes).trim().slice(0, TETOS.notes) : "",
    markers: marcadores.slice(0, TETOS.markers).map(marcadorLimpo).filter(Boolean),
  };
}

Exam_model.prototype.campos = campos;

// Da coleta mais RECENTE para trás: a pergunta de quem abre a aba é "como ela
// está AGORA" — o exame de dois anos atrás é contexto, não manchete.
Exam_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.collection();

  const docs = await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .sort({ collectedAt: -1, createdAt: -1 })
    .toArray();

  return docs.map(comFlags);
};

// A visão da própria pessoa. Filtro só por `student`, como nos treinos: o laudo
// é da pessoa, venha de qual profissional vier o lançamento.
Exam_model.prototype.listOfStudent = async function (studentId) {
  const col = await this.collection();

  const docs = await col
    .find({ student: new ObjectId(studentId) })
    .sort({ collectedAt: -1, createdAt: -1 })
    .toArray();

  return docs.map(comFlags);
};

Exam_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc ? comFlags(doc) : undefined;
};

Exam_model.prototype.insert = async function (trainerId, studentId, obj) {
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

Exam_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  // Campo ausente não é campo vazio — a mesma regra da suplementação. Exceção
  // honesta: `markers` presente SUBSTITUI a lista inteira, porque o formulário
  // edita o laudo como um todo (é assim que corrigir um valor e remover uma
  // linha chegam na mesma gravação).
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

Exam_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Tudo de uma pessoa, de uma vez — a exclusão em cascata quando a pessoa sai.
Exam_model.prototype.deleteAllOfStudent = async function (studentId) {
  const col = await this.collection();
  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount;
};

module.exports = Exam_model;
