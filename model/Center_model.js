const { ObjectId } = require("mongodb");
const instanceContext = require("../lib/instance.js");
const dominio = require("../lib/domain.js");
const alias = require("../lib/alias.js");
const retencaoDeLogs = require("../lib/retencaoDeLogs.js");

// A collection `instances`, no banco do PAINEL (`gofitnow_center`) — o registro
// dos clientes.
//
// É a única coisa que sabe que existe mais de um cliente. Cada documento é uma
// instância: o nome (que vira o nome do banco), o e-mail de quem a tem, e os
// endereços por onde ela é aberta.
//
// Daqui ela é só LIDA. Quem escreve e indexa é o painel do center; este backend
// a consulta para descobrir de quem é um host antes de existir sessão.
//
// Os ENDEREÇOS moram aqui, e não no `tenants` de dentro da instância, por uma
// razão de ordem: a tela de login é resolvida por host ANTES de existir sessão,
// então nesse instante ainda não se sabe qual banco abrir. Só um registro
// central pode responder "de quem é este endereço". E é aqui que o índice único
// de host faz sentido: dois clientes não podem disputar o mesmo endereço, e um
// índice dentro de cada banco não veria o outro.
//
// ── O cache ────────────────────────────────────────────────────────────────
//
// `isActive` é consultada em TODA requisição que traz instância — é o portão que
// impede um subdomínio inventado de abrir um banco fantasma. Uma ida ao Mongo por
// requisição só para isso seria um custo fixo em tudo, então a resposta fica
// guardada por alguns segundos.
//
// Os prazos são diferentes de propósito. O SIM vale mais tempo porque cliente
// cadastrado raramente deixa de existir. O NÃO vale pouco porque ele é o estado
// que acontece por um instante logo depois de cadastrar: sem isso, quem acabou de
// criar um cliente veria "domínio não identificado" por meio minuto e acharia que
// o cadastro falhou. O provisionamento também limpa a chave (ver Internal.js).
const CACHE_SIM_MS = 30 * 1000;
const CACHE_NAO_MS = 5 * 1000;

// Teto para o cache não virar caminho de esgotar memória: quem varre
// `aaa.gofitnow.fit`, `aab.gofitnow.fit`… acumularia uma entrada por tentativa.
const CACHE_MAX = 500;

// Uma tabela só, com a chave prefixada: `i:` para instância ativa, `h:` para o
// endereço. Prefixo porque um host e um nome de instância podem colidir —
// `marlon` e `marlon.gofitnow.fit` são perguntas diferentes com respostas
// diferentes.
const cache = new Map();

function guardar(chave, valor) {
  if (cache.size >= CACHE_MAX) {
    const agora = Date.now();
    for (const [k, v] of cache) if (agora >= v.vale) cache.delete(k);
    // Se depois da limpeza ainda está cheio, começa de novo. Perder cache é
    // lento, não errado.
    if (cache.size >= CACHE_MAX) cache.clear();
  }

  // Achou vale mais tempo que não achou: ver o comentário dos prazos acima.
  cache.set(chave, { valor, vale: Date.now() + (valor ? CACHE_SIM_MS : CACHE_NAO_MS) });
  return valor;
}

function lido(chave) {
  const guardado = cache.get(chave);
  if (!guardado || Date.now() >= guardado.vale) return undefined;
  return guardado.valor;
}

function Center_model(app) {
  this.app = app;
}

Center_model.prototype.collection = async function () {
  // centralDb, não connectToServer: esta collection é do compartilhado, não de
  // uma instância.
  const db = await this.app.mongodb.centralDb();
  return db.collection("instances");
};

// ── O AMBIENTE DE UM ENDEREÇO ───────────────────────────────────────────────
//
// Qual instalação atende este cliente — e, na prática, qual BACKEND a tela dele
// deve chamar. A lista mora em `environments`, no banco do painel, e quem a
// edita é a Central (ver `gofitnow-center-backend/model/Environment_model.js`).
//
// Aqui só se LÊ, e por um motivo de desenho: quem escreve é um painel, quem lê é
// toda abertura de tela de login. Duas responsabilidades, dois lados.
//
// ── Por que o cache é CURTO, e mais curto que o resto deste arquivo ────────
//
// `isActive` guarda por 30s porque cliente cadastrado raramente some. Aqui o
// valor muda por decisão humana, num painel, com alguém olhando o resultado: o
// Marlon aponta um cliente para desenvolvimento e recarrega a tela dele para
// conferir. Trinta segundos de "não mudou nada" pareceriam que não salvou — foi
// exatamente isso que aconteceu com o cache de tema, e o prazo lá caiu para um
// minuto pelo mesmo motivo.
//
// Dez segundos ainda poupam o banco de praticamente toda visita, porque visita
// não vem sozinha.
const CACHE_AMBIENTE_MS = 10 * 1000;

Center_model.prototype.environmentsCollection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("environments");
};

// O ambiente de um REGISTRO de cliente (o documento que `byHost` devolveu).
//
// Cliente sem `environment` gravado cai no PADRÃO — e isso não é um detalhe de
// migração, é o estado normal: escolher ambiente é a exceção, herdar é a regra.
//
// Devolve `null` quando não há ambiente nenhum cadastrado. Quem chama trata isso
// como "continue com o backend de sempre": uma instalação que nunca abriu a tela
// de ambientes não pode parar de funcionar por causa dela.
Center_model.prototype.environmentOf = async function (registro) {
  const id = registro?.environment ? String(registro.environment) : "";
  const chave = "e:" + (id || "*padrao*");

  const guardado = lido(chave);
  if (guardado !== undefined) return guardado;

  let doc;
  try {
    const col = await this.environmentsCollection();
    // O id vem do documento do cliente, gravado pelo painel — mas um valor torto
    // ali não pode derrubar a tela de login de ninguém.
    doc = id && ObjectId.isValid(id)
      ? await col.findOne({ _id: new ObjectId(id) })
      : await col.findOne({ padrao: true });

    // Apontado para um ambiente que foi apagado: cai no padrão em vez de ficar
    // sem endereço. O painel recusa apagar ambiente em uso, então isto é a rede
    // de segurança para o caso de alguém apagar direto no banco.
    if (id && !doc) doc = await col.findOne({ padrao: true });
  } catch (erro) {
    // Sem a collection (instalação antiga) ou banco fora: segue sem ambiente.
    doc = null;
  }

  const valor = doc ? { nome: doc.nome, dominio: doc.dominio, url: `https://${doc.dominio}` } : null;

  // Guardado com prazo próprio: `guardar` usa os prazos do `isActive`, que são
  // outros e existem por outra razão.
  cache.set(chave, { valor, vale: Date.now() + CACHE_AMBIENTE_MS });
  return valor;
};

