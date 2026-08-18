const { ObjectId } = require("mongodb");
const instanceContext = require("../lib/instance.js");

// O catálogo de exercícios, no banco central.
//
//   { name, nameSort, muscleGroup, videoUrl, thumbUrl, defaultTip, instance }
//
// `instance` é o dono, e ele tem dois valores possíveis:
//
//   null            — o catálogo COMPARTILHADO, igual para todo mundo;
//   "marlon"        — exercício DAQUELA conta, que só ela vê.
//
// O compartilhado nasceu de um problema real: era por profissional (campo
// `trainer`), e manter mil e quatrocentos exercícios copiados por cliente era
// guardar a mesma informação N vezes para depois ter de corrigir N vezes.
//
// Só que compartilhado por inteiro criou um beco: querer "Afundo + remada cross
// + alter" só oferecia o botão de editar o "Afundo + remada cross" — e editar
// ali mudaria o exercício de TODOS os clientes. O campo `instance` é a saída,
// e ele mora aqui, ao lado dos compartilhados, em vez de numa collection
// separada no banco da instância: assim a lista continua sendo UMA consulta,
// com a ordenação e a paginação do Mongo. Duas listas mescladas na mão dão a
// mesma tela e trazem junto o erro clássico da mescla — o item que some entre a
// página 1 e a 2.
//
// O que protege uma conta da outra é o filtro: TODA leitura e TODA escrita
// passam por `daInstancia()`, e nunca por `{_id}` sozinho.
//
// `muscleGroup` é texto livre ("Peito", "Costas", "Alongamento"…): o filtro da
// tela lista os valores realmente em uso, então a taxonomia cresce do uso em vez
// de ser fixada de antemão.
function Exercise_model(app) {
  this.app = app;
}

// Sort and search key: trimmed, lowercased and unaccented. Mongo's binary sort
// would push every capitalized name to the front, and a search for "gluteo"
// would not find "glúteo".
function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

Exercise_model.prototype.collection = async function () {
  // centralDb, e não connectToServer: este catálogo é de fora das instâncias —
  // inclusive a parte dele que pertence a uma.
  const db = await this.app.mongodb.centralDb();
  return db.collection("exercises");
};

// O que ESTA conta enxerga: o catálogo compartilhado mais o que ela criou.
//
// É a única porta de leitura. Um `findOne({_id})` solto aqui devolveria o
// exercício de outro cliente para quem soubesse o id — e ids vazam em URL, em
// log e em corpo de requisição.
//
// `$in: [null, nome]` cobre também os documentos antigos, anteriores ao campo:
// no Mongo, um campo ausente casa com `null`. Sem isso, o catálogo inteiro
// sumiria da tela no primeiro deploy.
function daInstancia() {
  return { instance: { $in: [null, instanceContext.required()] } };
}

// Só o que é MEU. Editar e apagar passam por aqui: o compartilhado é de todos e
// ninguém o altera de dentro de uma conta.
function minha() {
  return { instance: instanceContext.required() };
}

// O que ainda se OFERECE. `active: 0` é o exercício aposentado pela central —
// nome repetido, nome que não quer dizer nada, vídeo que saiu do ar.
//
// Aposentar em vez de apagar porque o catálogo compartilhado é histórico de mil
// e quatrocentas linhas: apagar é irreversível e alcança todo mundo de uma vez,
// enquanto desligar dá para voltar atrás quando o corte estiver errado.
//
// `$ne: 0` e não `active: 1`: o campo não existia até agora, e no Mongo campo
// ausente NÃO casa com `1`. Sem isso o catálogo inteiro sumiria da tela no
// primeiro deploy, que é exatamente o defeito que este filtro deveria evitar.
function ativo() {
  return { active: { $ne: 0 } };
}

// SÓ COM DEMONSTRAÇÃO.
//
// O catálogo não tem mais vídeo do YouTube: ou o exercício tem o clipe em 3D que
// nós fizemos, ou não tem demonstração nenhuma. Este filtro é o que deixa ver
// só o que já foi feito — e, na prática, também é a lista do que falta fazer,
// bastando invertê-lo.
function comDemonstracao() {
  return { clipSlug: { $exists: true, $ne: "" } };
}

// O que a tela precisa saber sobre a origem, sem precisar saber o nome da
// instância: `own` diz se este exercício é editável AQUI.
//
// É por ele que o card decide entre "Editar" (o meu, muda no lugar) e "Editar"
// como cópia (o compartilhado, que vira a minha versão). Sem a marca, a tela
// teria de comparar `instance` com um nome que ela não tem.
// A PRESCRIÇÃO padrão do exercício: como ele costuma ser feito.
//
// Um exercício não é só um nome — o profissional que criou "Remada baixa com
// triângulo" já sabe que ele entra com 4 séries de 15/12/10/8, começando em
// 90kg. Guardar isso aqui é o que faz o exercício chegar PRONTO na sessão, em
// vez de digitar as mesmas quatro linhas toda vez que ele for usado.
//
// A forma é a mesma da série dentro do treino (`unit`, `quantity`, `load`,
// `intensity`, `speed`, `rest`) de propósito: o que sai daqui é copiado direto
// para lá, sem tradução no meio — e tradução no meio é onde um campo se perde.
const MAX_SERIES = 20;

