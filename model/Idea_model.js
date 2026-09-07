const { ObjectId } = require("mongodb");

// AS IDEIAS, do lado de quem sugere e vota.
//
// *"Gostaria de um botão para ver ideias, e poder sugerir ideias."*
//
// ── TUDO MORA NO CENTRAL, e a razão é o NÚMERO ────────────────────────────
//
// Uma ideia é sobre o produto, e o produto é um só. Com a lista no banco de cada
// cliente, o voto do Willian não somaria com o da Bruna, e o contador diria
// "quantos querem isto dentro da minha academia" — que não prioriza nada.
//
// Mesma escolha dos chamados e da FAQ (ver Support_model.js), e pelo mesmo
// motivo: `centralDb()`.
//
// ── E O CENTRAL NÃO TEM ESCOPO ────────────────────────────────────────────
//
// `lib/escopo.js` injeta `instance` em todo filtro do banco do CLIENTE. O
// central não passa por ele. Então toda consulta daqui que fale de uma pessoa
// carrega a instância à mão — e é por isso que `quem` é sempre
// `{ instance, userId, nome }`, e não um id solto.
//
// ── O FORMATO DO DOCUMENTO ESTÁ ESCRITO DOS DOIS LADOS ────────────────────
//
// `IdeaPost_model.js` do center-backend é o outro lado disto, e é lá que ficam a
// resposta oficial e o estado. A tentação era importar de lá; são dois deploys
// com dois `package.json`, e um `require` atravessando projetos quebra no
// primeiro deploy de um só. O que se compartilha é o FORMATO — a mesma decisão
// que o suporte já tomou.
function Idea_model(app) {
  this.app = app;
}

const MAX_TITULO = 160;
const MAX_DETALHES = 4000;
const MAX_COMENTARIO = 2000;

// Os mesmos cinco do painel. Aqui eles só são LIDOS: quem dá estado a uma ideia
// é quem vai fazê-la.
const EM_ABERTO = ["aberta", "planejada", "fazendo"];

// ── QUANTAS IDEIAS UMA PESSOA PODE ABRIR POR DIA ──────────────────────────
//
// Dez, e é um teto de abuso, não de generosidade. O quadro é público a todos os
// clientes: uma pessoa com um script abriria mil ideias e enterraria as de todo
// mundo, e o estrago não é o banco — é o quadro deixar de servir para priorizar.
//
// Por DIA e não total: quem tem dez ideias boas em dois meses deve poder
// escrevê-las todas.
const POR_DIA = 10;

// ── E QUANTOS COMENTÁRIOS ─────────────────────────────────────────────────
//
// Trinta por dia, por pessoa. Bem mais folgado que o das ideias, e de propósito:
// comentar é a coisa que se quer que aconteça — *"quero que as pessoas
// comentem"* — e uma conversa de verdade sobre três ideias passa de dez
// mensagens sem esforço.
//
// O teto continua existindo porque o fio é público a todos os clientes: um
// script despejando mil linhas não enche o banco, ele torna a ideia ilegível, e
// ilegível é o mesmo que apagada.
const COMENTARIOS_POR_DIA = 30;

function texto(v, max) {
  return String(v ?? "").trim().slice(0, max);
}

// O MESMO `texto`, com outro nome. As funções de comentário recebem um parâmetro
// chamado `texto`, e ali dentro o nome do parâmetro esconderia o da função — o
// erro apareceria como "texto is not a function", só quando alguém comentasse.
const limpar = texto;

Idea_model.prototype.collection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("idea_posts");
};

Idea_model.prototype.votos = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("idea_votes");
};

Idea_model.prototype.comentarios = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("idea_comments");
};

