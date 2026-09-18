const { ObjectId } = require("mongodb");
const arquivos = require("./arquivos.js");

// UMA FÁBRICA DE MODELOS DE IMAGEM — os bytes de uma foto que pertence a algo.
//
// ── Por que fábrica, e por que só agora ─────────────────────────────────
//
// Já existem três modelos assim: `BrandImage`, `AulaoImage` e
// `MembershipImage`. Cada um explica, no próprio comentário, por que NÃO
// compartilha collection com os outros — e todos dão a mesma resposta certa: a
// coleta de lixo de cada um tem um DONO DA VERDADE diferente, e juntá-los faria
// o salvamento de um apagar a foto do outro.
//
// O que eles nunca precisaram foi de CÓDIGO separado. As três cópias são a
// mesma coisa com dois nomes trocados: o da collection e o do campo que aponta
// para o dono.
//
// A unidade seria a quarta cópia. Quatro é o número em que se para de copiar.
//
// ── E por que as três antigas continuam como estão ──────────────────────
//
// Porque migrar `brand_images` e `aulao_images` agora misturaria um recurso
// novo com um refatoramento de três caminhos que já rodam — inclusive o da
// marca, que desenha a tela de login de todo mundo. Elas podem vir depois, uma
// de cada vez, com os testes delas por perto.
//
// ── PÚBLICA, e por isso o endereço é opaco ───────────────────────────────
//
// A foto sai sem sessão, e o endereço é o id do documento justamente para que
// ninguém varra endereços e liste o que existe. E ela sai por uma ROTA NOSSA:
// o balde continua privado.

// O que o navegador exibe sem plugin. SVG fica de fora: é documento
// executável, não imagem, e serviria script na nossa origem — numa rota
// pública, ainda por cima.
const MIMES = ["image/jpeg", "image/png", "image/webp"];

// Teto do que é aceito, já contando a inflação de ~33% do base64. A tela reduz
// antes de enviar; o limite existe para o que NÃO veio da tela.
const MAX_BYTES = 4 * 1024 * 1024;

// `collection` é onde os documentos moram, `dono` é o campo que aponta para
// quem é a foto, e `prefixo` é a pasta no balde.
function modeloDeImagens({ collection, dono, prefixo }) {
  function Modelo(app) {
    this.app = app;
  }

  Modelo.prototype.collection = async function () {
    const db = await this.app.mongodb.connectToServer();
    return db.collection(collection);
  };

  // "data:image/png;base64,AAAA…" → { mime, buffer } ou undefined.
  Modelo.prototype.parseDataUri = function (dataUri) {
    const match = /^data:([a-z/+-]+);base64,(.+)$/i.exec(String(dataUri || "").trim());
    if (!match) return undefined;

    const mime = match[1].toLowerCase();
    if (!MIMES.includes(mime)) return undefined;

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0 || buffer.length > MAX_BYTES) return undefined;

    return { mime, buffer };
  };

  // Insere o documento ANTES de gravar no balde porque a chave do arquivo
  // precisa do id — inventar um id nosso antes daria à imagem DOIS nomes, o do
  // balde e o do Mongo, que um dia divergiriam.
  Modelo.prototype.save = async function (donoId, mime, buffer) {
    const col = await this.collection();
    const agora = new Date();

    const r = await col.insertOne({
      [dono]: new ObjectId(donoId),
      mime,
      size: buffer.length,
      createdAt: agora,
      updatedAt: agora,
    });

    const onde = await arquivos.ondeGuardar(
      arquivos.chaveDoCliente(prefixo, String(r.insertedId)),
      buffer,
      mime
    );

    await col.updateOne({ _id: r.insertedId }, { $set: onde.set, $unset: onde.unset });

    return { id: String(r.insertedId), updatedAt: agora };
  };

  Modelo.prototype.data = async function (id) {
    if (!ObjectId.isValid(id)) return undefined;
    const col = await this.collection();
    return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
  };

  // ── A COLETA DE LIXO ────────────────────────────────────────────────────
  //
  // O dono da verdade é o DOCUMENTO salvo: a foto que ele não referencia não é
  // usada por ninguém. Recolher aqui, e não num botão de "remover imagem", é o
  // que faz quem trocou a foto três vezes não deixar duas penduradas no balde
  // para sempre.
  //
  // É a única coisa que apaga bytes deste tipo, então roda em TODA gravação do
  // dono — não só quando a foto muda.
  Modelo.prototype.pruneUnused = async function (donoId, emUso) {
    if (!ObjectId.isValid(donoId)) return 0;

    const manter = [];
    for (const ref of emUso || []) {
      // Aceita id puro e URL inteira: a tela manda o que recebeu, e o que ela
      // recebeu é a URL.
      const id = String(ref || "").split("/").pop();
      if (ObjectId.isValid(id)) manter.push(new ObjectId(id));
    }

    const col = await this.collection();
    const filtro = { [dono]: new ObjectId(donoId), _id: { $nin: manter } };

    // As chaves ANTES do delete: depois dele não há como saber quais arquivos
    // eram, e os bytes ficariam no balde para sempre — que é o problema que
    // esta função existe para resolver, um andar abaixo.
    const chaves = await col.find(filtro, { projection: { chave: 1 } }).toArray();

    const r = await col.deleteMany(filtro);
    await arquivos.apagarMuitas(chaves.map((d) => d.chave));

    return r.deletedCount;
  };

  // Tudo de um dono que foi apagado. Sem isto as imagens ficariam apontando
  // para um documento que não existe — nenhuma tela as alcançaria e nada as
  // apagaria.
  Modelo.prototype.removeAllOf = async function (donoId) {
    if (!ObjectId.isValid(donoId)) return 0;

    const col = await this.collection();
    const filtro = { [dono]: new ObjectId(donoId) };

    const chaves = await col.find(filtro, { projection: { chave: 1 } }).toArray();
    const r = await col.deleteMany(filtro);
    await arquivos.apagarMuitas(chaves.map((d) => d.chave));

    return r.deletedCount;
  };

  return Modelo;
}

module.exports = { modeloDeImagens, MIMES, MAX_BYTES };