// ── Consumo de IA, no central ───────────────────────────────────────────────
//
// O que vai para cá e o que NÃO vai é a decisão mais importante deste arquivo.
//
// VAI: instância, modelo, tokens, custo, quantos turnos. É a pergunta que só o
// central pode responder — "quanto cada cliente está gastando de IA" —, e ela
// atravessa clientes por natureza.
//
// NÃO VAI: uma linha da conversa. Nem a fala, nem o título, nem o nome de quem
// foi cadastrado, nem o id do usuário. Seria uma ironia furar isso pela porta da
// IA, que é onde passa o dado mais sensível — a conversa em que alguém dita o
// telefone e o objetivo de um paciente.
//
// ── O ARGUMENTO MUDOU, A REGRA NÃO ─────────────────────────────────────────
//
// Aqui estava escrito que "o sistema inteiro é construído sobre um banco por
// cliente, sem `tenant_id` em lugar nenhum, justamente para não haver um lugar
// onde o dado de todo mundo se encontra". Isso deixou de ser verdade em
// 24/08/2026: os clientes passaram a dividir banco, com o campo `instance` em
// cada documento (a aritmética que forçou isso está em `config/mongodb.js`).
//
// Então a propriedade que o desenho antigo dava DE GRAÇA hoje é sustentada por
// `lib/escopo.js`, que filtra toda consulta pelo cliente e recusa método que não
// saiba escopar. É uma garantia de código no lugar de uma garantia de
// armazenamento — mais frágil por natureza, e por isso testada à parte.
//
// A regra desta collection continua valendo, e por um motivo que não dependia
// daquele: conteúdo de conversa não pertence ao painel, em banco nenhum.
//
// `sessionId` viaja como texto opaco: serve para o painel contar sessões
// distintas e para uma auditoria conseguir cruzar com a instância se precisar.
// Sozinho, não abre nada — quem lê a conversa é o banco do cliente.
Center_model.prototype.usoIaCollection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("ai_usage");
};

Center_model.prototype.registrarUsoIa = async function ({
  instance,
  sessionId,
  model,
  usage,
  costMicros,
}) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return;

  const col = await this.usoIaCollection();
  const agora = new Date();

  // Uma linha por SESSÃO, incrementada a cada turno — não uma linha por turno.
  // Uma conversa de vinte passos viraria vinte documentos para responder uma
  // pergunta que é sobre a conversa inteira.
  await col.updateOne(
    { instance: nome, sessionId: String(sessionId) },
    {
      $set: { model, updatedAt: agora },
      $inc: {
        costMicros: Number(costMicros || 0),
        turns: 1,
        inputTokens: Number(usage?.input_tokens || 0),
        outputTokens: Number(usage?.output_tokens || 0),
        cacheWriteTokens: Number(usage?.cache_creation_input_tokens || 0),
        cacheReadTokens: Number(usage?.cache_read_input_tokens || 0),
      },
      $setOnInsert: { createdAt: agora },
    },
    { upsert: true }
  );
};

Center_model.prototype.byInstance = async function (instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return undefined;
  const col = await this.collection();
  return (await col.findOne({ instance: nome })) || undefined;
};

// Esta instância existe e está ativa?
//
// É o portão do middleware. `lib/instance.js` sabe se o NOME é bem formado, o que
// é outra coisa: `bruna` é um nome válido e não é cliente nenhum. Sem esta
// conferência, `bruna.gofitnow.fit` abriria o banco `gofitnow_bruna` — que o Mongo
// cria na primeira escrita — e passaria a existir um cliente que ninguém cadastrou.
Center_model.prototype.isActive = async function (instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return false;

  const guardado = lido("i:" + nome);
  if (guardado !== undefined) return guardado;

  const doc = await this.byInstance(nome);
  // `active` ausente é ATIVA: os registros antigos não têm o campo, e tratá-los
  // como desativados trancaria clientes que funcionam.
  const ativa = Boolean(doc) && doc.active !== false && doc.active !== 0;

  return guardar("i:" + nome, ativa);
};

// Os LIMITES do plano deste cliente — `{ people: 50, brandImages: 8, … }`.
//
// São DOIS documentos: o registro da instância guarda só a chave do plano
// (`plan: "pro"`), e os números moram em `plans`, no mesmo banco central. Ler os
// dois na hora é o que faz uma mudança de plano valer para todo mundo que o
// assina — copiar os números para dentro de cada registro deixaria cada cliente
// carregando uma versão velha da tabela.
//
// `null` num limite é ILIMITADO e é diferente de `0`, que é um limite de
// verdade. Esta função não interpreta nenhum dos dois: devolve o que está
// gravado, e quem chama decide o que "ilimitado" significa na rota dele — pode
// haver teto técnico que o plano não conhece.
//
// SEM PLANO devolve `{}`, e é o mesmo que sai quando o central não responde.
// Inventar um limite barraria um cliente que pagou, e isso é pior do que não
// barrar.
//
// O cache faz a troca de plano demorar até meio minuto para ser sentida: quem
// muda o plano é o painel, que é outro processo e não tem como avisar este
// daqui. Meio minuto num limite é barato; uma ida ao Mongo em todo upload, não.
Center_model.prototype.limitsFor = async function (instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return {};

  const guardado = lido("p:" + nome);
  if (guardado !== undefined) return guardado;

  try {
    const doc = await this.byInstance(nome);
    if (!doc || !doc.plan) return guardar("p:" + nome, {});

    // `plans` é do painel: ele cria, indexa e escreve. Daqui é só leitura, pela
    // mesma porta por onde `instances` já é lida.
    const db = await this.app.mongodb.centralDb();
    const plano = await db.collection("plans").findOne({ key: String(doc.plan) });

    return guardar("p:" + nome, (plano && plano.limits) || {});
  } catch (error) {
    // Não guarda o vazio: o próximo pedido tenta de novo, em vez de carregar a
    // falha de rede pelo prazo inteiro do cache.
    return {};
  }
};

// ── OS MÓDULOS QUE O PLANO DESTE CLIENTE INCLUI ───────────────────────────
//
// O primeiro dos dois portões do módulo. O outro é a liberação da CONTA, e as
// duas perguntas são diferentes:
//
//   este   "a que o plano dá direito"      — decide o painel
//   conta  "o que a conta já ligou"        — decide o cliente, pela notícia
//
// ── `null` É TUDO ─────────────────────────────────────────────────────────
//
// E não é detalhe: é o que faz este campo poder ser acrescentado a um produto no
// ar. Plano sem o campo (todos eles, até alguém editar) inclui todo módulo, do
// mesmo jeito que limite ausente é ilimitado. Ler ausência como lista vazia
// apagaria Aulões e Financeiro de todo cliente no instante do deploy.
//
// Cache junto do resto do plano — a troca de plano leva até meio minuto para ser
// sentida, que é o combinado deste arquivo.
Center_model.prototype.modulosDoPlano = async function (instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return null;

  const guardado = lido("pm:" + nome);
  if (guardado !== undefined) return guardado;

  try {
    const doc = await this.byInstance(nome);
    // Cliente SEM plano inclui tudo. É a mesma escolha do `limitsFor` devolvendo
    // `{}`: "não sei em que plano este cliente está" não pode virar "este
    // cliente não pode nada" — são as contas de cortesia e as que o painel
    // cadastrou sem escolher plano.
    if (!doc || !doc.plan) return guardar("pm:" + nome, null);

    const db = await this.app.mongodb.centralDb();
    const plano = await db.collection("plans").findOne({ key: String(doc.plan) });

    const lista = plano && Array.isArray(plano.modulos) ? plano.modulos.map(String) : null;
    return guardar("pm:" + nome, lista);
  } catch (error) {
    // Não guarda, e devolve TUDO: uma falha de leitura não pode esconder menu.
    return null;
  }
};