// ── A LISTA ───────────────────────────────────────────────────────────────
//
// FALHA ABERTA em lista vazia, como a FAQ: o central fora do ar não pode
// derrubar a tela de ajuda, que é justamente onde a pessoa vai quando alguma
// coisa está fora do ar.
Idea_model.prototype.listar = async function (quem, { ordem, busca, estado } = {}) {
  try {
    const col = await this.collection();

    const filtro =
      estado === "todas" ? {} : { status: { $in: EM_ABERTO } };

    const termo = texto(busca, 80);
    if (termo) {
      // O escape não é enfeite: um `(` digitado na busca viraria regexp
      // inválida e 500 na cara de quem só queria procurar.
      const seguro = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filtro.$or = [
        { titulo: { $regex: seguro, $options: "i" } },
        { detalhes: { $regex: seguro, $options: "i" } },
      ];
    }

    const sort = ordem === "novas" ? { criadoEm: -1 } : { votos: -1, criadoEm: -1 };

    const rows = await col
      .find(filtro, {
        // A INSTÂNCIA DE QUEM SUGERIU NÃO SAI DAQUI. Ela é o que separa um
        // cliente do outro no central, e mandá-la contaria a um cliente quem são
        // os outros. Só o nome vai, que é o que a tela mostra.
        projection: {
          titulo: 1,
          detalhes: 1,
          status: 1,
          votos: 1,
          comentarios: 1,
          resposta: 1,
          criadoEm: 1,
          "autor.nome": 1,
        },
      })
      .sort(sort)
      .limit(60)
      .toArray();

    return await this.comMeuVoto(rows, quem);
  } catch (erro) {
    return [];
  }
};

// Marca, em cada linha, se fui EU que votei — numa consulta só.
//
// Uma por linha seriam sessenta idas ao banco para desenhar uma tela. E sem esta
// marca, todos os botões nasceriam apagados e a pessoa votaria de novo no que já
// apoiou — o voto é alternado, então o segundo clique DESFARIA o primeiro.
Idea_model.prototype.comMeuVoto = async function (rows, quem) {
  if (!rows.length || !quem?.instance || !quem?.userId) {
    return rows.map((r) => ({ ...r, votei: false }));
  }

  const votos = await this.votos();
  const meus = await votos
    .find({
      idea: { $in: rows.map((r) => r._id) },
      instance: quem.instance,
      userId: String(quem.userId),
    })
    .project({ idea: 1 })
    .toArray();

  const votei = new Set(meus.map((v) => String(v.idea)));
  return rows.map((r) => ({ ...r, votei: votei.has(String(r._id)) }));
};

Idea_model.prototype.data = async function (id, quem) {
  if (!ObjectId.isValid(id)) return null;

  try {
    const col = await this.collection();
    const doc = await col.findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          titulo: 1,
          detalhes: 1,
          status: 1,
          votos: 1,
          comentarios: 1,
          resposta: 1,
          criadoEm: 1,
          "autor.nome": 1,
        },
      }
    );
    if (!doc) return null;

    const [comVoto] = await this.comMeuVoto([doc], quem);

    // QUEM VOTOU — as caras do print. Doze no máximo: a lista serve para dar
    // peso ao número, não para virar um diretório de clientes. Só o nome.
    const votos = await this.votos();
    const votantes = await votos
      .find({ idea: new ObjectId(id) })
      .sort({ criadoEm: 1 })
      .limit(12)
      .project({ nome: 1 })
      .toArray();

    // O FIO VEM COM A IDEIA ABERTA, e não com a lista.
    //
    // Na lista vai só o número (`comentarios`, gravado no post). Sessenta ideias
    // com catorze comentários cada seriam oitocentos documentos para desenhar
    // uma tela onde se leem três.
    //
    // ── O FIO SE CHAMA `fio`, E NÃO `comentarios` ─────────────────────────
    //
    // Chamá-lo de `comentarios` fazia o MESMO campo ser um número na lista e uma
    // lista aqui. A tela mistura os dois (abre com o que a linha tem e completa
    // com esta resposta), então `idea.comentarios` seria 3 antes de abrir e um
    // array depois — e o contador mostraria `[object Object]` ou nada, sem erro
    // em lugar nenhum. Nomes diferentes para tipos diferentes.
    return {
      ...comVoto,
      votantes: votantes.map((v) => v.nome).filter(Boolean),
      fio: await this.comentariosDe(id, quem),
    };
  } catch (erro) {
    return null;
  }
};

