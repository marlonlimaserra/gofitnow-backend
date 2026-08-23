const { ObjectId } = require("mongodb");

// AS PRESCRIÇÕES de uma pessoa: receita, manipulado, pedido de exame,
// encaminhamento, atestado.
//
//   prescriptions → um documento emitido, com os itens dentro
//
// Aqui os itens ficam DENTRO do documento, ao contrário da suplementação. O
// motivo é o mesmo que separa uma refeição de uma creatina: os itens de uma
// receita não têm vida própria. Eles nascem juntos, valem juntos, são impressos
// juntos numa folha e não são suspensos um a um — quem muda a dose emite outra
// receita, que é o que o papel exige.
//
// E é por isso que uma prescrição é praticamente IMUTÁVEL depois de emitida: o
// que foi entregue à pessoa (ou levado à farmácia) não pode mudar de conteúdo
// sem virar outro documento. O sistema não trava a edição — quem acabou de
// digitar errado tem de poder corrigir —, mas a data de emissão é do documento,
// não da última edição, e a trilha de auditoria guarda o que mudou.
const TIPOS = ["medication", "manipulated", "supplement", "exam", "referral", "certificate", "other"];

function Prescription_model(app) {
  this.app = app;
}

Prescription_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("prescriptions");
};

Prescription_model.prototype.TIPOS = TIPOS;

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function tipoValido(valor) {
  const t = String(valor || "").trim();
  return TIPOS.includes(t) ? t : "medication";
}

// Um item da receita. Quatro campos, e cada um é uma linha da folha:
//
//   name      "Vitamina D3 2.000 UI"
//   dose      "1 cápsula"            — quanto por vez
//   posology  "1x ao dia, em jejum"  — quando e como
//   duration  "60 dias"              — por quanto tempo
//
// Todos texto, e de propósito. Posologia de verdade é escrita em português
// ("tomar 1 comprimido a cada 8 horas por 7 dias"), não em campos numéricos — e
// um formulário que obrigasse número, unidade e intervalo faria o profissional
// lutar contra a tela para escrever o que ele escreve de olhos fechados no papel.
function limparItem(item) {
  return {
    name: String(item?.name || "").trim().slice(0, 200),
    dose: String(item?.dose || "").trim().slice(0, 120),
    posology: String(item?.posology || "").trim().slice(0, 240),
    duration: String(item?.duration || "").trim().slice(0, 80),
    notes: String(item?.notes || "").trim().slice(0, 400),
  };
}

// Item sem nome não é item: é linha em branco que alguém abriu e não preencheu.
// Descartada aqui, e não recusada com erro — a tela pode ter uma linha vazia no
// fim, e transformar isso em "corrija o formulário" seria brigar por nada.
function limparItens(itens) {
  return (Array.isArray(itens) ? itens : []).map(limparItem).filter((i) => i.name.length > 0);
}

Prescription_model.prototype.limparItens = limparItens;

function completo(doc) {
  return {
    ...doc,
    itemCount: (doc.items || []).length,
  };
}

Prescription_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.collection();

  const docs = await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    // Pela DATA DE EMISSÃO, mais recente primeiro: a receita de hoje é a que
    // vale, e é a que se procura. `createdAt` desempata para duas do mesmo dia.
    .sort({ date: -1, createdAt: -1 })
    .toArray();

  return docs.map(completo);
};

Prescription_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc ? completo(doc) : undefined;
};

Prescription_model.prototype.count = async function (trainerId, studentId) {
  const col = await this.collection();
  return col.countDocuments({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
  });
};

function campos(obj) {
  return {
    type: tipoValido(obj.type),
    // Sem data explícita, é hoje: uma receita sem data não vale em farmácia
    // nenhuma, e o caso comum é emitir agora.
    date: obj.date ? String(obj.date) : hoje(),
    // Até quando vale. Opcional porque atestado e encaminhamento não têm
    // validade no mesmo sentido que uma receita de antibiótico tem.
    validUntil: obj.validUntil ? String(obj.validUntil) : "",
    title: obj.title ? String(obj.title).trim().slice(0, 160) : "",
    items: limparItens(obj.items),
    // As orientações que não são de um item só: "retornar em 30 dias",
    // "suspender se houver desconforto".
    notes: obj.notes ? String(obj.notes).trim().slice(0, 2000) : "",
    // O REGISTRO de quem assina (CRN, CRM, CREF), como ele escreve. Guardado no
    // documento, não lido do perfil na hora de imprimir: o que foi emitido não
    // muda porque a pessoa corrigiu o número do conselho depois. É o mesmo
    // motivo pelo qual o alimento guarda cópia do nome dentro da dieta.
    council: obj.council ? String(obj.council).trim().slice(0, 60) : "",
  };
}

Prescription_model.prototype.insert = async function (trainerId, studentId, obj) {
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

Prescription_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

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

Prescription_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

Prescription_model.prototype.deleteAllOfStudent = async function (studentId) {
  const col = await this.collection();
  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount;
};

module.exports = Prescription_model;