// ── O PLANO DESTE CLIENTE, INTEIRO ────────────────────────────────────────
//
// `limitsFor` devolve só os números. Isto devolve o plano: nome, preço e a marca
// de gratuito. É o que o app precisa para dizer, no topo, em que plano a pessoa
// está — e para levá-la à tela onde estão os outros.
//
// Vai pelo MESMO caminho e com o MESMO cache de `limitsFor`, com um prefixo
// próprio. Guardar o documento inteiro numa chave só e derivar os limites dele
// seria mais econômico e trocaria um contrato provado por um refator: `limitsFor`
// está em produção, é chamada em todo upload, e o comportamento dela em cliente
// sem plano é uma decisão escrita e testada.
//
// SEM PLANO devolve `null`, que é diferente de um plano gratuito: "não sei em que
// plano este cliente está" e "está no plano de entrada" levam a telas diferentes.
Center_model.prototype.planFor = async function (instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return null;

  const guardado = lido("pl:" + nome);
  if (guardado !== undefined) return guardado;

  try {
    const doc = await this.byInstance(nome);
    if (!doc || !doc.plan) return guardar("pl:" + nome, null);

    const db = await this.app.mongodb.centralDb();
    const plano = await db.collection("plans").findOne({ key: String(doc.plan) });

    // O plano ATUAL passa pelo mesmo filtro: ele alimenta o selo do topo e o
    // dialog do teto estourado. Sem isto, a mesma linha apareceria escondida
    // na vitrine e visível no dialog.
    const escondidos = await this.limitesEscondidos();
    return guardar("pl:" + nome, plano ? resumoDoPlano(plano, escondidos) : null);
  } catch (error) {
    return null;
  }
};

// OS PLANOS À VENDA, para a tela de escolher.
//
// Só os que o painel manda exibir (`active`), na ORDEM que ele definiu — é para
// isso que a ordem existe, e reordenar lá tem que mudar a tela aqui.
//
// A chave do cache não leva instância: a vitrine é a mesma para todo mundo. O que
// muda por cliente é qual deles está marcado como o atual, e isso é decidido por
// quem chama, com `planFor`.
// ── O QUE A VITRINE ESCONDE DO CLIENTE ────────────────────────────────────
//
// Alguns limites são teto INTERNO do produto — séries por exercício,
// alimentos por refeição. Ninguém escolhe plano por eles, e cada linha que
// ocupam empurra para baixo o que de fato vende. Quem decide é o painel, em
// Planos, e a escolha vale para TODOS os planos: a vitrine é uma comparação,
// e as colunas só se comparam com as mesmas linhas.
//
// Cache curto, pela mesma razão do ambiente: quem acabou de desmarcar um
// checkbox vai recarregar a vitrine para conferir, e trinta segundos de "não
// mudou nada" pareceriam que não salvou.
// ── QUANTOS DIAS A CASA GUARDA O HISTÓRICO ───────────────────────────────
//
// Lido do painel pelo mesmo caminho dos limites do plano e da cobrança: os dois
// backends compartilham o MongoDB. Quem APLICA o número é o índice TTL (ver
// `database/schema.js`); o que se lê aqui é para CONTAR — a aba Histórico da
// ficha diz no pé por quanto tempo a linha do tempo existe, e um número errado
// ali é pior que número nenhum.
//
// Um minuto de cache: o valor muda uma vez por ano, e a tela que o mostra é
// aberta o tempo todo.
const CACHE_RETENCAO_MS = 60 * 1000;

Center_model.prototype.retencaoDeLogs = async function () {
  const guardado = lido("rl:");
  if (guardado !== undefined) return guardado;

  let dias = retencaoDeLogs.PADRAO;
  try {
    dias = await retencaoDeLogs.lerDoCentral(await this.app.mongodb.centralDb());
  } catch (erro) {
    // Painel fora do ar: o padrão. É o mesmo lado para o qual o schema erra, e
    // errar junto é o que impede a tela de dizer 180 enquanto o TTL apaga com
    // outro prazo.
    dias = retencaoDeLogs.PADRAO;
  }

  cache.set("rl:", { valor: dias, vale: Date.now() + CACHE_RETENCAO_MS });
  return dias;
};

// O painel acabou de trocar o número: esquece o que estava guardado, para a
// mudança valer na resposta seguinte e não em até um minuto.
Center_model.prototype.esquecerRetencao = function () {
  cache.delete("rl:");
};

const CACHE_ESCONDIDOS_MS = 10 * 1000;

Center_model.prototype.limitesEscondidos = async function () {
  const guardado = lido("hl:");
  if (guardado !== undefined) return guardado;

  let lista = [];
  try {
    const db = await this.app.mongodb.centralDb();
    const doc = await db.collection("settings").findOne({ key: "plans.hiddenLimits" });
    if (Array.isArray(doc?.value)) lista = doc.value;
  } catch (erro) {
    // Sem a configuração, a vitrine mostra TUDO. Falhar para o lado de mostrar
    // é o certo aqui: uma linha a mais é ruído, uma linha a menos é o plano
    // deixando de anunciar o que oferece.
    lista = [];
  }

  cache.set("hl:", { valor: lista, vale: Date.now() + CACHE_ESCONDIDOS_MS });
  return lista;
};

