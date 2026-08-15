const { ObjectId } = require("mongodb");

// As avaliações físicas de uma pessoa.
//
//   assessments → uma coleta: data, peso, dobras, circunferências, bioimpedância
//
// Cada documento é uma FOTOGRAFIA de um dia. Nada aqui é atualizado com o tempo:
// a avaliação de janeiro continua dizendo o que dizia em janeiro, e é a
// sequência delas que conta a história.
//
// Os grupos de medida são objetos separados — `skinfolds`, `circumferences`,
// `bioimpedance`, `tests` — e não campos soltos no documento. São quarenta e
// poucos números, e agrupá-los é o que permite a tela ligar e desligar uma seção
// inteira sem saber o nome de cada um.
//
// O que NÃO é guardado: IMC, percentual de gordura, RCQ, massa magra. Todos são
// derivados do que está aqui, e um valor calculado gravado é um valor que pode
// discordar dos dados logo ao lado — basta corrigir uma dobra depois. Quem
// calcula é a tela, com as fórmulas em views/student/assessments/calculos.js.
//
// A exceção é a BIOIMPEDÂNCIA: aqueles números não são calculados por ninguém,
// são lidos de um aparelho e digitados. Por isso ela é dado, não derivação.
function Assessment_model(app) {
  this.app = app;
}

Assessment_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("assessments");
};

// Número que pode faltar, e faltar é o normal: quase nenhuma avaliação preenche
// os quarenta campos. Zero mentiria — "0 cm de cintura" não é uma medida, é a
// ausência dela.
function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function alturaEmMetros(valor) {
  const n = numeroOuNulo(valor);
  if (n === null) return null;

  return n > 3 ? Math.round((n / 100) * 100) / 100 : n;
}

// Os campos aceitos em cada grupo.
//
// Lista fechada de propósito: o corpo do pedido vem do navegador, e sem
// whitelist qualquer chave entraria no documento. Acrescentar uma medida nova é
// acrescentar uma linha aqui.
const DOBRAS = [
  "biceps",
  "subscapular",
  "triceps",
  "chest",
  "midaxillary",
  "suprailiac",
  "abdominal",
  "thigh",
  "calf",
];

// Weltman mede o abdômen em DOIS pontos e usa a média dos dois. Ficam fora de
// `circumferences` de propósito: lá o abdômen é uma medida de acompanhamento,
// aqui são os dois sítios anatômicos de um protocolo — misturá-los faria a
// tela de circunferências pedir uma medida que só o Weltman usa.
const WELTMAN = ["abdomen1", "abdomen2"];

// Como o percentual de gordura desta coleta foi obtido. Um só, nunca dois: os
// três métodos discordam entre si o bastante para que combiná-los produza um
// número que nenhum deles sustenta.
const METODOS = ["skinfolds", "bioimpedance", "weltman"];

// Qual equação de dobras. Guardada junto da coleta, e não escolhida na leitura,
// porque trocar o protocolo depois mudaria um resultado já entregue à pessoa.
const PROTOCOLOS = [
  "pollock3",
  "guedes3",
  "durnin4",
  "faulkner4",
  "petroski4",
  "pollock7",
];

const CIRCUNFERENCIAS = [
  "neck",
  "chest",
  "waist",
  "abdomen",
  "hip",
  "shoulder",
  "forearmRight",
  "forearmLeft",
  "armRightRelaxed",
  "armLeftRelaxed",
  "armRightFlexed",
  "armLeftFlexed",
  "thighRight",
  "thighLeft",
  "calfRight",
  "calfLeft",
];

const BIOIMPEDANCIA = [
  "muscleMass",
  "musclePercent",
  "skeletalMusclePercent",
  "boneMass",
  "fatMass",
  "fatPercent",
  "waterMass",
  "waterPercent",
  "leanMass",
  // Peso residual: o que sobra tirando gordura, músculo, osso e água — vísceras
  // e tecido conjuntivo. Alguns aparelhos mostram, e sem campo aqui esse número
  // seria digitado em "observação", onde nenhuma conta o alcança.
  "residualMass",
  "protein",
  "minerals",
  "bmi",
  "visceralFatMass",
  "visceralFatPercent",
  "bmr",
  "bodyAge",
];

const TESTES = ["situps", "pushups", "cooper", "tugt", "sitStand", "flexibility"];

function grupo(campos, origem) {
  const saida = {};
  for (const campo of campos) saida[campo] = numeroOuNulo(origem?.[campo]);
  return saida;
}

// Um grupo inteiro vazio vira `null` em vez de um objeto com dezesseis nulos.
//
// É a diferença entre "mediu e não achou nada" e "não mediu". A tela usa isso
// para não desenhar a seção de bioimpedância de quem nunca usou balança.
function grupoOuNulo(campos, origem) {
  const valores = grupo(campos, origem);
  return Object.values(valores).some((v) => v !== null) ? valores : null;
}

