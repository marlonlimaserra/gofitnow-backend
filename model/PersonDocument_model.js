const { ObjectId } = require("mongodb");
const { parseDataUri } = require("../lib/imageDataUri.js");

// OS DOCUMENTOS DE UMA PESSOA — a aba "Documentos" da ficha.
//
// *"lá dentro do aluno, coloque a aba de documentos, onde podemos colocar
// vários arquivos"*.
//
// O termo assinado e escaneado, a carteirinha, o atestado médico de aptidão, a
// autorização do responsável de um menor. Coisas que chegam em papel, viram
// foto no celular da recepção, e hoje moram numa pasta do Google Drive de
// alguém.
//
// ── POR QUE NÃO É A MESMA COLLECTION DOS ANEXOS DE FUNCIONÁRIO ──────────
//
// Porque o dono é outro e a permissão é outra. Um anexo de funcionário pende de
// uma OCORRÊNCIA (advertência, atestado) e é lido por quem administra a equipe;
// este pende da PESSOA e é lido por quem atende. Juntá-los faria toda consulta
// carregar um "de que tipo é o dono?" — e a primeira vez que alguém esquecesse
// seria um documento de aluno aparecendo na ficha de um funcionário.
//
// A FORMA é a mesma de propósito: ficha leve no documento, bytes à parte.
function PersonDocument_model(app) {
  this.app = app;
}

PersonDocument_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("person_documents");
};

PersonDocument_model.prototype.files = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("person_document_files");
};

// 7 MB: o mesmo teto dos anexos de funcionário, e pela mesma razão — o
// `bodyParser` corta o corpo em 10 MB e o base64 infla ~33%.
const MAX_BYTES = 7 * 1024 * 1024;

// O que pode sair `inline` no navegador. O resto vira download. Ver o mesmo
// raciocínio em `EmployeeRecord_model`: um `.html` servido `inline` da nossa
// origem roda script na nossa origem.
const INLINE = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

function podeSairInline(mime) {
  return INLINE.includes(String(mime || "").toLowerCase());
}

PersonDocument_model.prototype.podeSairInline = function (mime) {
  return podeSairInline(mime);
};

PersonDocument_model.prototype.parseArquivo = function (arquivo) {
  if (!arquivo || !arquivo.dataUri) return undefined;

  // Sem lista de tipos: qualquer arquivo entra. O cuidado está em como ele SAI.
  const lido = parseDataUri(arquivo.dataUri, { maxBytes: MAX_BYTES });
  if (!lido) return undefined;

  const nome = [...String(arquivo.name || "").split(/[\\/]/).pop()]
    .filter((c) => c.codePointAt(0) >= 32)
    .join("")
    .trim()
    .slice(0, 160);

  return {
    mime: lido.mime,
    buffer: lido.buffer,
    ficha: { name: nome || "documento", mime: lido.mime, size: lido.buffer.length },
  };
};

PersonDocument_model.prototype.listar = async function (person) {
  if (!ObjectId.isValid(person)) return [];

  const col = await this.collection();
  const docs = await col
    .find({ person: new ObjectId(person) })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  return docs.map(paraTela);
};

function paraTela(d) {
  return {
    id: String(d._id),
    name: d.name,
    mime: d.mime,
    size: d.size,
    note: d.note || "",
    template: d.template ? String(d.template) : null,
    // A DISPENSA é um documento sem arquivo: "assinou em papel, está na pasta
    // física". Ela cumpre a exigência do mesmo jeito, e fica visível na lista
    // com o motivo — o que um campo escondido na ficha não faria.
    dispensa: d.dispensa || null,
    // `abre` sai inline no navegador; `baixa` vira download. A tela usa isto
    // para decidir se oferece o visualizador.
    kind: podeSairInline(d.mime) ? "abre" : "baixa",
    createdAt: d.createdAt,
    createdByName: d.createdByName || "",
  };
}

PersonDocument_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc ? paraTela(doc) : undefined;
};