// ── OS FORNECEDORES CONHECIDOS ────────────────────────────────────────────
//
// *"aqui, coloque um botão 'usar os do vafit', aí puxa da central todos os
// fornecedores"*.
//
// Lidos direto da collection do painel, pelo mesmo caminho dos limites do
// plano: os dois backends compartilham o MongoDB, e uma rota HTTP entre eles
// seria uma dependência de rede no meio de um clique — com timeout para tratar
// e um modo de falha a mais.
//
// Sem cache de propósito: isto é chamado UMA vez, quando alguém clica em
// importar. Guardar em memória economizaria uma consulta por ano e daria um
// catálogo velho no dia em que a lista mudasse.
// ── PROCURAR UM FORNECEDOR NO CATÁLOGO ────────────────────────────────────
//
// *"o certo seria eu clicar em 'novo fornecedor' e, assim que eu digitar o
// nome, já aparece um search select que busca da central; aí se ele clicar, já
// puxa os dados da central, copia foto etc."* (24/09/2026).
//
// Ele está certo, e o que existia antes era o contrário: um botão que despejava
// os CENTO E DEZOITO de uma vez. Quem tem quatro contas a pagar recebia um
// catálogo inteiro para rolar, e a lista de fornecedores da casa deixava de ser
// dele. E demorava — cada logo é uma gravação.
//
// Aqui só volta o que casa com o que a pessoa digitou, sem os bytes de logo: o
// `temLogo` basta para a tela saber se vale desenhar o espaço dela, e copiar a
// imagem é trabalho de QUANDO se escolhe uma.
Center_model.prototype.procurarConhecidos = async function (termo, limite = 8) {
  const texto = String(termo || "").trim();
  // Uma letra traria trinta nomes e nenhuma pista. Duas já recortam.
  if (texto.length < 2) return [];

  try {
    const db = await this.app.mongodb.centralDb();

    // Sem acento e em minúsculas, contra o `nameSort` que o catálogo já guarda
    // normalizado — é o que faz "eletropaulo" achar "Eletropaulo" e "ENEL"
    // achar "Enel".
    const alvo = texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const docs = await db
      .collection("known_suppliers")
      .find(
        { active: { $ne: false }, nameSort: { $regex: alvo } },
        {
          // Os bytes da logo NÃO vêm: são cento e dezoito imagens no catálogo, e
          // trazer as oito de uma busca por nome seria pagar por elas a cada
          // tecla digitada.
          projection: { data: 0 },
        }
      )
      .sort({ nameSort: 1 })
      .limit(Math.min(Math.max(Number(limite) || 8, 1), 20))
      .toArray();

    return docs;
  } catch (erro) {
    // Uma queda do painel não pode virar uma queda do produto: sem sugestão,
    // quem está cadastrando digita o nome e segue.
    console.error("[central] procurar fornecedor:", erro.message);
    return [];
  }
};

// QUAIS DESTES TÊM LOGO — uma consulta para os oito da busca.
//
// Sem isto, a tela só poderia adivinhar: pedir a imagem de todos e aceitar o
// 404 de quem não tem. Oito requisições que falham a cada digitação, e o log do
// navegador em vermelho por um desenho que não existe.
//
// Só os `_id`, sem os bytes: a pergunta é "existe?", e trazer a imagem para
// respondê-la seria pagar por ela duas vezes.
Center_model.prototype.idsComLogo = async function (ids) {
  const { ObjectId } = require("mongodb");

  const alvos = (ids || [])
    .filter((x) => ObjectId.isValid(String(x)))
    .map((x) => new ObjectId(String(x)));

  if (!alvos.length) return new Set();

  try {
    const db = await this.app.mongodb.centralDb();
    const docs = await db
      .collection("known_supplier_images")
      .find({ _id: { $in: alvos } }, { projection: { _id: 1 } })
      .toArray();

    return new Set(docs.map((d) => String(d._id)));
  } catch (erro) {
    // Sem a resposta, a sugestão sai sem logo — que é feio e funciona.
    console.error("[central] quais têm logo:", erro.message);
    return new Set();
  }
};

// UMA logo do catálogo, pelo id — para a SUGESTÃO mostrar a marca.
//
// *"tire esse ícone de I.A, coloque a foto da empresa"* (24/09/2026). E ele tem
// razão: uma estrelinha ao lado de "Vivo" não diz nada; a logo da Vivo diz tudo
// o que a linha precisa dizer.
//
// Separada de `logosDeConhecidos` porque as perguntas são outras: aquela traz
// VÁRIAS para copiar, esta traz UMA para mostrar, e quem a serve é uma rota
// pública com cache — a mesma foto pedida por toda casa que digitar "vivo".
Center_model.prototype.logoDeConhecido = async function (id) {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(String(id || ""))) return null;

  try {
    const db = await this.app.mongodb.centralDb();
    return await db
      .collection("known_supplier_images")
      .findOne({ _id: new ObjectId(String(id)) });
  } catch (erro) {
    console.error("[central] logo do catálogo:", erro.message);
    return null;
  }
};

// UM do catálogo, pelo id — o que a criação copia.
Center_model.prototype.conhecido = async function (id) {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(String(id || ""))) return null;

  try {
    const db = await this.app.mongodb.centralDb();
    return await db.collection("known_suppliers").findOne({ _id: new ObjectId(String(id)) });
  } catch (erro) {
    console.error("[central] fornecedor do catálogo:", erro.message);
    return null;
  }
};

Center_model.prototype.fornecedoresConhecidos = async function () {
  try {
    const db = await this.app.mongodb.centralDb();
    return await db
      .collection("known_suppliers")
      .find({ active: { $ne: false } })
      .sort({ nameSort: 1 })
      .toArray();
  } catch (erro) {
    // Falhar aqui devolve lista vazia, e a tela diz "nada para importar". É a
    // mesma escolha do resto deste modelo: uma queda do painel não pode virar
    // uma queda do produto.
    console.error("[central] fornecedores conhecidos:", erro.message);
    return [];
  }
};

// AS LOGOS do catálogo, pelos ids pedidos.
//
// Os BYTES, e não uma URL. A importação COPIA a logo para a base da casa — é a
// mesma promessa do resto do catálogo: o que ele importou é dele, e uma troca
// nossa depois não mexe no que já está lá.
//
// Por que pelo banco e não por HTTP: os dois backends já compartilham o Mongo, e
// uma chamada de rede por fornecedor no meio de um clique seria um timeout para
// tratar e um modo de falha a mais. É a mesma razão que pôs `known_suppliers`
// aqui em vez de numa rota.
Center_model.prototype.logosDeConhecidos = async function (ids) {
  const { ObjectId } = require("mongodb");

  // ── O ID PODE CHEGAR COMO TEXTO ────────────────────────────────────────
  //
  // A importação em lote passava os `_id` crus (ObjectId) e funcionava; a
  // criação de UM, do catálogo, passou `String(id)` — e o `$in` com texto não
  // casa com um `_id` que é ObjectId. O efeito não é um erro: é a logo vindo
  // VAZIA, calada, num fornecedor que parece cadastrado direito.
  //
  // Normalizar aqui, e não em quem chama, é o que impede o próximo chamador de
  // repetir a mesma pegadinha.
  const alvos = (ids || [])
    .filter(Boolean)
    .map((x) => (ObjectId.isValid(String(x)) ? new ObjectId(String(x)) : x));

  if (!alvos.length) return {};

  try {
    const db = await this.app.mongodb.centralDb();
    const docs = await db
      .collection("known_supplier_images")
      .find({ _id: { $in: alvos } })
      .toArray();

    const mapa = {};
    for (const d of docs) mapa[String(d._id)] = d;
    return mapa;
  } catch (erro) {
    // Sem logo o fornecedor entra igual. Uma queda do painel não pode virar uma
    // importação que falha.
    console.error("[central] logos de fornecedores:", erro.message);
    return {};
  }
};

