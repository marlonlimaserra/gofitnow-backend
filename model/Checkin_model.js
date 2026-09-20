const { ObjectId } = require("mongodb");

// A ENTRADA NA ACADEMIA — quem passou pela porta, e quando.
//
// *"crie esse menu no aluno: frequência de entrada na academia e frequência nas
// aulas. Já comprei o negócio de face ID para a gente testar quando chegar."*
//
// ── POR QUE ISTO É A COISA MAIS IMPORTANTE QUE FALTAVA ──────────────────
//
// O sistema sabia quem se inscreveu, quem pagou e quem fez check-in em AULA
// COLETIVA. Não sabia quem entrou na academia — e para uma academia essa é a
// métrica-base, não o cadastro.
//
// Academia não perde aluno no dia do cancelamento: perde três semanas antes,
// quando ele para de vir. Sem esta collection não há como ver isso acontecendo.
//
// ── A CATRACA AINDA NÃO CHEGOU, e o desenho já a espera ─────────────────
//
// `origem` distingue quem registrou: o balcão, o próprio aluno pelo app, ou um
// leitor. `dispositivo` diz QUAL leitor, para o dia em que houver dois.
//
// O que o leitor facial NÃO faz aqui é decidir quem é a pessoa: ele resolve
// rosto → id e chama a rota com o id. Reconhecimento é problema do aparelho, e
// o template biométrico fica NELE — dado biométrico é sensível na LGPD, e o
// nosso banco não é lugar para guardá-lo.
function Checkin_model(app) {
  this.app = app;
}

Checkin_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("checkins");
};

const ORIGENS = ["balcao", "app", "catraca", "importado"];

// ── A JANELA DE REPETIÇÃO ─────────────────────────────────────────────────
//
// Uma catraca dispara duas vezes quando a pessoa hesita na roleta, e um leitor
// facial dispara enquanto o rosto estiver na frente dele. Sem esta janela, uma
// visita vira cinco entradas e a frequência do mês triplica.
//
// Trinta minutos: quem sai para o carro e volta não conta duas vezes; quem vem
// de manhã e de novo à noite conta duas, que é o certo — é treino duplo, e
// existe.
const REPETICAO_MIN = 30;

Checkin_model.prototype.registrar = async function (pessoa, opcoes = {}) {
  if (!ObjectId.isValid(pessoa)) return { ok: false, erro: "invalido" };

  const col = await this.collection();
  const agora = opcoes.em ? new Date(opcoes.em) : new Date();
  if (Number.isNaN(agora.getTime())) return { ok: false, erro: "data" };

  const desde = new Date(agora.getTime() - REPETICAO_MIN * 60 * 1000);

  // O repetido NÃO é erro: é a resposta certa para o segundo disparo da
  // catraca. A rota devolve 200 e a tela não mostra nada — de propósito.
  const recente = await col.findOne(
    { person: new ObjectId(pessoa), em: { $gte: desde, $lte: agora } },
    { projection: { _id: 1, em: 1 } }
  );

  if (recente) return { ok: true, repetido: true, id: String(recente._id), em: recente.em };

  const doc = {
    person: new ObjectId(pessoa),
    em: agora,
    origem: ORIGENS.includes(String(opcoes.origem)) ? String(opcoes.origem) : "balcao",
    unit: ObjectId.isValid(opcoes.unit) ? new ObjectId(String(opcoes.unit)) : null,
    dispositivo: String(opcoes.dispositivo || "").trim().slice(0, 80),
    // QUEM registrou, quando foi gente. A catraca não tem nome, e o `origem` já
    // conta essa parte.
    por: opcoes.por?._id ? new ObjectId(String(opcoes.por._id)) : null,
    porNome: String(opcoes.por?.name || "").slice(0, 120),
    createdAt: new Date(),
  };

  const r = await col.insertOne(doc);
  return { ok: true, repetido: false, id: String(r.insertedId), em: agora };
};

Checkin_model.prototype.remover = async function (pessoa, id) {
  if (!ObjectId.isValid(pessoa) || !ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), person: new ObjectId(pessoa) });
  return r.deletedCount > 0;
};

// ── O HISTÓRICO DE UMA PESSOA ─────────────────────────────────────────────
//
// `de`/`ate` como Date; a tela pede os últimos meses. Sem paginação: são
// dezenas por trimestre, e o que a tela desenha é um calendário — ele precisa
// de todos os dias de uma vez.
Checkin_model.prototype.daPessoa = async function (pessoa, { de, ate } = {}) {
  if (!ObjectId.isValid(pessoa)) return [];

  const col = await this.collection();
  const filtro = { person: new ObjectId(pessoa) };

  if (de || ate) {
    filtro.em = {};
    if (de) filtro.em.$gte = new Date(de);
    if (ate) filtro.em.$lte = new Date(ate);
  }

  const docs = await col.find(filtro).sort({ em: -1 }).limit(1000).toArray();

  return docs.map((d) => ({
    id: String(d._id),
    em: d.em,
    origem: d.origem,
    unit: d.unit ? String(d.unit) : null,
    dispositivo: d.dispositivo || "",
    porNome: d.porNome || "",
  }));
};

// A ÚLTIMA vez que a pessoa veio. É o número que responde "sumiu?" sozinho, e
// por isso é uma consulta própria: a tela o mostra antes de qualquer lista.
Checkin_model.prototype.ultimaDe = async function (pessoa) {
  if (!ObjectId.isValid(pessoa)) return null;

  const col = await this.collection();
  const doc = await col
    .find({ person: new ObjectId(pessoa) }, { projection: { em: 1 } })
    .sort({ em: -1 })
    .limit(1)
    .next();

  return doc?.em || null;
};

Checkin_model.prototype.contarDe = async function (pessoa, { de, ate } = {}) {
  if (!ObjectId.isValid(pessoa)) return 0;

  const col = await this.collection();
  const filtro = { person: new ObjectId(pessoa) };
  if (de || ate) {
    filtro.em = {};
    if (de) filtro.em.$gte = new Date(de);
    if (ate) filtro.em.$lte = new Date(ate);
  }

  return col.countDocuments(filtro);
};

// Quem está na academia AGORA — as entradas de hoje. É o que o balcão pergunta,
// e é a base do dia em que existir ocupação por horário.
Checkin_model.prototype.doDia = async function (de, ate) {
  const col = await this.collection();
  return col
    .find({ em: { $gte: new Date(de), $lte: new Date(ate) } })
    .sort({ em: -1 })
    .limit(500)
    .toArray();
};

Checkin_model.prototype.removeAllOf = async function (pessoa) {
  if (!ObjectId.isValid(pessoa)) return 0;
  const col = await this.collection();
  const r = await col.deleteMany({ person: new ObjectId(pessoa) });
  return r.deletedCount || 0;
};

module.exports = Checkin_model;
module.exports.ORIGENS = ORIGENS;
module.exports.REPETICAO_MIN = REPETICAO_MIN;
