const instanceContext = require("../lib/instance.js");

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

// ── Consumo de IA, no central ───────────────────────────────────────────────
//
// O que vai para cá e o que NÃO vai é a decisão mais importante deste arquivo.
//
// VAI: instância, modelo, tokens, custo, quantos turnos. É a pergunta que só o
// central pode responder — "quanto cada cliente está gastando de IA" —, e ela
// atravessa clientes por natureza.
//
// NÃO VAI: uma linha da conversa. Nem a fala, nem o título, nem o nome de quem
// foi cadastrado, nem o id do usuário. O sistema inteiro é construído sobre um
// banco por cliente, sem `tenant_id` em lugar nenhum, justamente para não haver
// um lugar onde o dado de todo mundo se encontra. Seria uma ironia furar isso
// pela porta da IA, que é onde passa o dado mais sensível — a conversa em que
// alguém dita o telefone e o objetivo de um paciente.
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
Center_model.prototype.byHost = async function (host) {
  const limpo = String(host || "").trim().toLowerCase().split(":")[0];
  if (!limpo) return undefined;
  const col = await this.collection();
  return (await col.findOne({ hosts: limpo })) || undefined;
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

  return { ok: true, instance: nome };
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

module.exports = Center_model;
