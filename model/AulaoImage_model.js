const { ObjectId } = require("mongodb");
const arquivos = require("../lib/arquivos.js");

// A collection `aulao_images` — a capa e a galeria de um aulão.
//
// ── Por que não reusar `brand_images` ─────────────────────────────────────
//
// Elas são a mesma coisa em quase tudo: imagem pública, id opaco, bytes no R2.
// O que separa é a COLETA DE LIXO. `BrandImage_model.pruneUnused` apaga tudo o
// que o tema salvo não referencia — e a foto de um aulão não está no tema.
// Compartilhar a collection faria o primeiro salvamento de aparência apagar a
// capa de todos os aulões, sem erro e sem log.
//
// Dois donos diferentes da verdade pedem duas collections.
//
// ── PÚBLICAS, e por isso o endereço é opaco ───────────────────────────────
//
// A página de um aulão é aberta por quem ainda não é cliente — é divulgação. A
// imagem sai sem sessão, e o endereço é o id do documento justamente para que
// ninguém varra endereços e liste o que existe.
function AulaoImage_model(app) {
  this.app = app;
}

// O que o navegador exibe sem plugin. SVG fica de fora: é documento
// executável, não imagem, e serviria script na nossa origem — numa rota
// pública, ainda por cima. Mesma lista de `brand_images`, e pela mesma razão.
const MIMES = ["image/jpeg", "image/png", "image/webp"];

// Teto do que é aceito, já contando a inflação de ~33% do base64. A tela reduz
// antes de enviar; o limite existe para o que não veio da tela.
const MAX_BYTES = 4 * 1024 * 1024;

// Quantas imagens um aulão pode ter: a capa mais a galeria.
//
// Doze é o teto do `gallery` no `Aulao_model`, mais a capa. Sem teto, a rota de
// upload é um caminho de encher o bucket em laço — e ninguém rola treze fotos
// de uma aula.
const MAX_POR_AULAO = 13;

AulaoImage_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("aulao_images");
};

// "data:image/png;base64,AAAA…" → { mime, buffer } ou undefined.
AulaoImage_model.prototype.parseDataUri = function (dataUri) {
  const match = /^data:([a-z/+-]+);base64,(.+)$/i.exec(String(dataUri || "").trim());
  if (!match) return undefined;

  const mime = match[1].toLowerCase();
  if (!MIMES.includes(mime)) return undefined;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_BYTES) return undefined;

  return { mime, buffer };
};

AulaoImage_model.prototype.count = async function (aulaoId) {
  if (!ObjectId.isValid(aulaoId)) return 0;
  const col = await this.collection();
  return col.countDocuments({ aulao: new ObjectId(aulaoId) });
};

// Guarda os bytes e devolve o id que vira endereço.
//
// Insere o documento ANTES de gravar no bucket porque a chave do arquivo precisa
// do id — e inventar um id nosso antes daria à imagem DOIS nomes, o do bucket e
// o do Mongo, que um dia divergiriam. É o mesmo arranjo de `brand_images`.
AulaoImage_model.prototype.save = async function (aulaoId, mime, buffer) {
  const col = await this.collection();
  const agora = new Date();

  const r = await col.insertOne({
    aulao: new ObjectId(aulaoId),
    mime,
    size: buffer.length,
    createdAt: agora,
    updatedAt: agora,
  });

  const onde = await arquivos.ondeGuardar(
    // `aulaoes`, no plural: é o nome registrado em `lib/arquivos.js`, e casa com
    // a collection e a rota. Estava `"aulao"`, que não existe na tabela — e a
    // tabela recusa o que não conhece, de propósito.
    arquivos.chaveDoCliente("aulaoes", String(r.insertedId)),
    buffer,
    mime
  );

  await col.updateOne({ _id: r.insertedId }, { $set: onde.set, $unset: onde.unset });

  return { id: String(r.insertedId), updatedAt: agora };
};

AulaoImage_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

