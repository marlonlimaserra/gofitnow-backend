const { ObjectId } = require("mongodb");
const arquivos = require("../lib/arquivos.js");

// A CAPA DE UM PLANO — a foto no topo do cartão da vitrine.
//
// Pedido do Marlon em 17/09/2026, com a página da Smart Fit ao lado: *"em cada
// plano, permita escolher uma foto de capa pra ficar no topo"*.
//
// ── Por que não reusar `brand_images` nem `aulao_images` ─────────────────
//
// Da marca, pela razão que já separou a do aulão: `BrandImage_model.pruneUnused`
// apaga tudo o que o tema salvo não referencia, e a capa de um plano não está no
// tema. Compartilhar faria o primeiro salvamento de aparência apagar a capa de
// todos os planos, sem erro e sem log.
//
// Do aulão, porque a coleta de lixo dela tem OUTRO dono da verdade (o documento
// do aulão). Duas verdades diferentes pedem duas collections — foi exatamente o
// raciocínio que criou a do aulão, e ele vale de novo.
//
// ── PÚBLICA, e por isso o endereço é opaco ───────────────────────────────
//
// A vitrine é lida por quem ainda não é cliente, dentro de um iframe no site da
// academia. A imagem sai sem sessão, e o endereço é o id do documento
// justamente para que ninguém varra endereços e liste o que existe.
//
// E ela sai por uma ROTA NOSSA, não por URL de bucket: o balde continua privado.
function MembershipImage_model(app) {
  this.app = app;
}

// O que o navegador exibe sem plugin. SVG fica de fora: é documento executável,
// não imagem, e serviria script na nossa origem — numa rota pública, ainda por
// cima. Mesma lista das outras duas, e pela mesma razão.
const MIMES = ["image/jpeg", "image/png", "image/webp"];

// Teto do que é aceito, já contando a inflação de ~33% do base64. A tela reduz
// antes de enviar; o limite existe para o que não veio da tela.
const MAX_BYTES = 4 * 1024 * 1024;

MembershipImage_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("membership_images");
};

// "data:image/png;base64,AAAA…" → { mime, buffer } ou undefined.
MembershipImage_model.prototype.parseDataUri = function (dataUri) {
  const match = /^data:([a-z/+-]+);base64,(.+)$/i.exec(String(dataUri || "").trim());
  if (!match) return undefined;

  const mime = match[1].toLowerCase();
  if (!MIMES.includes(mime)) return undefined;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_BYTES) return undefined;

  return { mime, buffer };
};

// Guarda os bytes e devolve o id que vira endereço.
//
// Insere o documento ANTES de gravar no bucket porque a chave do arquivo precisa
// do id — inventar um id nosso antes daria à imagem DOIS nomes, o do bucket e o
// do Mongo, que um dia divergiriam. Mesmo arranjo das outras duas.
MembershipImage_model.prototype.save = async function (membershipId, mime, buffer) {
  const col = await this.collection();
  const agora = new Date();

  const r = await col.insertOne({
    membership: new ObjectId(membershipId),
    mime,
    size: buffer.length,
    createdAt: agora,
    updatedAt: agora,
  });

  const onde = await arquivos.ondeGuardar(
    arquivos.chaveDoCliente("planos", String(r.insertedId)),
    buffer,
    mime
  );

  await col.updateOne({ _id: r.insertedId }, { $set: onde.set, $unset: onde.unset });

  return { id: String(r.insertedId), updatedAt: agora };
};

MembershipImage_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

// ── A COLETA DE LIXO ──────────────────────────────────────────────────────
//
// O dono da verdade é o PLANO salvo: a capa que ele não referencia não é usada
// por ninguém. Recolher aqui, e não num botão de "remover imagem", é o que faz
// quem trocou a capa três vezes não deixar duas penduradas no bucket para
// sempre.
//
// É a única coisa que apaga bytes deste tipo, então ela roda em toda gravação de
// plano — não só quando a capa muda.
MembershipImage_model.prototype.pruneUnused = async function (membershipId, emUso) {
  if (!ObjectId.isValid(membershipId)) return 0;

  const manter = [];
  for (const ref of emUso || []) {
    // Aceita id puro e URL inteira: a tela manda o que recebeu, e o que ela
    // recebeu é a URL.
    const id = String(ref || "").split("/").pop();
    if (ObjectId.isValid(id)) manter.push(new ObjectId(id));
  }

  const col = await this.collection();
  const filtro = { membership: new ObjectId(membershipId), _id: { $nin: manter } };

  // As chaves ANTES do delete: depois dele não há como saber quais arquivos
  // eram, e os bytes ficariam no bucket para sempre — que é o problema que esta
  // função existe para resolver, um andar abaixo.
  const chaves = await col.find(filtro, { projection: { chave: 1 } }).toArray();

  const r = await col.deleteMany(filtro);
  await arquivos.apagarMuitas(chaves.map((d) => d.chave));

  return r.deletedCount;
};

// Tudo de um plano que foi apagado. Sem isto as imagens ficariam apontando para
// um plano que não existe — nenhuma tela as alcançaria e nada as apagaria.
MembershipImage_model.prototype.removeAllOf = async function (membershipId) {
  if (!ObjectId.isValid(membershipId)) return 0;

  const col = await this.collection();
  const filtro = { membership: new ObjectId(membershipId) };

  const chaves = await col.find(filtro, { projection: { chave: 1 } }).toArray();
  const r = await col.deleteMany(filtro);
  await arquivos.apagarMuitas(chaves.map((d) => d.chave));

  return r.deletedCount;
};

module.exports = MembershipImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