Center_model.prototype.plansForSale = async function () {
  const guardado = lido("pls:");
  if (guardado !== undefined) return guardado;

  try {
    const db = await this.app.mongodb.centralDb();
    const docs = await db
      .collection("plans")
      // `active` ausente é ATIVO: os planos criados antes do campo existir não
      // podem sumir da vitrine por não terem sido tocados desde então.
      .find({ active: { $ne: false } })
      .sort({ order: 1, priceCents: 1 })
      .toArray();

    // A lista de escondidos é lida UMA vez para a vitrine inteira, e não por
    // plano: são as mesmas linhas em todas as colunas, por desenho.
    const escondidos = await this.limitesEscondidos();
    return guardar("pls:", docs.map((d) => resumoDoPlano(d, escondidos)));
  } catch (error) {
    // Vitrine vazia, e NÃO guardada: a tela mostra "nada por aqui" em vez de
    // estourar, e o próximo pedido tenta de novo.
    return [];
  }
};

// ── O QUE A COBRANÇA PRECISA SABER, E QUE A VITRINE NÃO MOSTRA ────────────
//
// `resumoDoPlano` é a lista fechada do que vai para a TELA, e o `stripePriceId`
// não está nela de propósito: é identificador de catálogo da Stripe, e o
// navegador não tem o que fazer com ele. Mas o checkout precisa dele, então
// existe esta segunda leitura — a do servidor para o servidor.
//
// ── Por que sem cache ─────────────────────────────────────────────────────
//
// Porque é uma leitura por CLIQUE em "Assinar", não por requisição. O que se
// economizaria é imperceptível, e o que se arriscaria não é: um `price_...`
// guardado por trinta segundos é meio minuto de checkout apontando para um
// preço que o painel acabou de arquivar. Quem paga é a pessoa; o erro dela é
// pagar o valor errado.
//
// Devolve `null` quando o plano não existe, e é o chamador que decide o que
// dizer — os motivos de recusa são diferentes (não existe, está desativado, é
// grátis, não foi sincronizado) e cada um pede uma frase própria.
Center_model.prototype.planoParaCobranca = async function (key) {
  const chave = String(key || "").trim().toLowerCase();
  if (!chave) return null;

  try {
    const db = await this.app.mongodb.centralDb();
    const doc = await db.collection("plans").findOne({ key: chave });
    if (!doc) return null;

    return {
      key: String(doc.key),
      name: String(doc.name || ""),
      free: Boolean(doc.free),
      // `active` ausente é ATIVO — mesma regra da vitrine, e ela tem de ser a
      // mesma nas duas: um plano que aparece e não pode ser comprado é um botão
      // que estoura.
      active: doc.active !== false,
      priceCents: Number(doc.priceCents) || 0,
      currency: String(doc.currency || "BRL"),
      interval: doc.interval === "year" ? "year" : "month",
      stripePriceId: doc.stripePriceId || null,
    };
  } catch (erro) {
    // Diferente de "não achei": quem chama não pode responder "esse plano não
    // existe" quando o banco central caiu.
    erro.central = true;
    throw erro;
  }
};

// ── A CONFIGURAÇÃO DA COBRANÇA ────────────────────────────────────────────
//
// Mora no painel, em Configurações, e é lida daqui pelo mesmo caminho dos
// limites escondidos: uma leitura no banco central.
//
// A CHAVE SECRETA vem junto, e isso merece ser dito em voz alta: ela sai do
// banco para a memória deste processo e volta para a Stripe, e nunca para uma
// resposta HTTP. Quem for mexer em `/me/checkout` não pode devolver este objeto
// inteiro para a tela por conveniência.
//
// Cache curto — quem acabou de colar a chave no painel vai clicar em Assinar
// para conferir, e trinta segundos de "sem chave" pareceriam que não salvou.
const CACHE_COBRANCA_MS = 10 * 1000;

Center_model.prototype.cobranca = async function () {
  const guardado = lido("bl:");
  if (guardado !== undefined) return guardado;

  const vazio = { ligada: false, secretKey: "", successUrl: "", trialDays: 0 };

  let valor = vazio;

  try {
    const db = await this.app.mongodb.centralDb();
    const docs = await db
      .collection("settings")
      .find({ key: { $in: ["billing.enabled", "billing.secretKey", "billing.successUrl", "billing.trialDays"] } })
      .toArray();

    const por = Object.fromEntries(docs.map((d) => [d.key, d.value]));

    valor = {
      // `billing.enabled` é o interruptor geral: existe para desligar a venda
      // sem apagar a chave. Ausente é DESLIGADO — o contrário faria uma
      // instalação nova sair vendendo com a chave de teste de alguém.
      ligada: por["billing.enabled"] === true,
      secretKey: String(por["billing.secretKey"] || ""),
      successUrl: String(por["billing.successUrl"] || ""),
      trialDays: Number(por["billing.trialDays"]) || 0,
    };
  } catch (erro) {
    // Central fora do ar: a venda fica indisponível por dez segundos. É o lado
    // certo para errar — o outro é abrir checkout sem saber se a cobrança está
    // ligada.
    valor = vazio;
  }

  cache.set("bl:", { valor, vale: Date.now() + CACHE_COBRANCA_MS });
  return valor;
};

// O que sai do plano para o produto. Uma lista fechada, e não o documento cru:
// `notes` é anotação interna do painel ("cortesia do fulano até dezembro"), e o
// que se manda para o app de todo mundo é o que se escolheu mandar.
// ── O CATÁLOGO DE LIMITES, DUPLICADO AQUI DE PROPÓSITO ────────────────────
//
// A lista que manda é a do painel (`gofitnow-center-backend/model/Plan_model.js`),
// e ela é quem valida na ESCRITA. O problema é que validar na escrita não
// alcança o que já está gravado: uma chave aposentada some do catálogo e
// continua no documento de todo plano salvo antes da aposentadoria.
//
// Foi o que aconteceu com `brandImages`, que virou `appearance` +
// `whitelabel`. O plano Grátis não foi editado desde então, então a chave
// morta atravessou a leitura, chegou na tela e apareceu assim — em inglês, em
// camelCase, no meio de uma lista em português — na vitrine em que o cliente
// decide se paga.
//
// Filtrar na LEITURA é o que fecha isso para todas as telas de uma vez, e sem
// depender de ninguém lembrar de reeditar plano antigo.
//
// ── Por que não filtrar no frontend ──────────────────────────────────────
//
// Porque a tela não sabe distinguir os dois casos, e eles pedem coisas opostas:
//
//   chave NOVA, ainda sem tradução      → tem de APARECER ("3 webhooks"), senão
//                                         o plano deixa de vender o que oferece
//   chave APOSENTADA                    → não pode aparecer
//
// O que separa um do outro é o catálogo, que o navegador não tem. Tentei
// filtrar lá e quebrei o primeiro caso — há um teste em `planos.test.jsx` que
// existe exatamente para proteger ele.
const LIMITES_CONHECIDOS = new Set([
  "professionals", "people", "workouts", "workoutTemplates", "apiKeys",
  "appearance", "whitelabel", "diets", "dietTemplates", "assessments",
  "schedule",
  // Os aulões. Duplicado aqui de propósito — ver o comentário grande logo
  // acima sobre o catálogo: esta lista é a que filtra na LEITURA, e é ela que
  // impede uma chave aposentada de chegar crua na vitrine.
  "aulaoes", "supplements", "prescriptions", "anamnesis", "exams",
  "foodsPerMeal", "exercisesPerWorkout", "setsPerExercise", "photoSides",
  // 15/09/2026: os apps com a marca do cliente, chave do plano mais alto.
  "nativeApps",
]);