// ── A COLETA DE LIXO ──────────────────────────────────────────────────────
//
// O dono da verdade é o AULÃO salvo: o que não está na capa nem na galeria dele
// não é usado por ninguém. Recolher aqui, e não num botão de "remover imagem",
// é o que faz quem enviou três fotos e salvou com duas não deixar a terceira
// pendurada no bucket para sempre.
AulaoImage_model.prototype.pruneUnused = async function (aulaoId, emUso) {
  if (!ObjectId.isValid(aulaoId)) return 0;

  const manter = [];
  for (const ref of emUso || []) {
    // Aceita id puro e URL inteira: a tela manda o que recebeu, e o que ela
    // recebeu é a URL.
    const id = String(ref || "").split("/").pop();
    if (ObjectId.isValid(id)) manter.push(new ObjectId(id));
  }

  const col = await this.collection();
  const filtro = { aulao: new ObjectId(aulaoId), _id: { $nin: manter } };

  // As chaves ANTES do delete: depois dele não há como saber quais arquivos
  // eram, e os bytes ficariam no bucket para sempre — que é o problema que esta
  // função existe para resolver, um andar abaixo.
  const chaves = await col.find(filtro, { projection: { chave: 1 } }).toArray();

  const r = await col.deleteMany(filtro);
  await arquivos.apagarMuitas(chaves.map((d) => d.chave));

  return r.deletedCount;
};

// Tudo de um aulão que foi apagado. Chamado pelo `remove` do aulão: sem isto as
// imagens ficariam apontando para um aulão que não existe — nenhuma tela as
// alcançaria e nada as apagaria depois.
AulaoImage_model.prototype.removeAllOf = async function (aulaoId) {
  if (!ObjectId.isValid(aulaoId)) return 0;
  const col = await this.collection();
  const filtro = { aulao: new ObjectId(aulaoId) };

  const chaves = await col.find(filtro, { projection: { chave: 1 } }).toArray();
  const r = await col.deleteMany(filtro);
  await arquivos.apagarMuitas(chaves.map((d) => d.chave));

  return r.deletedCount;
};

module.exports = AulaoImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.MAX_POR_AULAO = MAX_POR_AULAO;

// ── COPIAR AS FOTOS DE UM AULÃO PARA OUTRO ────────────────────────────────
//
// Para o "duplicar": a cópia nasce com as MESMAS fotos, porque reenviar seis
// fotos da praia é justamente o trabalho que duplicar existe para evitar.
//
// ── Cópias PRÓPRIAS, e não os mesmos ids ──────────────────────────────────
//
// A tentação é pôr os ids do original na galeria da cópia — dois aulões
// apontando para as mesmas imagens. Não dá, e o motivo está duas funções acima:
// `pruneUnused` e `removeAllOf` filtram por `aulao: <id>` e apagam os BYTES no
// bucket.
//
// Então apagar o aulão original levaria as fotos da cópia junto. A cópia ficaria
// com uma galeria de endereços mortos — e numa página pública, sem erro nenhum:
// só quadrados vazios para quem clicou no link.
//
// O preço é guardar os bytes duas vezes. Uma foto reduzida tem ~200 KB e um
// aulão tem no máximo treze; duplicar um custa menos de 3 MB no bucket. É barato
// para o que compra.
//
// Devolve um mapa `idAntigo → idNovo`, que é o que permite reescrever a capa e a
// ordem da galeria sem adivinhar.
AulaoImage_model.prototype.copiarPara = async function (deAulaoId, paraAulaoId) {
  const mapa = new Map();
  if (!ObjectId.isValid(deAulaoId) || !ObjectId.isValid(paraAulaoId)) return mapa;

  const col = await this.collection();
  const originais = await col.find({ aulao: new ObjectId(deAulaoId) }).toArray();

  for (const doc of originais) {
    // `bytesDoDocumento` lê do R2 ou do próprio documento, dependendo de onde os
    // bytes ficaram — quem decide isso é `arquivos.ondeGuardar`, e quem copia
    // não deveria precisar saber.
    const bytes = await arquivos.bytesDoDocumento(doc);

    // Sem bytes, a foto não é copiada — e a cópia segue sem ela. Estourar aqui
    // faria uma imagem perdida no bucket impedir de duplicar o aulão inteiro.
    if (!bytes) continue;

    const nova = await this.save(paraAulaoId, doc.mime, bytes);
    mapa.set(String(doc._id), nova.id);
  }

  return mapa;
};
