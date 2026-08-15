const { ObjectId } = require("mongodb");
const { parseDataUri } = require("../lib/imageDataUri.js");

// As conversas entre as contas de um cliente.
//
//   conversations → a linha da lista: quem conversa com quem, e o resumo
//   messages      → cada mensagem
//
// Duas collections, e não mensagens dentro da conversa como as refeições ficam
// dentro da dieta. A diferença é o CRESCIMENTO: um plano alimentar tem sete
// refeições e para por aí; uma conversa de um ano tem milhares de mensagens e
// estouraria o teto de 16 MB de um documento — e, muito antes disso, faria toda
// leitura da lista carregar o histórico inteiro de todo mundo.
//
// O que fica na conversa é só o RESUMO — última mensagem, quando, de quem, e
// quantas cada participante não leu. É o que a lista mostra, e é o que evita
// uma consulta às mensagens por linha desenhada.
//
// Conversa é sempre entre DUAS contas. Grupo não existe aqui: ele muda a
// modelagem de "não lido" de um número por conversa para um por participante, e
// não é o que o profissional precisa para falar com quem acompanha.
function Chat_model(app) {
  this.app = app;
}

Chat_model.prototype.conversations = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("conversations");
};

Chat_model.prototype.messages = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("messages");
};

// Os BYTES dos anexos, fora do documento da mensagem.
//
// Mesmo motivo do avatar e das fotos de evolução: dentro da mensagem, cada
// abertura da conversa baixaria todos os anexos dela de uma vez — quarenta
// mensagens, quarenta imagens — para desenhar uma tela em que talvez nenhuma
// esteja visível. Aqui cada um tem a própria URL, que o navegador cacheia.
//
// No documento da mensagem fica só a FICHA: nome, tipo, tamanho e categoria. É
// o suficiente para desenhar o balão e decidir se é imagem, áudio ou arquivo.
Chat_model.prototype.files = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("message_files");
};

// Os dois participantes SEMPRE na mesma ordem, ordenados pelo id.
//
// Sem ordenar, `[a, b]` e `[b, a]` seriam dois documentos para a mesma
// conversa, e cada lado veria metade das mensagens.
function par(a, b) {
  const ids = [String(a), String(b)].sort();
  return ids.map((id) => new ObjectId(id));
}

// A chave da dupla: os dois ids ordenados, num texto só.
//
// Existe porque a unicidade NÃO pode ser expressa sobre `members`. Índice único
// em campo de array no MongoDB é multikey: ele exige que cada ELEMENTO seja
// único na collection inteira — o que significaria "cada pessoa participa de no
// máximo uma conversa". A segunda conversa de qualquer um batia em chave
// duplicada, e a rota respondia erro interno.
//
// Um escalar derivado resolve sem ambiguidade: "uma conversa por par" vira
// literalmente um valor único por par.
function chaveDoPar(membros) {
  return membros.map(String).join("_");
}

const TAMANHO_MAXIMO = 5000;

// O que pode ser anexado, por categoria.
//
// Lista fechada, e a categoria decide COMO o arquivo é servido depois: imagem e
// áudio abrem na tela, o resto baixa. Um tipo fora daqui é recusado — servir
// arquivo arbitrário da nossa origem é o caminho mais curto para transformar
// uma conversa em vetor de ataque.
const TIPOS = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  audio: ["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-m4a"],
  file: [
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
};

const TIPOS_ACEITOS = [...TIPOS.image, ...TIPOS.audio, ...TIPOS.file];

// Uma imagem já reduzida pelo navegador tem centenas de KB; um áudio de dois
// minutos em opus, pouco mais que isso; um PDF de exame, alguns MB. O teto
// existe para o que NÃO veio da tela.
const ANEXO_MAXIMO = 10 * 1024 * 1024;

function categoriaDe(mime) {
  if (TIPOS.image.includes(mime)) return "image";
  if (TIPOS.audio.includes(mime)) return "audio";
  return "file";
}

// O nome do arquivo, limpo.
//
// Só o nome, sem caminho: um "../../etc/passwd" que chegue daqui não pode virar
// caminho em lugar nenhum — e mesmo guardando em banco, o nome volta para a
// tela e vira o nome do download.
function nomeLimpo(valor, mime) {
  const bruto = String(valor || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 120);

  if (bruto) return bruto;

  // Áudio gravado na hora não tem nome de arquivo: ele nasce do microfone.
  return categoriaDe(mime) === "audio" ? "audio" : "arquivo";
}

