const { ObjectId } = require("mongodb");
const arquivos = require("../lib/arquivos.js");
const { MIMES, parseImageDataUri } = require("../lib/imageDataUri.js");
const instanceContext = require("../lib/instance.js");

// A collection `avatars` — a foto de perfil de cada conta.
//
// Fica SEPARADA do usuário de propósito. No documento da pessoa, a imagem
// viajaria junto em todo login, em todo /me e em toda listagem: uma lista de
// 50 pessoas carregaria 50 fotos que a tela mostra em 40 pixels. Aqui ela é
// buscada por uma URL própria, que o navegador cacheia.
//
// A imagem chega já cortada e reduzida pelo navegador (512×512, JPEG), então
// são dezenas de KB — perto do limite de 16 MB de um documento do Mongo, não
// há por que envolver disco, bucket ou limpeza de arquivo órfão.
function Avatar_model(app) {
  this.app = app;
}

// Teto do que é aceito, já contando a inflação de ~33% do base64. A tela envia
// bem menos que isso; o limite existe para o que não veio da tela.
const MAX_BYTES = 2 * 1024 * 1024;

Avatar_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("avatars");
};

// "data:image/jpeg;base64,AAAA…" → { mime, buffer } ou undefined.
//
// A leitura em si é compartilhada com as outras imagens do sistema; o que é
// desta é o teto de tamanho.
Avatar_model.prototype.parseDataUri = function (dataUri) {
  return parseImageDataUri(dataUri, MAX_BYTES);
};

Avatar_model.prototype.save = async function (userId, mime, buffer) {
  const col = await this.collection();
  const now = new Date();

  // Os bytes vão para `<instancia>/avatares/<usuario>` no R2 — ver
  // lib/arquivos.js.
  const onde = await arquivos.ondeGuardar(
    arquivos.chaveDoCliente("avatares", String(userId)),
    buffer,
    mime
  );

  await col.updateOne(
    { user: new ObjectId(userId) },
    {
      $set: {
        user: new ObjectId(userId),
        mime,
        size: buffer.length,
        updatedAt: now,
        ...onde.set,
      },
      $unset: onde.unset,
    },
    { upsert: true },
  );

  // A data fica TAMBÉM no usuário porque é o que as telas já carregam: é ela
  // que diz se existe foto e serve de versão na URL, para o cache do
  // navegador soltar a antiga quando trocar.
  const users = await this.app.api.user.collection();
  await users.updateOne({ _id: new ObjectId(userId) }, { $set: { avatarAt: now } });

  // O espelho na central leva os BYTES, e não a chave: são bancos diferentes, e
  // uma chave do bucket deste cliente não significa nada do outro lado.
  await this.espelhar(userId, { mime, data: buffer, size: buffer.length, avatarAt: now });

  return now;
};

// ── A CÓPIA NA CENTRAL ────────────────────────────────────────────────────
//
// A foto desta instância continua sendo a desta instância — é ela que o web e
// o app mostram. O que sobe para a central é uma cópia, para o painel conseguir
// pôr rosto no e-mail.
//
// NUNCA derruba a operação principal. Espelho é conveniência: se a central
// estiver fora, a foto foi salva do mesmo jeito e quem olha o painel vê a
// anterior. Falhar aqui e devolver erro faria a pessoa achar que a troca não
// funcionou, quando funcionou.
Avatar_model.prototype.espelhar = async function (userId, { mime, data, size, avatarAt }) {
  try {
    const users = await this.app.api.user.collection();
    const dono = await users.findOne({ _id: new ObjectId(userId) }, { projection: { email: 1 } });
    if (!dono || !dono.email) return;

    const instancia = instanceContext.current();

    if (data) {
      await this.app.api.allUser.espelharFoto(dono.email, { mime, data, size, instance: instancia });
    } else {
      await this.app.api.allUser.apagarFotoEspelhada(dono.email, instancia);
    }

    // O carimbo entra no índice também: é por ele que o painel sabe que a
    // pessoa tem foto sem precisar carregar a imagem para descobrir.
    await this.app.api.allUser.espelhar(dono.email, {
      avatarAt: avatarAt ?? null,
      instance: instancia,
    });
  } catch (erro) {
    console.error("[avatar] não consegui espelhar na central:", erro.message);
  }
};

Avatar_model.prototype.data = async function (userId) {
  if (!ObjectId.isValid(userId)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ user: new ObjectId(userId) });
  return doc || undefined;
};

Avatar_model.prototype.delete = async function (userId) {
  const col = await this.collection();
  const r = await col.deleteOne({ user: new ObjectId(userId) });

  const users = await this.app.api.user.collection();
  await users.updateOne({ _id: new ObjectId(userId) }, { $unset: { avatarAt: "" } });

  await this.espelhar(userId, { data: null, avatarAt: null });

  return r.deletedCount > 0;
};

module.exports = Avatar_model;
module.exports.MIMES = MIMES;
module.exports.MAX_BYTES = MAX_BYTES;