// As chaves de SIM ou NÃO, dentro do catálogo acima.
//
// Elas existem aqui por uma ambiguidade que só aparece na tela: `null` quer
// dizer coisas OPOSTAS nos dois tipos de limite.
//
//   num limite numérico   null = ILIMITADO      ("Alunos · sem limite")
//   numa chave de sim/não  null = LIGADA        ("Aparência personalizada")
//
// O cartão recebe só o valor, não o tipo, então ele não consegue separar os
// dois — e tratou `null` como ilimitado para os dois, escrevendo "Aparência
// personalizada · sem limite", que não quer dizer nada.
//
// A regra "ausente é SIM" é do painel (ver o cabeçalho de LIMITES em
// `Plan_model.js`: plano antigo não pode perder o que já usava). Então quem a
// materializa é este lado: a chave sai daqui como booleano DE VERDADE, e aí
// `null` volta a ter um sentido só.
const LIMITES_DE_LIGAR = new Set(["appearance", "whitelabel", "nativeApps"]);

function limitesConhecidos(limits, escondidos = []) {
  if (!limits || typeof limits !== "object") return {};

  const saida = {};
  for (const [chave, valor] of Object.entries(limits)) {
    if (!LIMITES_CONHECIDOS.has(chave) || escondidos.includes(chave)) continue;

    saida[chave] = LIMITES_DE_LIGAR.has(chave) ? valor !== false : valor;
  }
  return saida;
}

function resumoDoPlano(plano, escondidos = []) {
  return {
    key: String(plano.key || ""),
    name: String(plano.name || ""),
    priceCents: Number(plano.priceCents) || 0,
    currency: String(plano.currency || "BRL"),
    interval: plano.interval === "year" ? "year" : "month",
    free: Boolean(plano.free),
    // A bandeirinha do alto do cartão. Só UM plano a tem — quem garante é o
    // painel (`Plan_model.definirRecomendado`), porque duas bandeirinhas na
    // mesma vitrine não recomendam nada.
    recommended: Boolean(plano.recommended),
    // ── O TEXTO QUE VENDE ────────────────────────────────────────────────
    //
    // A frase de uma linha e os itens curados do cartão. Escritos no painel
    // (`Plan_model.sanitize`), e não derivados dos limites: "Para quem vive de
    // atender pessoa a pessoa" não sai de conta nenhuma.
    //
    // Chegam aqui porque as TRÊS vitrines mostram os mesmos planos — o site de
    // vendas, a tela de planos do app e o dialog do teto estourado — e escrever
    // a cópia em três lugares é garantir que os três divirjam.
    tagline: String(plano.tagline || ""),
    // Cartão na grade, ou faixa de largura inteira embaixo. Só o SITE usa — a
    // vitrine de dentro do app desenha tudo como cartão, porque lá são três
    // planos visíveis num dialog, não uma escada de cinco numa página de venda.
    display: plano.display === "faixa" ? "faixa" : "cartao",
    highlights: Array.isArray(plano.highlights) ? plano.highlights.map(String) : [],
    limits: limitesConhecidos(plano.limits, escondidos),
  };
}

// De qual instância é este ENDEREÇO — a pergunta que o app do navegador faz.
//
// Ele é servido em `marlon.gofitnow.fit` mas chama `backend.gofitnow.fit`, então o
// Host que chega ao servidor é o do backend: o subdomínio da tela não atravessa a
// requisição por si. O app manda o endereço dele em `X-Instance-Host` e a
// resolução acontece AQUI, contra o registro — nunca no navegador, que poderia
// dizer qualquer coisa.
//
// Devolve "" quando o endereço não é de ninguém, para o cache poder guardar o
// "não achei" (undefined significaria "não perguntei ainda").
Center_model.prototype.instanceForHost = async function (host) {
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!limpo) return "";

  const guardado = lido("h:" + limpo);
  if (guardado !== undefined) return guardado;

  const doc = await this.byHost(limpo);
  const ativo = doc && doc.active !== false && doc.active !== 0;

  return guardar("h:" + limpo, ativo ? doc.instance : "");
};

// Esquecer o que está guardado de uma instância. Chamado quando o painel acabou
// de criar ou provisionar uma — e pelos testes, que senão vazariam contagem de um
// caso para o outro.
Center_model.prototype.forget = function (instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return cache.clear();

  cache.delete("i:" + nome);
  // O plano também, pelo mesmo motivo dos limites logo abaixo.
  cache.delete("pl:" + nome);
  cache.delete("pls:");
  // Os limites também: um cliente que acabou de nascer pode ter ganhado plano
  // no mesmo cadastro, e um `{}` guardado o deixaria sem limite nenhum até o
  // prazo virar.
  cache.delete("p:" + nome);
  // Os endereços dela também: o cadastro que acabou de nascer tem host novo, e
  // um "não é de ninguém" guardado sobre esse host duraria o prazo inteiro.
  for (const k of cache.keys()) if (k.startsWith("h:")) cache.delete(k);
};

Center_model.prototype.byEmail = async function (email) {
  const limpo = String(email || "").trim().toLowerCase();
  if (!limpo) return undefined;
  const col = await this.collection();
  return (await col.findOne({ email: limpo })) || undefined;
};

