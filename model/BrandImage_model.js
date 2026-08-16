const { ObjectId } = require("mongodb");

// A collection `brand_images` — logo e fotos da tela de entrada.
//
// Parecida com `avatars`, mas com uma diferença que muda tudo: estas são
// PÚBLICAS. A tela de entrada aparece antes de qualquer sessão, então a imagem
// tem de sair sem login — enquanto a foto de perfil só sai para quem entrou.
//
// Daí duas consequências que estão no controller: a leitura não pede sessão, e
// o endereço é um id opaco. Um id sequencial ou o id do dono deixaria alguém
// varrer os endereços e listar quem existe.
//
// Cada imagem é um documento próprio, e não um campo do tema, porque o tema
// viaja em toda abertura da tela de login. Uma logo dentro dele seria baixada
// junto a cada visita, sem cache separado.
function BrandImage_model(app) {
  this.app = app;
}

// O que o navegador exibe sem plugin. SVG fica de fora: é documento
// executável, não imagem, e serviria script na nossa origem — numa rota
// pública, ainda por cima.
const MIMES = ["image/jpeg", "image/png", "image/webp"];

// Teto do que é aceito, já contando a inflação de ~33% do base64. A tela reduz
// antes de enviar; o limite existe para o que não veio da tela.
const MAX_BYTES = 4 * 1024 * 1024;

// O teto de quem NÃO TEM número no plano.
//
// Quem manda no limite é o plano do cliente, que mora no central (ver
// Brand.js). Este valor é o que vale sem plano, ou com o campo em branco — que
// na tela do painel se chama "ilimitado". Uma rota de upload sem teto nenhum é
// um caminho de encher o banco em laço, e o tema usa no máximo uma logo, uma
// foto e seis do carrossel.
const PADRAO_POR_CONTA = 24;

BrandImage_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("brand_images");
};

// "data:image/png;base64,AAAA…" → { mime, buffer } ou undefined.
BrandImage_model.prototype.parseDataUri = function (dataUri) {
  const match = /^data:([a-z/+-]+);base64,(.+)$/i.exec(String(dataUri || "").trim());
  if (!match) return undefined;

  const mime = match[1].toLowerCase();
  if (!MIMES.includes(mime)) return undefined;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_BYTES) return undefined;

  return { mime, buffer };
};

BrandImage_model.prototype.count = async function (userId) {
  const col = await this.collection();
  return col.countDocuments({ user: new ObjectId(userId) });
};

BrandImage_model.prototype.save = async function (userId, mime, buffer) {
  const col = await this.collection();
  const now = new Date();

  const r = await col.insertOne({
    user: new ObjectId(userId),
    mime,
    data: buffer,
    size: buffer.length,
    createdAt: now,
    updatedAt: now,
  });

  return { id: String(r.insertedId), updatedAt: now };
};

BrandImage_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

// Apaga o que o tema deixou de usar.
//
// É aqui que o lixo é recolhido, e não num botão de "remover imagem": o dono da
// verdade é o tema salvo. Quem enviou uma imagem e salvou sem usá-la não fica
// com ela pendurada, e quem trocou a logo não deixa a antiga no banco.
//
// `emUso` são as URLs do tema; o id sai do fim de cada uma.
BrandImage_model.prototype.pruneUnused = async function (userId, emUso) {
  const manter = [];
  for (const url of emUso || []) {
    const id = String(url || "").split("/").pop();
    if (ObjectId.isValid(id)) manter.push(new ObjectId(id));
  }

  const col = await this.collection();
  const r = await col.deleteMany({ user: new ObjectId(userId), _id: { $nin: manter } });
  return r.deletedCount;
};

module.exports = BrandImage_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.PADRAO_POR_CONTA = PADRAO_POR_CONTA;