// O que uma coleta grava a partir do corpo do pedido.
//
// As FOTOS não estão aqui, e é de propósito: elas têm rotas próprias e vivem em
// `assessment_photos`. Se entrassem, o salvamento automático — que manda o
// formulário inteiro a cada campo digitado, e o formulário não carrega imagem —
// apagaria as quatro fotos a cada tecla.
function limpar(obj) {
  return {
    // A data da COLETA, escolhida por quem mede — não a de gravação. Uma
    // avaliação pode ser lançada dias depois de feita, e o gráfico tem de
    // mostrá-la onde ela aconteceu.
    date: obj.date ? new Date(obj.date) : new Date(),
    // Por quantos dias o resultado vale, se o profissional definir. É o que
    // permite avisar que está na hora de reavaliar.
    validityDays: numeroOuNulo(obj.validityDays),

    weight: numeroOuNulo(obj.weight),
    // Em METROS, como o resto do sistema — mesmo quando chega em centímetros.
    //
    // O campo mostra "m" e mesmo assim se digita 175: é o número que a pessoa
    // sabe de cor. Converter aqui, na entrada, evita a dúvida de "1,75 ou 175?"
    // espalhada por cada conta que usa altura. Não há ambiguidade: gente mede
    // entre 0,5 e 2,5 m, ou entre 50 e 250 cm, e as faixas não se encostam.
    height: alturaEmMetros(obj.height),

    method: METODOS.includes(obj.method) ? obj.method : "skinfolds",
    protocol: PROTOCOLOS.includes(obj.protocol) ? obj.protocol : "pollock3",

    skinfolds: grupoOuNulo(DOBRAS, obj.skinfolds),
    weltman: grupoOuNulo(WELTMAN, obj.weltman),
    circumferences: grupoOuNulo(CIRCUNFERENCIAS, obj.circumferences),
    bioimpedance: grupoOuNulo(BIOIMPEDANCIA, obj.bioimpedance),
    tests: grupoOuNulo(TESTES, obj.tests),

    // Rascunho: a coleta existe no banco desde o primeiro clique, e vai sendo
    // gravada campo a campo enquanto se digita.
    //
    // São quarenta e tantos números medidos com a pessoa na frente, e perder
    // isso por uma queda de luz significa medir tudo de novo. O preço é este
    // campo: enquanto for rascunho, a coleta não entra nos cartões nem no
    // comparativo — meia avaliação distorceria a comparação em vez de informá-la.
    draft: obj.draft !== false,

    note: obj.note ? String(obj.note).trim() : "",
  };
}

// Da mais NOVA para a mais antiga: a pergunta usual é "como ele está agora", e a
// resposta é a primeira linha.
Assessment_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.collection();

  return await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .sort({ date: -1 })
    .toArray();
};

// O rascunho em aberto desta pessoa, se houver.
//
// Um por vez: sem isto, cada clique em "Nova medida" que fosse abandonado
// deixaria uma coleta vazia para trás, e em um mês a ficha teria mais rascunho
// que avaliação. Achando um, a tela continua dele em vez de criar outro.
Assessment_model.prototype.draftOf = async function (trainerId, studentId) {
  const col = await this.collection();

  const doc = await col.findOne(
    { trainer: new ObjectId(trainerId), student: new ObjectId(studentId), draft: true },
    { sort: { createdAt: -1 } }
  );

  return doc || undefined;
};

Assessment_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc || undefined;
};

Assessment_model.prototype.insert = async function (trainerId, studentId, obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    ...limpar(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Assessment_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: { ...limpar(obj), updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

// O carimbo de data de um lado, gravado no documento da coleta.
//
// É o índice das fotos: a listagem já responde quais existem e de quando são,
// sem uma consulta a mais e sem trazer byte nenhum de imagem.
Assessment_model.prototype.setPhoto = async function (trainerId, id, side, at) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: { [`photos.${side}`]: at, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

Assessment_model.prototype.clearPhoto = async function (trainerId, id, side) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $unset: { [`photos.${side}`]: "" }, $set: { updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

// Os ids das coletas de uma pessoa. Serve à exclusão em cascata: as fotos são
// referenciadas pela avaliação, não pelo aluno.
Assessment_model.prototype.idsOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.collection();

  const docs = await col
    .find({ student: new ObjectId(studentId) }, { projection: { _id: 1 } })
    .toArray();

  return docs.map((d) => d._id);
};

Assessment_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Apagadas junto com a pessoa, como treinos e planos alimentares.
Assessment_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;
  const col = await this.collection();

  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount || 0;
};

module.exports = Assessment_model;
module.exports.DOBRAS = DOBRAS;
module.exports.WELTMAN = WELTMAN;
module.exports.METODOS = METODOS;
module.exports.PROTOCOLOS = PROTOCOLOS;
module.exports.CIRCUNFERENCIAS = CIRCUNFERENCIAS;
module.exports.BIOIMPEDANCIA = BIOIMPEDANCIA;
module.exports.TESTES = TESTES;