// De quem é este endereço. É o que a tela de login pergunta antes de qualquer
// sessão.
//
// ── DOIS DOMÍNIOS NOSSOS, uma lista de `hosts` só ──────────────────────────
//
// Desde 25/08/2026 o produto responde em `shapeapp.fit` (marca nova) e em
// `gofitnow.fit` (o endereço que os clientes têm salvo). O cadastro de cada
// cliente guarda o endereço CANÔNICO — `bruna.gofitnow.fit` —, e é assim que
// fica: migrar a coleção para guardar os dois seria duplicar a mesma informação
// em milhares de documentos e criar a chance de eles divergirem.
//
// Então a normalização acontece na LEITURA: `bruna.shapeapp.fit` procura também
// por `bruna.gofitnow.fit`. Uma consulta, nenhum dado novo, e um cliente que
// nasce amanhã já funciona nos dois endereços sem ninguém lembrar de nada.
//
// O host de FORA (o domínio próprio do cliente, `treinos.marlon.com.br`) não
// ganha candidato nenhum: `subdomainOf` devolve null para o que não é nosso, e
// ele continua sendo procurado exatamente como veio.
Center_model.prototype.byHost = async function (host) {
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!limpo) return undefined;

  // ── OS CANDIDATOS: O ENDEREÇO QUE VEIO, E O MESMO RÓTULO EM TODO DOMÍNIO ──
  //
  // O cadastro guarda UM host por cliente, no domínio canônico do dia em que ele
  // nasceu. `bruna` foi criada quando o canônico era `gofitnow.fit`, então é
  // `bruna.gofitnow.fit` que está gravado.
  //
  // Antes daqui a busca tentava o que veio e o CANÔNICO ATUAL. Isso funcionou
  // enquanto o canônico não mudou — e quebrou no instante em que ele virou
  // `vafit.app` em 13/09/2026: `bruna.vafit.app` gerava os candidatos
  // `[bruna.vafit.app, bruna.vafit.app]`, nenhum deles o que está gravado, e a
  // Bruna deixava de existir no endereço novo. Sem erro nenhum: a tela dizia
  // "domínio não identificado", como se o endereço fosse de ninguém.
  //
  // Agora o rótulo é procurado em TODOS os domínios nossos. É o que torna a
  // troca de marca uma troca de constante de verdade, em vez de uma migração de
  // todos os cadastros — e o que faz os três endereços da mesma pessoa
  // continuarem sendo a mesma pessoa, venha a marca a mudar quantas vezes for.
  const candidatos = [limpo];
  const rotulo = dominio.subdomainOf(limpo);
  if (rotulo) {
    for (const base of dominio.BASE_DOMAINS) {
      const candidato = `${rotulo}.${base}`;
      if (candidato !== limpo) candidatos.push(candidato);
    }
  }

  const col = await this.collection();
  return (await col.findOne({ hosts: { $in: candidatos } })) || undefined;
};

Center_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}, { projection: { instance: 1, email: 1, name: 1, active: 1, hosts: 1 } })
    .sort({ instance: 1 })
    .toArray();
};

// Cria a instância se ela não existe, e não mexe se existe.
//
// Idempotente de propósito: roda no boot, e um segundo boot não pode
// sobrescrever o e-mail nem os endereços de quem já está lá.
Center_model.prototype.ensure = async function ({ instance, email, name }) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return { ok: false, erro: "invalid_instance" };

  const col = await this.collection();
  const agora = new Date();

  try {
    await col.updateOne(
      { instance: nome },
      {
        $setOnInsert: {
          instance: nome,
          email: String(email || "").trim().toLowerCase(),
          name: name || nome,
          hosts: [],
          active: true,
          createdAt: agora,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    // 11000 = índice único: o e-mail já é de outra instância.
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  // O ALIAS DE AFILIADO nasce COM a conta, aqui.
  //
  // ── Por que isto tem de estar neste arquivo ──
  //
  // Porque o cadastro pelo portal não passa pelo painel: ele chama `ensure` e cria o
  // registro direto. Sem esta linha, toda conta criada por auto-cadastro nasceria sem
  // código de indicação — e cada uma dessas é um afiliado que ninguém consegue
  // identificar depois. Não é um dado que se recupera: dá para reservar um alias
  // atrasado, mas não dá para saber quem aquela pessoa indicaria.
  //
  // Fora do `updateOne` acima de propósito: se a reserva falhar, a conta já existe e
  // dá para reservar depois. O contrário — perder o cadastro por causa do alias —
  // seria trocar o essencial pelo acessório.
  await this.reservarAlias(nome, { name, instance: nome });

  return { ok: true, instance: nome };
};

// ── O ALIAS DE AFILIADO ───────────────────────────────────────────────────
//
// Reserva o primeiro alias livre. GÊMEO de `Instance_model.reservarAlias` no painel
// — ver o comentário em `lib/alias.js` sobre por que há duas cópias.
//
// Quem garante unicidade é o ÍNDICE, não uma consulta antes: entre o "está livre?" e
// o "grava" cabe outro cadastro, e dois profissionais se inscrevendo no mesmo segundo
// levariam o mesmo código.
Center_model.prototype.reservarAlias = async function (instance, pistas) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return { ok: false, erro: "invalid_instance" };

  const base = alias.sugerir(pistas || {}) || nome;
  const col = await this.collection();

  await col.createIndex({ alias: 1 }, { unique: true, sparse: true, name: "por_alias" });

  for (let i = 1; i <= 20; i++) {
    const candidato = i === 1 ? base : alias.proxima(base, i);

    try {
      const r = await col.updateOne(
        // `$exists: false`: reservar é operação de UMA vez. Sem isto, um segundo
        // cadastro do mesmo nome trocaria o alias de quem já tem — e quebraria todo
        // link de indicação já divulgado.
        { instance: nome, alias: { $exists: false } },
        { $set: { alias: candidato, aliasEm: new Date() } }
      );

      if (r.matchedCount === 0) {
        const doc = await col.findOne({ instance: nome }, { projection: { alias: 1 } });
        return { ok: true, alias: doc?.alias || "", jaTinha: true };
      }

      return { ok: true, alias: candidato };
    } catch (error) {
      // 11000 = alias tomado por outra conta. Próximo.
      if (error?.code !== 11000) throw error;
    }
  }

  return { ok: false, erro: "sem_alias_livre" };
};

// Quem é o dono deste código. É o que o formulário de cadastro chama para conferir o
// código de indicação que alguém digitou.
Center_model.prototype.porAlias = async function (valor) {
  const conferido = alias.conferir(valor);
  if (!conferido.ok) return undefined;

  const col = await this.collection();
  return (await col.findOne({ alias: conferido.valor })) || undefined;
};

// ── A INDICAÇÃO ───────────────────────────────────────────────────────────
//
// Grava QUEM indicou esta conta. É a origem de toda comissão, e tem três regras que
// valem dinheiro — as mesmas do painel:
//
//   1. UMA VEZ SÓ. Reatribuir é tirar comissão de um afiliado e dar a outro.
//   2. NÃO SE INDICA. Senão a pessoa põe o próprio código e ganha sobre o que ela
//      mesma paga.
//   3. GUARDA O CÓDIGO E A INSTÂNCIA. O código pode ser trocado à mão; a instância
//      não muda nunca, e é por ela que a comissão é somada.
Center_model.prototype.registrarIndicacao = async function (instance, codigo) {
  const nome = instanceContext.normalize(instance);
  if (!nome) return { ok: false, erro: "invalid_instance" };

  const indicador = await this.porAlias(codigo);
  if (!indicador) return { ok: false, erro: "codigo_invalido" };
  if (indicador.instance === nome) return { ok: false, erro: "auto_indicacao" };
  // Conta desligada não indica: geraria comissão para quem já saiu da base.
  if (indicador.active === false) return { ok: false, erro: "indicador_inativo" };

  const col = await this.collection();
  const r = await col.updateOne(
    { instance: nome, indicadoPor: { $exists: false } },
    {
      $set: {
        indicadoPor: indicador.alias,
        indicadoPorInstance: indicador.instance,
        indicadoEm: new Date(),
      },
    }
  );

  if (r.matchedCount === 0) {
    const doc = await col.findOne({ instance: nome }, { projection: { indicadoPor: 1 } });
    if (!doc) return { ok: false, erro: "not_found" };
    return { ok: true, indicadoPor: doc.indicadoPor, jaTinha: true };
  }

  return { ok: true, indicadoPor: indicador.alias };
};

// Registra um endereço numa instância. Falha quando o endereço já é de outra —
// é o índice único que decide, não uma checagem antes.
Center_model.prototype.addHost = async function (instance, host) {
  const nome = instanceContext.normalize(instance);
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!nome || !limpo) return { ok: false, erro: "invalid" };

  const col = await this.collection();
  try {
    const r = await col.updateOne(
      { instance: nome },
      { $addToSet: { hosts: limpo }, $set: { updatedAt: new Date() } }
    );
    if (r.matchedCount === 0) return { ok: false, erro: "no_instance" };
  } catch (error) {
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  return { ok: true, host: limpo };
};

Center_model.prototype.removeHost = async function (instance, host) {
  const nome = instanceContext.normalize(instance);
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!nome || !limpo) return false;

  const col = await this.collection();
  const r = await col.updateOne({ instance: nome }, { $pull: { hosts: limpo } });
  return r.modifiedCount > 0;
};


// ── AS SOLICITAÇÕES DE EXCLUSÃO DE CONTA ───────────────────────────────────
//
// Reescrito em 02/09/2026. A primeira versão AGENDAVA a exclusão do dono para 30
// dias e um script cumpria a data. O Marlon cortou isso: "não exclua automático,
// mande uma solicitação de exclusão lá para a central, para eu ver quem
// solicitou, para eu entrar em contato perguntar o motivo".
//
// Ele está certo, e por um motivo que o prazo não resolvia: quase todo pedido de
// exclusão é um problema com outro nome — cobrança que não devia ter vindo,
// recurso que a pessoa não achou, dado que ela quer tirar de um profissional e
// não do sistema. Apagar no prazo atende o pedido e perde a conversa, e o dado
// não volta.
//
// **Nada aqui apaga nada.** Escreve na fila do painel, e quem apaga é gente.
//
// A collection mora no banco CENTRAL, e não no do cliente, porque o pedido
// precisa sobreviver à exclusão que ele pede — ver
// `gofitnow-center-backend/model/DeletionRequest_model.js`, onde vive o modelo
// completo. Aqui é só o lado de quem PEDE: registrar, consultar e desistir.
//
// Escrita à mão com `instance` no filtro: este banco é o central, e o Proxy de
// `lib/escopo.js` não protege nada aqui.
Center_model.prototype.pedidosDeExclusaoCollection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("deletion_requests");
};