function serieLimpa(s) {
  return {
    unit: ["reps", "seconds", "minutes", "meters"].includes(String(s?.unit))
      ? String(s.unit)
      : "reps",
    quantity: String(s?.quantity ?? "").trim().slice(0, 20),
    load: String(s?.load ?? "").trim().slice(0, 20),
    intensity: String(s?.intensity ?? "").trim().slice(0, 20),
    speed: String(s?.speed ?? "").trim().slice(0, 20),
    // `rest` é a pausa MÍNIMA e `restMax` o teto — a mesma forma da série do
    // treino, porque é para lá que ela é copiada inteira.
    rest: String(s?.rest ?? "").trim().slice(0, 20),
    restMax: String(s?.restMax ?? "").trim().slice(0, 20),
  };
}

function seriesPadrao(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.slice(0, MAX_SERIES).map(serieLimpa);
}

function publico(doc) {
  if (!doc) return doc;

  const { instance, ...resto } = doc;
  return { ...resto, own: Boolean(instance) };
}

// Muscle groups in use, for the filter dropdown.
Exercise_model.prototype.groups = async function () {
  const col = await this.collection();

  const docs = await col
    .aggregate([
      { $match: { ...daInstancia(), ...ativo(), muscleGroup: { $nin: [null, ""] } } },
      { $group: { _id: "$muscleGroup", total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return docs.map((d) => ({ name: d._id, total: d.total }));
};

Exercise_model.prototype.list = async function (filter = {}) {
  const col = await this.collection();

  const query = { ...(filter.onlyMine ? minha() : daInstancia()), ...ativo() };

  if (filter.search) {
    // Search the normalized field: "gluteo" finds "glúteo". The term is escaped
    // — without it a "(" typed by the user breaks the regex.
    const term = normalize(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.nameSort = { $regex: term };
  }

  if (filter.muscleGroup) query.muscleGroup = String(filter.muscleGroup);
  if (filter.comClipe) Object.assign(query, comDemonstracao());

  const page = Math.max(1, Number(filter.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(filter.limit) || 20));

  const total = await col.countDocuments(query);
  const encontrados = await col
    .find(query)
    .sort({ nameSort: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  const rows = await comVersaoDoClipe(this.app, encontrados.map(publico));

  return { rows, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
};

// QUANDO CADA CLIPE FOI GRAVADO — e por que isso precisa viajar junto.
//
// O clipe é servido com `Cache-Control: immutable` por um ano. `immutable` é uma
// promessa ao navegador: "este endereço nunca muda de conteúdo". Só que o
// endereço é o nome do MOVIMENTO, e regravar mantém o nome — a promessa era
// mentira.
//
// O preço apareceu inteiro: o catálogo foi regravado com personagens novos,
// subiu, foi conferido byte a byte contra o servidor, e a tela mostrou os
// antigos. O navegador nem perguntou, porque foi exatamente isso que a gente
// mandou ele fazer.
//
// Aqui vai a data de gravação de cada movimento, que a tela põe no endereço como
// `?v=`. Cada versão passa a ter endereço próprio: o cache de um ano continua
// valendo — de verdade agora — e a regravação chega na hora.
//
// UMA consulta por página, e não uma por linha: a página tem 60 exercícios e
// eles se repetem em poucas dezenas de movimentos.
async function comVersaoDoClipe(app, linhas) {
  const chaves = [...new Set(linhas.map((l) => l.clipSlug).filter(Boolean))];
  if (!chaves.length) return linhas;

  const db = await app.mongodb.centralDb();
  const clipes = await db
    .collection("exercise_clips")
    // Sem o binário: são 70 KB por clipe, e o que se quer aqui é uma data.
    .find({ _id: { $in: chaves } }, { projection: { updatedAt: 1 } })
    .toArray();

  const quando = Object.fromEntries(clipes.map((c) => [c._id, c.updatedAt]));

  return linhas.map((l) =>
    l.clipSlug && quando[l.clipSlug] ? { ...l, clipV: new Date(quando[l.clipSlug]).getTime() } : l
  );
}

// Um exercício pelo id, INCLUSIVE o aposentado.
//
// De propósito: a lista deixa de oferecê-lo, mas o treino que já o usa continua
// abrindo. Filtrar por `ativo()` aqui faria a tela de um treino montado ontem
// perder o exercício hoje, por causa de uma limpeza de catálogo que não tem nada
// a ver com aquele aluno.
Exercise_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id), ...daInstancia() });
  return doc ? publico(doc) : undefined;
};

// O clipe da demonstração, em bytes.
//
// Guardado UMA VEZ por padrão de movimento, e não por exercício. O catálogo tem
// "Rosca direta articulada", "Rosca direta barra h", "Rosca direta cross" — e
// todas mostram o mesmo cotovelo dobrando. Um binário por documento repetiria os
// mesmos 70 KB dezenas de vezes; a chave (`clipSlug`) custa vinte bytes.
//
// Lido por rota pública (a tag `<img>` não manda cabeçalho de sessão), e pode
// ser: é um boneco fazendo agachamento, igual para todo cliente, sem nome nem
// foto de ninguém.
Exercise_model.prototype.clip = async function (slug) {
  const chave = String(slug || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{2,60}$/.test(chave)) return undefined;

  const db = await this.app.mongodb.centralDb();
  const doc = await db.collection("exercise_clips").findOne({ _id: chave });
  if (!doc?.webp) return undefined;

  // `Buffer.isBuffer` PRIMEIRO, e o teste é que mostrou por quê: um Buffer do
  // Node também tem `.buffer` — só que ele aponta para o pool inteiro de 8 KB
  // que o Node reaproveita. `Buffer.from(b.buffer)` devolveria oito mil zeros no
  // lugar da imagem. O `Binary` do BSON é que precisa do desembrulho.
  const bruto = doc.webp;
  const dados = Buffer.isBuffer(bruto) ? bruto : Buffer.from(bruto.buffer ?? bruto);

  return { dados, quando: doc.updatedAt || null };
};

// Thumbnail derived from the video URL when possible. YouTube covers most
// cases; anything else stays without an image.
function thumbnailFromVideo(videoUrl) {
  if (!videoUrl) return null;
  const yt = String(videoUrl).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/
  );
  return yt ? `https://img.youtube.com/vi/${yt[1]}/mqdefault.jpg` : null;
}

Exercise_model.prototype.insert = async function (obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    name: String(obj.name).trim(),
    nameSort: normalize(obj.name),
    muscleGroup: obj.muscleGroup ? String(obj.muscleGroup).trim() : "",
    videoUrl: obj.videoUrl ? String(obj.videoUrl).trim() : "",
    thumbUrl: thumbnailFromVideo(obj.videoUrl),
    defaultTip: obj.defaultTip ? String(obj.defaultTip).trim() : "",

    // Como este exercício costuma ser prescrito. Vazio é o normal — quem não
    // preencher continua adicionando com uma série em branco, como antes.
    defaultMethod: obj.defaultMethod ? String(obj.defaultMethod).trim().slice(0, 40) : "",
    defaultGoal: obj.defaultGoal ? String(obj.defaultGoal).trim().slice(0, 120) : "",
    defaultSets: seriesPadrao(obj.defaultSets),

    // Nasce SEMPRE da conta que criou. Não há caminho no app para escrever no
    // catálogo compartilhado: ele é semeado de fora.
    instance: instanceContext.required(),
    // Nasce em pé. Quem aposenta é a central, e ela precisa do campo escrito
    // para poder filtrar por "desativados" sem varrer o que nunca teve o campo.
    active: 1,
    // De qual exercício compartilhado esta variação saiu, quando saiu de um.
    // Não muda comportamento nenhum — responde "de onde veio isto?" depois de o
    // nome já ter sido alterado três vezes.
    fromCatalog: ObjectId.isValid(obj.fromCatalog) ? new ObjectId(obj.fromCatalog) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Exercise_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  if (obj.name !== undefined) {
    set.name = String(obj.name).trim();
    set.nameSort = normalize(obj.name);
  }
  if (obj.muscleGroup !== undefined) set.muscleGroup = String(obj.muscleGroup).trim();
  if (obj.defaultTip !== undefined) set.defaultTip = String(obj.defaultTip).trim();
  if (obj.videoUrl !== undefined) {
    set.videoUrl = String(obj.videoUrl).trim();
    set.thumbUrl = thumbnailFromVideo(obj.videoUrl);
  }

  if (obj.defaultMethod !== undefined) {
    set.defaultMethod = String(obj.defaultMethod).trim().slice(0, 40);
  }
  if (obj.defaultGoal !== undefined) set.defaultGoal = String(obj.defaultGoal).trim().slice(0, 120);
  if (obj.defaultSets !== undefined) set.defaultSets = seriesPadrao(obj.defaultSets);

  // `minha`, e não `{_id}`: o compartilhado é de todos os clientes, e uma conta
  // não o altera. Quem quer uma variação cria a sua — é o que a tela oferece.
  const r = await col.updateOne({ _id: new ObjectId(id), ...minha() }, { $set: set });
  return r.matchedCount > 0;
};

Exercise_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), ...minha() });
  return r.deletedCount > 0;
};

module.exports = Exercise_model;
