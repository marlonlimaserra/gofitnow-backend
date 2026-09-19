const { ObjectId } = require("mongodb");
const { parseDataUri } = require("../lib/imageDataUri.js");
const tipos = require("../lib/tiposDeOcorrencia.js");

// A LINHA DO TEMPO DE UM FUNCIONÁRIO — o que aconteceu com ele.
//
// Advertência, elogio, atestado, férias, licença, falta, reajuste, promoção,
// treinamento e anotação solta. Uma collection para os dez, porque a pergunta
// que se faz na frente de alguém é cronológica: *"o que aconteceu com ele?"*.
//
// ── POR QUE NÃO UMA COLLECTION POR TIPO ─────────────────────────────────
//
// Porque seriam dez tabelas com os mesmos cinco campos — dono, data, texto,
// quem lançou, quando — e dez lugares para corrigir no dia em que qualquer um
// deles mudar. E porque a tela que vale a pena é a que mostra tudo em ordem:
// separadas, a história viraria dez abas que ninguém cruza.
//
// O catálogo (`lib/tiposDeOcorrencia.js`) é quem diz de que campos cada tipo
// precisa. Um tipo novo aparece no formulário sozinho.
function EmployeeRecord_model(app) {
  this.app = app;
}

EmployeeRecord_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("employee_records");
};

EmployeeRecord_model.prototype.files = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("employee_files");
};

function data(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const CAMPOS = {
  tipo: (v) => (tipos.existe(v) ? String(v) : "anotacao"),
  data: (v) => data(v) || new Date(),
  // O fim do período — férias, atestado, licença. Nulo para o que acontece num
  // dia só.
  ate: data,
  texto: (v) => String(v || "").trim().slice(0, 4000),
  // O reajuste guarda o valor NOVO, em centavos. É o que permite ler a escada
  // de aumentos sem abrir a ficha.
  amount: (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100000000) : 0;
  },
  gravidade: (v) => (tipos.GRAVIDADES.some((g) => g.id === String(v)) ? String(v) : "verbal"),
  // ── "O FUNCIONÁRIO FICOU CIENTE" ──────────────────────────────────────
  //
  // É a diferença entre uma advertência que vale e um papel na gaveta. Sem a
  // ciência do empregado — assinatura, ou recusa testemunhada — a advertência
  // não sustenta nada depois.
  //
  // Guardar isto num checkbox é o mínimo honesto: não substitui a assinatura no
  // papel, mas faz a tela PERGUNTAR, que é o que ninguém lembra de fazer.
  ciente: (v) => v === true,
  cienteEm: data,
  // A falta é justificada ou não. É o campo que separa "faltou e trouxe
  // atestado" de "não apareceu".
  justificada: (v) => v === true,
  // A promoção guarda o cargo NOVO.
  cargo: (v) => String(v || "").trim().slice(0, 80),
};

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);
  return coerente(saida);
}

function limparParcial(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

// ── O CATÁLOGO MANDA: campo que o tipo não usa não é gravado ─────────────
//
// Uma anotação com `gravidade: "verbal"` guardada por acidente é um dado que
// alguém um dia vai filtrar por engano — e o filtro traria anotações como se
// fossem advertências. O que o tipo não declara, sai.
function coerente(doc) {
  const tipo = tipos.porId(doc.tipo) || {};

  if (!tipo.periodo) doc.ate = null;
  if (!tipo.valor) doc.amount = 0;
  if (!tipo.gravidade) doc.gravidade = null;
  if (!tipo.ciente) {
    doc.ciente = false;
    doc.cienteEm = null;
  }
  if (!tipo.justificada) doc.justificada = false;
  if (!tipo.cargo) doc.cargo = "";

  // Um período que termina antes de começar é digitação trocada, e vira um dia
  // só em vez de um intervalo negativo que some de toda consulta.
  if (doc.ate && doc.data && doc.ate < doc.data) doc.ate = doc.data;

  // Marcar "ciente" sem dizer quando carimba hoje: a data da ciência é o que
  // conta prazo, e deixá-la nula tornaria o campo decorativo.
  if (doc.ciente && !doc.cienteEm) doc.cienteEm = new Date();

  return doc;
}

// ── O ANEXO ───────────────────────────────────────────────────────────────
//
// O atestado escaneado, a advertência assinada, o certificado do curso. Mesma
// forma do comprovante de uma conta a pagar: os BYTES numa collection à parte e
// uma FICHA leve no documento, para a linha do tempo não arrastar arquivo.
const TIPOS_ANEXO = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_ANEXO = 8 * 1024 * 1024;

EmployeeRecord_model.prototype.parseAnexo = function (arquivo) {
  if (!arquivo || !arquivo.dataUri) return undefined;

  const lido = parseDataUri(arquivo.dataUri, { maxBytes: MAX_ANEXO, mimes: TIPOS_ANEXO });
  if (!lido) return undefined;

  // O nome vem do navegador e vira texto numa tela. Fica só o último pedaço do
  // caminho, e caractere de controle sai fora — um "\r" no meio do nome quebra
  // o cabeçalho do download em duas linhas.
  const nome = [...String(arquivo.name || "").split(/[\\/]/).pop()]
    .filter((c) => c.codePointAt(0) >= 32)
    .join("")
    .trim()
    .slice(0, 120);

  return {
    mime: lido.mime,
    buffer: lido.buffer,
    ficha: {
      name: nome || "anexo",
      mime: lido.mime,
      size: lido.buffer.length,
      kind: lido.mime.startsWith("image/") ? "image" : "file",
    },
  };
};

EmployeeRecord_model.prototype.saveAnexo = async function (id, anexo) {
  const arquivos = await this.files();

  await arquivos.updateOne(
    { record: new ObjectId(id) },
    {
      $set: {
        record: new ObjectId(id),
        mime: anexo.mime,
        name: anexo.ficha.name,
        size: anexo.ficha.size,
        data: anexo.buffer,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { anexo: anexo.ficha } });
};

EmployeeRecord_model.prototype.anexoDe = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const arquivos = await this.files();
  return (await arquivos.findOne({ record: new ObjectId(id) })) || undefined;
};

EmployeeRecord_model.prototype.removeAnexo = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ record: new ObjectId(id) });

  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { anexo: null } });
  return true;
};