const ABERTOS = ["pendente", "em_contato"];
const MAX_MOTIVO = 2000;

// Registra o pedido. Devolve o que ficou de pé — o novo ou o que já existia.
//
// Pedir duas vezes não cria dois: existe índice único parcial no central para
// isso (`um_aberto_por_pessoa`), e aqui a segunda vez ATUALIZA o motivo, porque
// quem repete o pedido normalmente está acrescentando informação.
Center_model.prototype.pedirExclusao = async function (instance, { usuarioId, nome, email, papel, motivo, oQueVaiSumir }) {
  const nomeDaInstancia = instanceContext.normalize(instance);
  if (!nomeDaInstancia || !usuarioId) return undefined;

  const col = await this.pedidosDeExclusaoCollection();
  const agora = new Date();
  const texto = (v, max) => String(v ?? "").trim().slice(0, max);

  const aberto = await col.findOne({
    instance: nomeDaInstancia,
    usuarioId: String(usuarioId),
    estado: { $in: ABERTOS },
  });

  if (aberto) {
    const novoMotivo = texto(motivo, MAX_MOTIVO);
    if (novoMotivo && novoMotivo !== aberto.motivo) {
      await col.updateOne({ _id: aberto._id }, { $set: { motivo: novoMotivo, motivoEm: agora } });
    }
    return { ...aberto, jaExistia: true };
  }

  const doc = {
    instance: nomeDaInstancia,
    usuarioId: String(usuarioId),
    // Nome e e-mail COPIADOS, não referenciados: é o único jeito de saber com
    // quem falar depois que a conta for apagada — e é essa conta que o pedido
    // manda apagar.
    nome: texto(nome, 140),
    email: texto(email, 200),
    papel: ["aluno", "profissional", "dono"].includes(papel) ? papel : "aluno",
    motivo: texto(motivo, MAX_MOTIVO),
    // Medido AGORA: o número muda com o tempo, e o que importa para a conversa
    // é o tamanho no momento do pedido.
    oQueVaiSumir: oQueVaiSumir && typeof oQueVaiSumir === "object" ? oQueVaiSumir : {},
    estado: "pendente",
    observacao: "",
    pedidaEm: agora,
    atualizadaEm: agora,
  };

  try {
    const r = await col.insertOne(doc);
    return { ...doc, _id: r.insertedId, jaExistia: false };
  } catch (erro) {
    // Corrida com outro toque no mesmo segundo: o índice único parcial recusa o
    // segundo insert. Devolver o que existe é o certo — a pessoa pediu, e o
    // pedido está de pé.
    if (erro?.code === 11000) {
      const existente = await col.findOne({
        instance: nomeDaInstancia,
        usuarioId: String(usuarioId),
        estado: { $in: ABERTOS },
      });
      if (existente) return { ...existente, jaExistia: true };
    }
    throw erro;
  }
};

// O pedido de pé desta pessoa, para a tela dela mostrar o estado.
Center_model.prototype.exclusaoPedida = async function (instance, usuarioId) {
  const nomeDaInstancia = instanceContext.normalize(instance);
  if (!nomeDaInstancia || !usuarioId) return undefined;

  const col = await this.pedidosDeExclusaoCollection();
  return (
    (await col.findOne({
      instance: nomeDaInstancia,
      usuarioId: String(usuarioId),
      estado: { $in: ABERTOS },
    })) || undefined
  );
};

// A pessoa desistindo. Sem senha: desistir não destrói nada, e barrar a
// desistência seria atrito no lado errado.
Center_model.prototype.cancelarExclusaoPedida = async function (instance, usuarioId) {
  const nomeDaInstancia = instanceContext.normalize(instance);
  if (!nomeDaInstancia || !usuarioId) return false;

  const col = await this.pedidosDeExclusaoCollection();
  const r = await col.updateOne(
    {
      instance: nomeDaInstancia,
      usuarioId: String(usuarioId),
      estado: { $in: ABERTOS },
    },
    { $set: { estado: "cancelada", canceladaPelaPessoa: true, atualizadaEm: new Date() } }
  );
  return r.matchedCount > 0;
};

module.exports = Center_model;
