const { ObjectId } = require("mongodb");
const { parseDataUri } = require("../lib/imageDataUri.js");
const htmlSeguro = require("../lib/htmlSeguro.js");

// OS MODELOS DE DOCUMENTO — o termo que a academia manda o aluno assinar.
//
// *"geralmente a academia pede pro aluno assinar uns termos etc. Permita
// cadastrar esse documento em formato de arquivo, ou editor ao vivo."*
//
// ── DOIS FORMATOS, e os dois são legítimos ──────────────────────────────
//
// ARQUIVO é o caminho de quem já tem o termo pronto em PDF, feito pelo
// advogado, com carimbo e tudo. Ele não quer reescrever nada: quer subir e
// imprimir.
//
// HTML é o caminho de quem quer que o documento saia COM O NOME DO ALUNO
// preenchido. Um PDF pronto não faz isso — ele sai igual para todo mundo, e
// alguém escreve o nome à caneta.
//
// Os dois convivem porque resolvem coisas diferentes, e escolher um só deixaria
// metade das academias de fora.
//
// ── O HTML É LIMPO NA GRAVAÇÃO, e não na leitura ────────────────────────
//
// Ver `lib/htmlSeguro.js`. Na gravação porque o documento é lido muitas vezes
// (tela, folha, PDF, e-mail) e escrito uma: limpar na leitura seria pagar a
// peneira quatro vezes e deixar sujeira guardada no banco — pronta para vazar
// pela próxima saída que alguém escrever sem lembrar de limpar.
function DocumentTemplate_model(app) {
  this.app = app;
}

DocumentTemplate_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("document_templates");
};

DocumentTemplate_model.prototype.files = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("document_template_files");
};

const MAX_ARQUIVO = 7 * 1024 * 1024;
const MAX_HTML = 400 * 1024;

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 140),
  // `html` ou `arquivo`. O padrão é `html`: é o que a tela abre por primeiro, e
  // o que faz o documento sair com o nome do aluno.
  tipo: (v) => (String(v) === "arquivo" ? "arquivo" : "html"),
  html: (v) => htmlSeguro.limpar(String(v || "").slice(0, MAX_HTML)),
  // Uma linha explicando quando usar. Aparece no seletor da ficha do aluno, e é
  // o que separa "Termo de responsabilidade" de "Termo de imagem".
  descricao: (v) => String(v || "").trim().slice(0, 240),
  active: (v) => v !== false,
  // ── OBRIGATÓRIO NA MATRÍCULA ──────────────────────────────────────────
  //
  // *"sempre que um aluno se matricula, é obrigatório ele preencher alguns
  // desses documentos"*.
  //
  // Marcar aqui faz o modelo aparecer na aba PENDÊNCIAS de todo aluno que ainda
  // não o entregou.
  //
  // E é SÓ isso. A primeira versão tinha um segundo campo que trancava o login
  // de quem estivesse devendo; o Marlon cortou: *"só cadastra como pendência,
  // não precisa travar até o login dele no app"*. O propósito é a pessoa ser
  // parada no balcão, e para isso basta o aviso na ficha.
  obrigatorio: (v) => v === true,
  order: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(Math.round(n), 9999)) : 0;
  },
};

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);
  return saida;
}

function limparParcial(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

// A lista, do jeito que as duas telas precisam: Configurações mostra tudo,
// e o seletor da ficha do aluno só os ativos.
DocumentTemplate_model.prototype.listar = async function ({ somenteAtivos } = {}) {
  const col = await this.collection();
  const filtro = somenteAtivos ? { active: { $ne: false } } : {};

  const docs = await col
    .find(filtro, { projection: { html: 0 } })
    .sort({ order: 1, name: 1 })
    .toArray();

  return docs.map(paraLista);
};

// A LISTA não leva o HTML. Um termo tem páginas de texto, e dez modelos na tela
// de configuração arrastariam tudo isso para desenhar dez nomes.
function paraLista(d) {
  return {
    id: String(d._id),
    name: d.name,
    tipo: d.tipo,
    descricao: d.descricao || "",
    active: d.active !== false,
    order: d.order || 0,
    arquivo: d.arquivo || null,
    updatedAt: d.updatedAt,
  };
};

DocumentTemplate_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  if (!doc) return undefined;

  return { ...paraLista(doc), html: doc.html || "" };
};

DocumentTemplate_model.prototype.contagem = async function () {
  const col = await this.collection();
  return col.countDocuments({});
};

DocumentTemplate_model.prototype.insert = async function (obj) {
  const doc = limpar(obj);
  if (!doc.name) return null;

  const col = await this.collection();
  const r = await col.insertOne({ ...doc, createdAt: new Date(), updatedAt: new Date() });
  return r.insertedId;
};

DocumentTemplate_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const set = limparParcial(obj);
  if (set.name !== undefined && !set.name) return false;

  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...set, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

DocumentTemplate_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  if (!r.deletedCount) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ template: new ObjectId(id) });
  return true;
};

// ── O ARQUIVO de um modelo do tipo `arquivo` ──────────────────────────────
//
// Um por modelo: ele É o documento. Trocar o arquivo é trocar o modelo, e por
// isso a gravação é upsert em vez de acumular versões.
DocumentTemplate_model.prototype.parseArquivo = function (arquivo) {
  if (!arquivo || !arquivo.dataUri) return undefined;

  const lido = parseDataUri(arquivo.dataUri, { maxBytes: MAX_ARQUIVO });
  if (!lido) return undefined;

  const nome = [...String(arquivo.name || "").split(/[\\/]/).pop()]
    .filter((c) => c.codePointAt(0) >= 32)
    .join("")
    .trim()
    .slice(0, 120);

  return {
    mime: lido.mime,
    buffer: lido.buffer,
    ficha: { name: nome || "documento", mime: lido.mime, size: lido.buffer.length },
  };
};

DocumentTemplate_model.prototype.saveArquivo = async function (id, anexo) {
  const arquivos = await this.files();
  const template = new ObjectId(id);

  await arquivos.updateOne(
    { template },
    {
      $set: {
        template,
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
  await col.updateOne({ _id: template }, { $set: { arquivo: anexo.ficha, tipo: "arquivo" } });
};

DocumentTemplate_model.prototype.arquivoDe = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const arquivos = await this.files();
  return (await arquivos.findOne({ template: new ObjectId(id) })) || undefined;
};

module.exports = DocumentTemplate_model;
module.exports.MAX_ARQUIVO = MAX_ARQUIVO;
module.exports.MAX_HTML = MAX_HTML;
