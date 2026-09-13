const { ObjectId } = require("mongodb");
const instanceContext = require("../lib/instance.js");
const dominio = require("../lib/domain.js");
const alias = require("../lib/alias.js");

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

    return guardar("pl:" + nome, plano ? resumoDoPlano(plano) : null);
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

    return guardar("pls:", docs.map(resumoDoPlano));
  } catch (error) {
    // Vitrine vazia, e NÃO guardada: a tela mostra "nada por aqui" em vez de
    // estourar, e o próximo pedido tenta de novo.
    return [];
  }
};

// O que sai do plano para o produto. Uma lista fechada, e não o documento cru:
// `notes` é anotação interna do painel ("cortesia do fulano até dezembro"), e o
// que se manda para o app de todo mundo é o que se escolheu mandar.
function resumoDoPlano(plano) {
  return {
    key: String(plano.key || ""),
    name: String(plano.name || ""),
    priceCents: Number(plano.priceCents) || 0,
    currency: String(plano.currency || "BRL"),
    interval: plano.interval === "year" ? "year" : "month",
    free: Boolean(plano.free),
    limits: plano.limits && typeof plano.limits === "object" ? plano.limits : {},
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