// ── LER O FIO ─────────────────────────────────────────────────────────────
//
// `meu` diz quais linhas ESTA pessoa pode apagar. Ela vai no documento e não é
// calculada na tela: a tela não tem o `userId` de quem está logado (a sessão é
// um cabeçalho, não um objeto que ela leia), e mandar o id para ela comparar
// seria mandar um dado a mais para o mesmo resultado.
//
// E o `userId` do autor NÃO sai daqui, como a instância também não: quem lê
// recebe nome, texto, data, a marca de oficial e se pode apagar.
Idea_model.prototype.comentariosDe = async function (id, quem) {
  if (!ObjectId.isValid(id)) return [];

  const comentarios = await this.comentarios();
  const rows = await comentarios
    .find({ idea: new ObjectId(id) })
    .sort({ criadoEm: 1 })
    .limit(200)
    .toArray();

  const limpo = rows.map((c) => ({
    _id: c._id,
    // `pai` é o comentário respondido, ou `null` quando a linha é de primeiro
    // nível. Vai para a tela porque é ela que desenha o recuo.
    pai: c.pai ? String(c.pai) : null,
    texto: c.apagado ? "" : c.texto,
    // ── O COMENTÁRIO APAGADO QUE TINHA RESPOSTA CONTINUA NA LISTA ────────
    //
    // Ele volta vazio e marcado. Some da tela como texto e sobra como lugar: as
    // respostas dele precisam de algo a que se prender, senão uma conversa de
    // três linhas viraria três frases soltas respondendo ao nada.
    apagado: Boolean(c.apagado),
    oficial: Boolean(c.oficial),
    nome: c.apagado ? "" : c.autor?.nome || "",
    criadoEm: c.criadoEm,
    meu:
      !c.apagado &&
      Boolean(quem?.instance) &&
      c.autor?.instance === quem.instance &&
      String(c.autor?.userId) === String(quem.userId),
  }));

  return ordenarEmFio(limpo);
};

// ── A ORDEM: CADA PAI SEGUIDO DAS RESPOSTAS DELE ──────────────────────────
//
// Ordenar só por data misturaria tudo: uma resposta escrita hoje a um comentário
// de ontem apareceria no fim, longe do que ela responde. O que se lê é a
// conversa, e conversa tem lugar antes de ter hora.
//
// A montagem é aqui e não no Mongo de propósito. Um `$graphLookup` faria a mesma
// coisa com uma agregação que ninguém depura, para uma lista de no máximo
// duzentas linhas que já vieram todas.
function ordenarEmFio(linhas) {
  const porData = (a, b) => new Date(a.criadoEm) - new Date(b.criadoEm);

  const pais = linhas.filter((c) => !c.pai).sort(porData);
  const respostas = new Map();
  for (const c of linhas) {
    if (!c.pai) continue;
    if (!respostas.has(c.pai)) respostas.set(c.pai, []);
    respostas.get(c.pai).push(c);
  }

  const saida = [];
  for (const pai of pais) {
    saida.push(pai);
    const filhas = respostas.get(String(pai._id)) || [];
    saida.push(...filhas.sort(porData));
    respostas.delete(String(pai._id));
  }

  // ÓRFÃS entram no fim, e não desaparecem: uma resposta cujo pai foi apagado de
  // verdade (pelo painel, moderando) continua sendo texto que alguém escreveu.
  // Sumir com ela em silêncio seria apagar por tabela.
  for (const filhas of respostas.values()) saida.push(...filhas.sort(porData));

  return saida;
}