// ── O QUE ESTE DOCUMENTO CUMPRE ───────────────────────────────────────────
//
// `template` liga o arquivo guardado ao MODELO que a casa exige. É o que faz o
// termo assinado e escaneado apagar a pendência — sem o elo, o sistema veria um
// PDF chamado "scan_001.pdf" e não teria como saber que é o termo.
//
// Nulo é legítimo e é a maioria: a carteirinha e a foto do RG não cumprem
// exigência nenhuma.
PersonDocument_model.prototype.insert = async function (person, anexo, quem, note, template) {
  if (!ObjectId.isValid(person) || !anexo) return null;

  const col = await this.collection();
  const arquivos = await this.files();

  const r = await col.insertOne({
    person: new ObjectId(person),
    name: anexo.ficha.name,
    mime: anexo.ficha.mime,
    size: anexo.ficha.size,
    note: String(note || "").trim().slice(0, 240),
    template: ObjectId.isValid(template) ? new ObjectId(String(template)) : null,
    // QUEM SUBIU, pelo nome e não só pelo id: um termo de 2024 tem de continuar
    // dizendo quem o guardou depois que aquela conta for excluída.
    createdBy: quem?._id ? new ObjectId(String(quem._id)) : null,
    createdByName: String(quem?.name || "").slice(0, 120),
    createdAt: new Date(),
  });

  await arquivos.insertOne({
    document: r.insertedId,
    person: new ObjectId(person),
    mime: anexo.mime,
    data: anexo.buffer,
    createdAt: new Date(),
  });

  return r.insertedId;
};

// Os BYTES, pelos dois ids. O da pessoa entra no filtro de propósito: sem ele,
// um id de documento adivinhado leria o arquivo da ficha de outra pessoa — e o
// escopo de cliente, que é automático, não separa uma pessoa da outra.
PersonDocument_model.prototype.arquivoDe = async function (person, id) {
  if (!ObjectId.isValid(person) || !ObjectId.isValid(id)) return undefined;

  const col = await this.collection();
  const ficha = await col.findOne({ _id: new ObjectId(id), person: new ObjectId(person) });
  if (!ficha) return undefined;

  const arquivos = await this.files();
  const bytes = await arquivos.findOne({ document: new ObjectId(id) });
  if (!bytes) return undefined;

  return { ...ficha, data: bytes.data, mime: bytes.mime || ficha.mime };
};

PersonDocument_model.prototype.remove = async function (person, id) {
  if (!ObjectId.isValid(person) || !ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), person: new ObjectId(person) });
  if (!r.deletedCount) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ document: new ObjectId(id) });
  return true;
};

// ── DISPENSAR UMA EXIGÊNCIA ───────────────────────────────────────────────
//
// O aluno assinou em papel e o arquivo está na pasta física; o menor trouxe a
// autorização e alguém arquivou. A exigência está cumprida, e o sistema não tem
// o arquivo.
//
// Sem isto, a única saída seria escanear alguma coisa qualquer para destravar —
// e aí o sistema teria um PDF em branco dizendo que o termo existe.
//
// Ela é uma LINHA na mesma lista, e não um campo escondido: quem abrir a ficha
// daqui a um ano vê "dispensado por Marlon em 20/09: assinou em papel".
PersonDocument_model.prototype.dispensar = async function (person, template, motivo, quem) {
  if (!ObjectId.isValid(person) || !ObjectId.isValid(template)) return null;

  const col = await this.collection();
  const r = await col.insertOne({
    person: new ObjectId(person),
    template: new ObjectId(template),
    name: String(quem?.nomeDoModelo || "").slice(0, 160) || "—",
    mime: "",
    size: 0,
    note: "",
    dispensa: {
      motivo: String(motivo || "").trim().slice(0, 240),
      por: String(quem?.name || "").slice(0, 120),
      em: new Date(),
    },
    createdBy: quem?._id ? new ObjectId(String(quem._id)) : null,
    createdByName: String(quem?.name || "").slice(0, 120),
    createdAt: new Date(),
  });

  return r.insertedId;
};

// Quais MODELOS esta pessoa já cumpriu — por arquivo ou por dispensa.
PersonDocument_model.prototype.modelosCumpridos = async function (person) {
  if (!ObjectId.isValid(person)) return [];

  const col = await this.collection();
  const docs = await col
    .find({ person: new ObjectId(person), template: { $ne: null } }, { projection: { template: 1 } })
    .toArray();

  return [...new Set(docs.map((d) => String(d.template)))];
};

// A pessoa foi excluída: os documentos dela vão junto. Sem isto, os bytes
// ficariam no banco sem nenhuma tela que os alcance.
PersonDocument_model.prototype.removeAllOf = async function (person) {
  if (!ObjectId.isValid(person)) return 0;

  const col = await this.collection();
  const arquivos = await this.files();
  const dono = new ObjectId(person);

  const r = await col.deleteMany({ person: dono });
  await arquivos.deleteMany({ person: dono });
  return r.deletedCount || 0;
};

// Quantos cada pessoa tem — é o selo da aba, que diz se vale abrir.
PersonDocument_model.prototype.contarDe = async function (person) {
  if (!ObjectId.isValid(person)) return 0;
  const col = await this.collection();
  return col.countDocuments({ person: new ObjectId(person) });
};

module.exports = PersonDocument_model;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.podeSairInline = podeSairInline;