// ── A LINHA DO TEMPO ──────────────────────────────────────────────────────
//
// Do mais recente para o mais antigo, sempre: a pergunta é "o que aconteceu
// ultimamente".
EmployeeRecord_model.prototype.listar = async function ({ employee, tipo, de, ate, limite } = {}) {
  if (!ObjectId.isValid(employee)) return { rows: [], porTipo: [] };

  const col = await this.collection();
  const filtro = { employee: new ObjectId(employee) };

  if (tipo) {
    const pedidos = String(tipo).split(",").map((x) => x.trim()).filter(tipos.existe);
    if (pedidos.length) filtro.tipo = { $in: pedidos };
  }

  if (de || ate) {
    filtro.data = {};
    if (de) filtro.data.$gte = new Date(de);
    if (ate) filtro.data.$lte = new Date(ate);
  }

  const teto = Math.min(Math.max(Number(limite) || 200, 1), 500);

  const [rows, porTipo] = await Promise.all([
    col.find(filtro).sort({ data: -1, _id: -1 }).limit(teto).toArray(),
    // A CONTAGEM POR TIPO é do funcionário inteiro, e não do recorte: ela
    // desenha os filtros, e um filtro que some quando se clica nele é armadilha.
    col
      .aggregate([
        { $match: { employee: new ObjectId(employee) } },
        { $group: { _id: "$tipo", quantas: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  return {
    rows: rows.map(paraTela),
    porTipo: porTipo.map((p) => ({ tipo: p._id, quantas: p.quantas })),
  };
};

function paraTela(r) {
  return {
    id: String(r._id),
    employee: String(r.employee),
    tipo: r.tipo,
    data: r.data,
    ate: r.ate || null,
    texto: r.texto || "",
    amount: r.amount || 0,
    gravidade: r.gravidade || null,
    ciente: !!r.ciente,
    cienteEm: r.cienteEm || null,
    justificada: !!r.justificada,
    cargo: r.cargo || "",
    anexo: r.anexo || null,
    createdAt: r.createdAt,
    createdByName: r.createdByName || "",
  };
}

EmployeeRecord_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc ? paraTela(doc) : undefined;
};

EmployeeRecord_model.prototype.insert = async function (employee, obj, quem) {
  if (!ObjectId.isValid(employee)) return null;

  const doc = limpar(obj);
  const col = await this.collection();

  const r = await col.insertOne({
    ...doc,
    employee: new ObjectId(employee),
    // QUEM LANÇOU, pelo nome e não só pelo id: uma advertência de 2024 tem de
    // continuar dizendo quem a aplicou depois que aquela conta for excluída.
    createdBy: quem?._id ? new ObjectId(String(quem._id)) : null,
    createdByName: String(quem?.name || "").slice(0, 120),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

EmployeeRecord_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const antes = await col.findOne({ _id: new ObjectId(id) });
  if (!antes) return false;

  // A coerência roda sobre o documento INTEIRO, e não só sobre o que mudou:
  // trocar o tipo de uma advertência para anotação tem de limpar a gravidade
  // que ficou para trás.
  const mudanca = coerente({ ...antes, ...limparParcial(obj) });
  delete mudanca._id;
  delete mudanca.employee;
  delete mudanca.createdBy;
  delete mudanca.createdByName;
  delete mudanca.createdAt;

  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...mudanca, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

EmployeeRecord_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  if (!r.deletedCount) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ record: new ObjectId(id) });
  return true;
};

module.exports = EmployeeRecord_model;
module.exports.paraTela = paraTela;