// ── COMENTAR ──────────────────────────────────────────────────────────────
//
// ── RESPONDER A UM COMENTÁRIO ─────────────────────────────────────────────
//
// *"Permita alguém responder embaixo também do meu comentário, ou eu responder
// meu próprio comentário."*
//
// `pai` é o comentário respondido. Responder ao PRÓPRIO comentário é permitido
// sem caso especial — é o que alguém faz quando lembra de mais uma coisa, e
// proibir seria inventar uma regra para nada.
//
// ── UM NÍVEL SÓ, E O QUE ACONTECE COM O SEGUNDO ───────────────────────────
//
// Responder a uma resposta ANEXA AO MESMO PAI, em vez de criar o terceiro nível.
// Não é limitação de banco: é que num diálogo de 600 px de largura, o terceiro
// recuo deixa a quarta linha com espaço para três palavras — e a partir daí a
// conversa fica ilegível justamente onde ela ficou interessante.
//
// Anexar em vez de RECUSAR porque quem clicou em "responder" numa resposta
// quis dizer algo naquele assunto, e um erro ali seria a tela discutindo
// hierarquia com quem só queria falar.
Idea_model.prototype.comentar = async function (id, texto, quem, pai) {
  if (!ObjectId.isValid(id)) return { ok: false, erro: "nao_encontrado" };
  if (!quem?.instance || !quem?.userId) return { ok: false, erro: "sem_autor" };

  const corpo = limpar(texto, MAX_COMENTARIO);
  if (!corpo) return { ok: false, erro: "sem_texto" };

  const col = await this.collection();
  const existe = await col.findOne({ _id: new ObjectId(id) }, { projection: { _id: 1 } });
  if (!existe) return { ok: false, erro: "nao_encontrado" };

  const comentarios = await this.comentarios();

  // O PAI É CONFERIDO CONTRA A IDEIA, e não só pelo id.
  //
  // Sem isto, um id de comentário de OUTRA ideia entraria como pai: a resposta
  // ficaria pendurada num comentário que não está naquele fio, apareceria como
  // órfã, e ninguém entenderia por quê.
  let paiId = null;
  if (pai && ObjectId.isValid(pai)) {
    const doPai = await comentarios.findOne({
      _id: new ObjectId(pai),
      idea: new ObjectId(id),
    });
    // Pai que não existe naquela ideia: a linha entra como primeiro nível, e não
    // como erro. O texto é o que importa; a hierarquia é enfeite da leitura.
    if (doPai) paiId = doPai.pai ? new ObjectId(doPai.pai) : doPai._id;
  }

  // O teto por dia, por PESSOA e contando comentário em QUALQUER ideia: o
  // estrago de um despejo é o mesmo espalhado em três ideias ou concentrado numa.
  const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const hoje = await comentarios.countDocuments({
    "autor.instance": quem.instance,
    "autor.userId": String(quem.userId),
    criadoEm: { $gte: ontem },
  });
  if (hoje >= COMENTARIOS_POR_DIA) return { ok: false, erro: "muitos_hoje" };

  await comentarios.insertOne({
    idea: new ObjectId(id),
    pai: paiId,
    texto: corpo,
    // `oficial` é gravado FALSO, e não omitido: deduzir "não é oficial" da
    // ausência do campo é a regra que se inverte sozinha no dia em que outro
    // caminho passar a não gravá-lo.
    oficial: false,
    autor: {
      instance: quem.instance,
      userId: String(quem.userId),
      nome: limpar(quem.nome, 120),
    },
    criadoEm: new Date(),
  });

  const total = await comentarios.countDocuments({
    idea: new ObjectId(id),
    apagado: { $ne: true },
  });
  await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { comentarios: total, atualizadoEm: new Date() } }
  );

  return { ok: true, comentarios: total, fio: await this.comentariosDe(id, quem) };
};

