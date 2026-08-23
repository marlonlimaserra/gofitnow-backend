const { ObjectId } = require("mongodb");

// A ANAMNESE de uma pessoa: a conversa da primeira consulta, guardada.
//
//   anamnesis → UM documento por (profissional, pessoa)
//
// Um só, e não um histórico de versões. A anamnese não é evento — é o retrato
// atual de quem está sendo atendido: o que ela tem, o que toma, o que não come,
// como dorme. Quando algo muda, o que se quer ler é o valor de hoje, não a lista
// de todas as respostas que já deu.
//
// O histórico existe, mas não aqui: cada alteração passa pela trilha de auditoria
// com o `diff` do que mudou (`update_anamnesis`). É onde a pergunta "desde quando
// ela usa esse remédio?" tem resposta, sem transformar a tela numa linha do
// tempo que ninguém pediu.
//
// ── POR QUE TANTO TEXTO LIVRE ─────────────────────────────────────────────
//
// Quase todo campo é texto. É deliberado: anamnese é o que a pessoa CONTA, e o
// que ela conta não cabe em caixinha ("tomo losartana, mas parei em março"; "não
// como peixe, só atum"). Um formulário de múltipla escolha obrigaria o
// profissional a traduzir a fala dela em opções — e a informação que se perde
// nessa tradução é justamente a que muda a conduta.
//
// As poucas listas fechadas que existem (sono, álcool, cigarro, intestino,
// estresse) são as que se compara entre consultas e entre pessoas. Essas valem
// padronizar; o resto, não.
const ENUMS = {
  sleepQuality: ["good", "fair", "poor"],
  alcohol: ["never", "rarely", "weekly", "daily"],
  smoking: ["never", "former", "current"],
  bowel: ["regular", "constipated", "loose", "varies"],
  stress: ["low", "medium", "high"],
};

// Os campos de texto, com o teto de cada um. O teto não é desconfiança do
// profissional: é o que impede um `paste` de um PDF inteiro de empurrar o
// documento para o limite de 16 MB do Mongo.
const TEXTOS = {
  mainComplaint: 2000,
  conditions: 2000,
  medications: 2000,
  allergies: 1000,
  surgeries: 1000,
  familyHistory: 1000,
  activity: 1000,
  preferences: 1000,
  aversions: 1000,
  restrictions: 1000,
  whoCooks: 300,
  exams: 2000,
  notes: 4000,
};

const NUMEROS = { sleepHours: 24, water: 20, mealsPerDay: 12 };

function Anamnesis_model(app) {
  this.app = app;
}

Anamnesis_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("anamnesis");
};

Anamnesis_model.prototype.ENUMS = ENUMS;
Anamnesis_model.prototype.CAMPOS_TEXTO = Object.keys(TEXTOS);
Anamnesis_model.prototype.CAMPOS_NUMERO = Object.keys(NUMEROS);

function texto(valor, teto) {
  return String(valor == null ? "" : valor).trim().slice(0, teto);
}

// Número dentro do razoável, ou `null`.
//
// O teto por campo existe porque "8 horas de sono" e "80" são a mesma tecla
// pressionada duas vezes — e um gráfico futuro com 80 horas de sono some com o
// resto da escala.
function numero(valor, maximo) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Number(String(valor).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > maximo) return null;
  return Math.round(n * 10) / 10;
}

function escolha(valor, lista) {
  const v = String(valor || "").trim();
  return lista.includes(v) ? v : "";
}

// O que vem da tela, limpo. Campo ausente NÃO entra no resultado: a tela salva o
// formulário inteiro, mas uma integração pode mandar só um campo, e sobrescrever
// o resto com vazio apagaria a anamnese de alguém.
function campos(obj) {
  const set = {};

  for (const [campo, teto] of Object.entries(TEXTOS)) {
    if (obj[campo] !== undefined) set[campo] = texto(obj[campo], teto);
  }
  for (const [campo, maximo] of Object.entries(NUMEROS)) {
    if (obj[campo] !== undefined) set[campo] = numero(obj[campo], maximo);
  }
  for (const [campo, lista] of Object.entries(ENUMS)) {
    if (obj[campo] !== undefined) set[campo] = escolha(obj[campo], lista);
  }

  // QUANDO A PRÓPRIA PESSOA RESPONDEU.
  //
  // Aceito só como `Date` de verdade, e nunca como texto. Quem passa isto é a
  // rota pública (`new Date()`), no servidor; um cliente mandando
  // `answeredByPersonAt: "2020-01-01"` no formulário do profissional não
  // consegue plantar a marca de que a pessoa respondeu — o que seria mentir
  // sobre a origem de um dado clínico.
  if (obj.answeredByPersonAt instanceof Date) set.answeredByPersonAt = obj.answeredByPersonAt;

  return set;
}

Anamnesis_model.prototype.limpar = campos;

// A anamnese daquela pessoa, ou `null` quando ainda não existe.
//
// `null` e não um documento vazio: a tela precisa saber a diferença entre "nunca
// foi preenchida" (e aí ela convida a preencher) e "foi preenchida e está vazia",
// que não acontece.
Anamnesis_model.prototype.data = async function (trainerId, studentId) {
  const col = await this.collection();
  const doc = await col.findOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
  });
  return doc || null;
};

// Grava. Cria se não existe, atualiza se existe — a tela é a mesma nos dois
// casos, e uma rota de criar separada só daria à tela uma decisão que ela não
// tem como tomar melhor que o servidor.
//
// `upsert` em vez de "procura e decide": duas abas abertas na mesma ficha
// gravando ao mesmo tempo criariam duas anamneses da mesma pessoa, e o índice
// único é o que impede — mas quem faz o certo na primeira tentativa é o upsert.
Anamnesis_model.prototype.save = async function (trainerId, studentId, obj) {
  const col = await this.collection();
  const agora = new Date();

  const r = await col.updateOne(
    { trainer: new ObjectId(trainerId), student: new ObjectId(studentId) },
    {
      $set: { ...campos(obj), updatedAt: agora },
      $setOnInsert: { createdAt: agora },
    },
    { upsert: true }
  );

  return { criou: Boolean(r.upsertedId) };
};

Anamnesis_model.prototype.delete = async function (trainerId, studentId) {
  const col = await this.collection();
  const r = await col.deleteOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
  });
  return r.deletedCount > 0;
};

Anamnesis_model.prototype.deleteAllOfStudent = async function (studentId) {
  const col = await this.collection();
  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount;
};

module.exports = Anamnesis_model;