Chat_model.prototype.parseAttachment = function (anexo) {
  if (!anexo || !anexo.dataUri) return undefined;

  const lido = parseDataUri(anexo.dataUri, {
    maxBytes: ANEXO_MAXIMO,
    mimes: TIPOS_ACEITOS,
  });
  if (!lido) return undefined;

  return {
    mime: lido.mime,
    buffer: lido.buffer,
    ficha: {
      name: nomeLimpo(anexo.name, lido.mime),
      mime: lido.mime,
      size: lido.buffer.length,
      kind: categoriaDe(lido.mime),
      // Só para áudio, e só se a tela mandar: é a duração que o balão mostra
      // antes de tocar, e não dá para descobrir sem decodificar o arquivo.
      seconds: Number(anexo.seconds) > 0 ? Math.round(Number(anexo.seconds)) : null,
    },
  };
};

function textoLimpo(valor) {
  return String(valor === undefined || valor === null ? "" : valor)
    .trim()
    .slice(0, TAMANHO_MAXIMO);
}

// A conversa entre duas contas, criando na primeira vez.
//
// `upsert` em vez de "procura, se não achar cria": dois cliques ao mesmo tempo
// — a tela do profissional e a do cliente abrindo juntas — criariam duas
// conversas para o mesmo par, e o índice único as recusaria com erro em vez de
// devolver a que já existe.
Chat_model.prototype.openWith = async function (userId, otherId) {
  const col = await this.conversations();
  const membros = par(userId, otherId);
  const pairKey = chaveDoPar(membros);

  try {
    await col.updateOne(
      { pairKey },
      {
        $setOnInsert: {
          pairKey,
          members: membros,
          lastMessage: "",
          lastFrom: null,
          lastAt: null,
          unread: {},
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (erro) {
    // 11000 aqui é a corrida que o upsert existe para tratar e não trata
    // sozinho: dois pedidos chegando juntos passam os dois pela verificação de
    // existência e um dos dois insere depois do outro. A conversa que o
    // perdedor queria existe — é a que o vencedor acabou de criar.
    if (erro?.code !== 11000) throw erro;
  }

  return await col.findOne({ pairKey });
};

Chat_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.conversations();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// Participar é a única autorização que existe aqui.
//
// Não basta ter permissão de chat: ter a permissão deixa a pessoa conversar, não
// deixa ler a conversa dos outros. Toda rota de conversa passa por aqui.
Chat_model.prototype.isMember = function (conversation, userId) {
  return (conversation?.members || []).some((m) => String(m) === String(userId));
};

Chat_model.prototype.otherOf = function (conversation, userId) {
  return (conversation?.members || []).find((m) => String(m) !== String(userId));
};

// As conversas de uma conta, da mais recente para a mais antiga.
//
// Ordenadas por `lastAt` e não por criação: a lista serve para retomar, e o que
// se retoma é o que acabou de chegar. Conversa sem mensagem nenhuma cai no fim
// por `createdAt`, que é onde ela deve ficar.
Chat_model.prototype.listOf = async function (userId, { limit = 30, skip = 0 } = {}) {
  const col = await this.conversations();

  return await col
    .find({ members: new ObjectId(userId) })
    .sort({ lastAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
};

Chat_model.prototype.countOf = async function (userId) {
  const col = await this.conversations();
  return await col.countDocuments({ members: new ObjectId(userId) });
};

// Quantas mensagens não lidas a conta tem no total. É o número da bolinha.
Chat_model.prototype.unreadTotal = async function (userId) {
  const col = await this.conversations();

  const [linha] = await col
    .aggregate([
      { $match: { members: new ObjectId(userId) } },
      { $group: { _id: null, total: { $sum: { $ifNull: [`$unread.${userId}`, 0] } } } },
    ])
    .toArray();

  return linha?.total || 0;
};

// As mensagens de uma conversa, da mais nova para a mais antiga.
//
// Paginadas por CURSOR (`before`), não por página numerada. Numa conversa que
// recebe mensagem enquanto se lê, a página 2 muda de conteúdo a cada chegada e
// a rolagem repete ou pula linhas; um corte por data não se move.
Chat_model.prototype.messagesOf = async function (conversationId, { before, limit = 40 } = {}) {
  if (!ObjectId.isValid(conversationId)) return [];
  const col = await this.messages();

  const filtro = { conversation: new ObjectId(conversationId) };
  if (before) filtro.createdAt = { $lt: new Date(before) };

  const docs = await col.find(filtro).sort({ createdAt: -1 }).limit(limit).toArray();

  // Devolvidas em ordem de LEITURA — a mais antiga primeiro. A busca é ao
  // contrário porque o que interessa é o fim da conversa; a tela desenha de
  // cima para baixo.
  return docs.reverse();
};

Chat_model.prototype.send = async function (conversationId, fromId, body, anexo) {
  const texto = textoLimpo(body);

  // Uma das duas coisas basta: manda-se um texto, ou um arquivo, ou os dois —
  // uma foto com legenda. O que não existe é mensagem sem nenhum dos dois.
  if (!texto && !anexo) return undefined;

  const conversa = await this.data(conversationId);
  if (!conversa) return undefined;

  const msgs = await this.messages();
  const agora = new Date();

  const r = await msgs.insertOne({
    conversation: new ObjectId(conversationId),
    from: new ObjectId(fromId),
    body: texto,
    file: anexo ? anexo.ficha : null,
    createdAt: agora,
  });

  if (anexo) {
    const arquivos = await this.files();
    await arquivos.insertOne({
      message: r.insertedId,
      conversation: new ObjectId(conversationId),
      mime: anexo.mime,
      name: anexo.ficha.name,
      size: anexo.ficha.size,
      data: anexo.buffer,
      createdAt: agora,
    });
  }

  // O contador sobe só para o OUTRO: quem escreveu já leu o que escreveu.
  const destino = this.otherOf(conversa, fromId);

  const alteracao = {
    $set: {
      lastMessage: texto,
      // A categoria do anexo, para a lista escrever "Imagem" ou "Áudio" quando
      // a mensagem não tem texto. Guardada como CHAVE e não como frase: quem
      // traduz é a tela, e o mesmo banco serve quatro idiomas.
      lastKind: anexo ? anexo.ficha.kind : null,
      lastFrom: new ObjectId(fromId),
      lastAt: agora,
    },
  };

  // `$inc` só entra se houver a quem incrementar: o MongoDB recusa um operador
  // vazio com erro, e uma conversa sem o outro lado — documento antigo, conta
  // apagada — derrubaria o envio em vez de só não contar.
  if (destino) alteracao.$inc = { [`unread.${destino}`]: 1 };

  const col = await this.conversations();
  await col.updateOne({ _id: new ObjectId(conversationId) }, alteracao);

  return await msgs.findOne({ _id: r.insertedId });
};

// Zera o não lido de quem abriu a conversa.
//
// Zera, e não decrementa: a tela não sabe quantas mensagens couberam na janela,
// e "abri a conversa" significa que a pessoa viu o que havia.
Chat_model.prototype.markRead = async function (conversationId, userId) {
  if (!ObjectId.isValid(conversationId)) return false;
  const col = await this.conversations();

  const r = await col.updateOne(
    { _id: new ObjectId(conversationId), members: new ObjectId(userId) },
    { $set: { [`unread.${userId}`]: 0 } }
  );

  return r.matchedCount > 0;
};

// O arquivo de uma mensagem, com os bytes. A conversa vem junto para a rota
// poder conferir participação sem uma segunda consulta.
Chat_model.prototype.fileOf = async function (messageId) {
  if (!ObjectId.isValid(messageId)) return undefined;
  const arquivos = await this.files();

  const doc = await arquivos.findOne({ message: new ObjectId(messageId) });
  return doc || undefined;
};

// Apagadas junto com a pessoa, como treinos, dietas e avaliações. Os arquivos
// primeiro, depois as mensagens, depois as conversas: cada um aponta para o
// seguinte, e apagar de trás para frente deixaria órfãos que ninguém encontra.
Chat_model.prototype.deleteAllOfUser = async function (userId) {
  if (!ObjectId.isValid(userId)) return 0;

  const col = await this.conversations();
  const conversas = await col
    .find({ members: new ObjectId(userId) }, { projection: { _id: 1 } })
    .toArray();

  if (conversas.length) {
    const ids = conversas.map((c) => c._id);

    const arquivos = await this.files();
    await arquivos.deleteMany({ conversation: { $in: ids } });

    const msgs = await this.messages();
    await msgs.deleteMany({ conversation: { $in: ids } });
  }

  const r = await col.deleteMany({ members: new ObjectId(userId) });
  return r.deletedCount || 0;
};

module.exports = Chat_model;
module.exports.TAMANHO_MAXIMO = TAMANHO_MAXIMO;