// ── APAGAR O PRÓPRIO COMENTÁRIO, e só o próprio ───────────────────────────
//
// O DONO ESTÁ NO FILTRO, nunca numa checagem antes do delete. É a mesma regra
// que o resto do produto segue: `deleteOne({ _id, "autor.instance", "autor.userId" })`
// não apaga o de outra pessoa nem se o id estiver errado — enquanto um
// `findOne` + `if` + `delete` tem uma janela entre a conferência e a ação, e
// deixa a decisão a três linhas de distância de quem a executa.
//
// NÃO EXISTE EDITAR. Um comentário editado depois de alguém responder muda o que
// a resposta estava respondendo, e o fio passa a mentir sobre a conversa. Quem
// se arrepende apaga e escreve de novo — e aí a ordem mostra o que aconteceu.
Idea_model.prototype.apagarComentario = async function (comentarioId, quem) {
  if (!ObjectId.isValid(comentarioId)) return { ok: false, erro: "nao_encontrado" };
  if (!quem?.instance || !quem?.userId) return { ok: false, erro: "sem_autor" };

  const comentarios = await this.comentarios();

  const doc = await comentarios.findOne({
    _id: new ObjectId(comentarioId),
    "autor.instance": quem.instance,
    "autor.userId": String(quem.userId),
  });
  if (!doc) return { ok: false, erro: "nao_encontrado" };

  // ── APAGAR UM COMENTÁRIO QUE JÁ TEM RESPOSTA NÃO O REMOVE ───────────────
  //
  // Ele fica, vazio e marcado (`apagado`), e as respostas continuam onde estão.
  //
  // A alternativa era apagar em cascata, e ela dá a QUEM ESCREVEU O PAI o poder
  // de apagar o texto de outras pessoas — bastaria comentar, esperar duas
  // respostas e apagar o próprio. Ninguém faria isso de propósito no primeiro
  // dia, e é exatamente o tipo de porta que se acha depois.
  //
  // O outro caminho — recusar — deixaria a pessoa presa a um comentário que ela
  // quer tirar. Vazio e marcado tira o texto dela da tela, que é o que ela
  // pediu, e mantém o lugar a que as respostas se prendem.
  const temResposta = (await comentarios.countDocuments({ pai: doc._id })) > 0;

  if (temResposta) {
    await comentarios.updateOne(
      {
        _id: new ObjectId(comentarioId),
        "autor.instance": quem.instance,
        "autor.userId": String(quem.userId),
      },
      // O TEXTO E O NOME SAEM DO BANCO, e não só da resposta da rota. Guardar o
      // texto "só para o caso de" seria manter o que a pessoa pediu para apagar.
      { $set: { apagado: true, texto: "", autor: { instance: doc.autor.instance, userId: doc.autor.userId, nome: "" } } }
    );
  } else {
    await comentarios.deleteOne({
      _id: new ObjectId(comentarioId),
      "autor.instance": quem.instance,
      "autor.userId": String(quem.userId),
    });
  }

  const col = await this.collection();
  // O CONTADOR NÃO CONTA OS APAGADOS. Eles existem como lugar, não como
  // conversa — e "3 comentários" numa ideia onde dois estão vazios é um número
  // que promete mais do que a tela entrega.
  const total = await comentarios.countDocuments({ idea: doc.idea, apagado: { $ne: true } });
  await col.updateOne({ _id: doc.idea }, { $set: { comentarios: total } });

  return {
    ok: true,
    idea: String(doc.idea),
    comentarios: total,
    fio: await this.comentariosDe(String(doc.idea), quem),
  };
};

// ── SUGERIR ───────────────────────────────────────────────────────────────
//
// Quem sugere já vota na própria ideia. Não é conveniência: nascendo com zero
// votos, ela cairia no fim da lista ordenada por votos e nem a pessoa que a
// escreveu a acharia para clicar. Zero votos numa ideia que alguém acabou de
// pedir é um número errado.
Idea_model.prototype.criar = async function (entrada, quem) {
  const titulo = texto(entrada?.titulo, MAX_TITULO);
  const detalhes = texto(entrada?.detalhes, MAX_DETALHES);

  if (titulo.length < 4) return { ok: false, erro: "sem_titulo" };
  if (!quem?.instance || !quem?.userId) return { ok: false, erro: "sem_autor" };

  const col = await this.collection();

  // O teto por dia, contado por PESSOA e não por instância: uma academia com
  // seis professores tem seis pessoas com ideias, e somar todos faria a sexta
  // não poder escrever a dela.
  const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const hoje = await col.countDocuments({
    "autor.instance": quem.instance,
    "autor.userId": String(quem.userId),
    criadoEm: { $gte: ontem },
  });
  if (hoje >= POR_DIA) return { ok: false, erro: "muitas_hoje" };

  const agora = new Date();
  const r = await col.insertOne({
    titulo,
    detalhes,
    status: "aberta",
    votos: 1,
    autor: {
      instance: quem.instance,
      userId: String(quem.userId),
      nome: texto(quem.nome, 120),
    },
    criadoEm: agora,
    atualizadoEm: agora,
  });

  const votos = await this.votos();
  await votos.insertOne({
    idea: r.insertedId,
    instance: quem.instance,
    userId: String(quem.userId),
    nome: texto(quem.nome, 120),
    criadoEm: agora,
  });

  return { ok: true, id: String(r.insertedId) };
};

// ── VOTAR: UMA AÇÃO QUE ALTERNA ───────────────────────────────────────────
//
// Duas rotas (votar/desvotar) fariam a tela escolher qual chamar a partir do que
// ela ACHA que é o estado atual — e ela erra: dois cliques rápidos, ou a aba
// aberta desde ontem, mandariam "votar" no que já está votado.
//
// Alternando, o que volta é o estado final e a tela obedece em vez de adivinhar.
Idea_model.prototype.alternarVoto = async function (id, quem) {
  if (!ObjectId.isValid(id)) return { ok: false, erro: "nao_encontrado" };
  if (!quem?.instance || !quem?.userId) return { ok: false, erro: "sem_autor" };

  const col = await this.collection();
  const existe = await col.findOne({ _id: new ObjectId(id) }, { projection: { _id: 1 } });
  if (!existe) return { ok: false, erro: "nao_encontrado" };

  const votos = await this.votos();
  const chave = {
    idea: new ObjectId(id),
    instance: quem.instance,
    userId: String(quem.userId),
  };

  const jaTem = await votos.findOne(chave, { projection: { _id: 1 } });

  if (jaTem) {
    await votos.deleteOne({ _id: jaTem._id });
  } else {
    // `upsert` e não `insertOne`: dois cliques no mesmo instante inserem dois
    // documentos, e o índice único devolveria 11000 na cara de quem só clicou
    // rápido. O upsert é a mesma operação, sem a corrida.
    await votos.updateOne(
      chave,
      { $set: { ...chave, nome: texto(quem.nome, 120), criadoEm: new Date() } },
      { upsert: true }
    );
  }

  // Reconta em vez de somar 1: o número no post é cache, e recontar é o que o
  // mantém verdadeiro quando dois votos chegam juntos. Uma consulta a mais numa
  // ação que acontece uma vez por pessoa por ideia.
  const total = await votos.countDocuments({ idea: new ObjectId(id) });
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { votos: total } });

  return { ok: true, votei: !jaTem, votos: total };
};

module.exports = Idea_model;
module.exports.MAX_TITULO = MAX_TITULO;
module.exports.MAX_DETALHES = MAX_DETALHES;
module.exports.POR_DIA = POR_DIA;
module.exports.COMENTARIOS_POR_DIA = COMENTARIOS_POR_DIA;
module.exports.MAX_COMENTARIO = MAX_COMENTARIO;
