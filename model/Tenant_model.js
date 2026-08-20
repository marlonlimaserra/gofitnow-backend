const { ObjectId } = require("mongodb");
const currencies = require("../lib/currencies.js");
const tempo = require("../lib/tempo.js");

const theme = require("../lib/theme.js");
const domainLib = require("../lib/domain.js");

// A collection `tenants` — o domínio e a aparência de cada profissional.
//
// Um profissional, um domínio. O documento é achado por DUAS chaves diferentes:
// pelo dono (a tela de Aparência) e pelo subdomínio (a tela de login, que ainda
// não sabe quem é ninguém). As duas têm índice.
function Tenant_model(app) {
  this.app = app;
}

Tenant_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("tenants");
};

Tenant_model.prototype.dataByUser = async function (userId) {
  if (!ObjectId.isValid(userId)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ user: new ObjectId(userId) })) || undefined;
};

Tenant_model.prototype.dataBySubdomain = async function (subdomain) {
  const nome = domainLib.normalize(subdomain);
  if (!nome) return undefined;
  const col = await this.collection();
  return (await col.findOne({ subdomain: nome })) || undefined;
};

Tenant_model.prototype.dataByCustomDomain = async function (host) {
  const nome = domainLib.normalizeDomain(host);
  if (!nome) return undefined;
  const col = await this.collection();
  return (await col.findOne({ customDomain: nome })) || undefined;
};

// O caminho que a tela de login usa: um host, dois jeitos de ser de alguém.
//
// O subdomínio vem primeiro porque é o mais barato de descartar — `subdomainOf`
// já devolve null para tudo que não é nosso, sem ir ao banco.
Tenant_model.prototype.dataByHost = async function (host) {
  const sub = domainLib.subdomainOf(host);
  if (sub) return this.dataBySubdomain(sub);
  return this.dataByCustomDomain(host);
};

// A aparência DA INSTÂNCIA, quando nenhum documento reivindica o endereço.
//
// Existe por causa de um descompasso que o banco-por-cliente criou. O endereço
// `marlon.gofitnow.fit` pertence à INSTÂNCIA — quem o registra é o painel, na
// coleção `instances` do central. Mas a aparência mora no documento do
// profissional, e ele só era achado por host se o profissional tivesse
// reivindicado aquele subdomínio por dentro, numa segunda tela.
//
// O resultado era o defeito mais confuso possível: a pessoa salvava a tela de
// entrada, o tema ia para o banco, e a tela de entrada continuava a original —
// porque a busca por host não achava nada e caía no padrão. Salvo e invisível.
//
// A regra é o profissional MAIS ANTIGO da instância: é a conta criada quando o
// cliente foi provisionado, o dono do negócio. Uma instância é UM negócio com uma
// marca; se um profissional de dentro quiser aparência própria, ele reivindica um
// endereço e o `dataByHost` acima o acha primeiro.
Tenant_model.prototype.dataOfInstance = async function () {
  const users = await this.app.api.user.collection();

  // `createdAt: 1` e não o `_id`: o ObjectId cresce com o tempo, mas depender
  // disso é depender de um detalhe do driver, não de um campo que a gente grava.
  const dono = await users.findOne({ type: "trainer" }, { sort: { createdAt: 1 } });
  if (!dono) return undefined;

  return this.dataByUser(dono._id);
};

// Livre = nome válido, não reservado e ainda não tomado por outra conta.
Tenant_model.prototype.isFree = async function (subdomain, exceptUserId) {
  if (!domainLib.isAvailableName(subdomain)) return false;

  const dono = await this.dataBySubdomain(subdomain);
  if (!dono) return true;
  return exceptUserId ? String(dono.user) === String(exceptUserId) : false;
};

// Reserva o nome ANTES de falar com a Cloudflare.
//
// A ordem importa: o índice único no banco é o que impede duas contas pedindo o
// mesmo nome ao mesmo tempo. Checar antes e criar depois perderia a corrida —
// os dois passariam na checagem.
Tenant_model.prototype.claim = async function (userId, subdomain) {
  const nome = domainLib.normalize(subdomain);
  if (!nome || !domainLib.isAvailableName(nome)) return { ok: false, erro: "invalid" };

  const col = await this.collection();
  const agora = new Date();

  try {
    await col.updateOne(
      { user: new ObjectId(userId) },
      {
        $set: { subdomain: nome, status: "pending", updatedAt: agora },
        $setOnInsert: { user: new ObjectId(userId), theme: theme.defaults(), createdAt: agora },
      },
      { upsert: true }
    );
  } catch (error) {
    // 11000 = índice único: o nome é de outra conta.
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  return { ok: true, subdomain: nome, host: domainLib.hostOf(nome) };
};

Tenant_model.prototype.setStatus = async function (userId, status, erro) {
  const col = await this.collection();
  await col.updateOne(
    { user: new ObjectId(userId) },
    { $set: { status, lastError: erro || null, updatedAt: new Date() } }
  );
};

// ── Domínio próprio ─────────────────────────────────────────────────────────
//
// Campo separado do subdomínio, com status separado. Não é capricho: os dois
// endereços podem existir ao mesmo tempo e falham por motivos diferentes — o
// subdomínio espera credencial nossa, o domínio próprio espera o DNS DELE.

Tenant_model.prototype.isDomainFree = async function (host, exceptUserId) {
  if (!domainLib.isUsableDomain(host)) return false;

  const dono = await this.dataByCustomDomain(host);
  if (!dono) return true;
  return exceptUserId ? String(dono.user) === String(exceptUserId) : false;
};

// Mesma ordem do subdomínio: grava primeiro, fala com a Cloudflare depois. O
// índice único é quem decide a corrida entre duas contas pedindo o mesmo host.
Tenant_model.prototype.claimCustomDomain = async function (userId, host) {
  const nome = domainLib.normalizeDomain(host);
  if (!nome || !domainLib.isUsableDomain(nome)) return { ok: false, erro: "invalid" };

  const col = await this.collection();
  const agora = new Date();

  try {
    await col.updateOne(
      { user: new ObjectId(userId) },
      {
        $set: { customDomain: nome, customStatus: "pending", customError: null, updatedAt: agora },
        $setOnInsert: { user: new ObjectId(userId), theme: theme.defaults(), createdAt: agora },
      },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code === 11000) return { ok: false, erro: "taken" };
    throw error;
  }

  return { ok: true, customDomain: nome };
};

Tenant_model.prototype.setCustomStatus = async function (userId, status, erro) {
  const col = await this.collection();
  await col.updateOne(
    { user: new ObjectId(userId) },
    { $set: { customStatus: status, customError: erro || null, updatedAt: new Date() } }
  );
};

// Sai o campo inteiro, não vira string vazia: o índice único é parcial por
// `$type: "string"`, e um "" guardado seria um valor que duas contas disputariam.
Tenant_model.prototype.removeCustomDomain = async function (userId) {
  const col = await this.collection();
  await col.updateOne(
    { user: new ObjectId(userId) },
    { $unset: { customDomain: "", customStatus: "", customError: "" }, $set: { updatedAt: new Date() } }
  );
};

Tenant_model.prototype.saveTheme = async function (userId, entrada) {
  const col = await this.collection();
  const limpo = theme.sanitize(entrada);

  await col.updateOne(
    { user: new ObjectId(userId) },
    {
      $set: { theme: limpo, updatedAt: new Date() },
      $setOnInsert: { user: new ObjectId(userId), status: "none", createdAt: new Date() },
    },
    { upsert: true }
  );

  return limpo;
};

// A moeda em que este cliente trabalha.
//
// Fica no TENANT e não na conta de cada usuário: é uma característica do
// negócio, não uma preferência de quem está logado. Dois profissionais da mesma
// clínica cobrando em moedas diferentes tornariam o caixa impossível de somar.
Tenant_model.prototype.saveCurrency = async function (userId, code, lista) {
  const col = await this.collection();

  const padrao = currencies.normalize(code);
  const habilitadas = currencies.normalizeList(lista, padrao);

  await col.updateOne(
    { user: new ObjectId(userId) },
    {
      $set: { currency: padrao, currencies: habilitadas, updatedAt: new Date() },
      $setOnInsert: { user: new ObjectId(userId), status: "none", createdAt: new Date() },
    },
    { upsert: true }
  );

  return { currency: padrao, currencies: habilitadas };
};

// As moedas da INSTÂNCIA, não as de um usuário: o financeiro é do cliente
// inteiro, e todo mundo que abre a tela tem de ver as mesmas opções.
// O FUSO da conta, e por que ele é uma configuração.
//
// O servidor roda em UTC de propósito — assim ele muda de máquina sem reescrever
// a agenda de ninguém. Só que "08:00" na grade da semana é hora de PAREDE, do
// relógio de quem atende, e alguém precisa dizer de qual relógio se trata.
//
// Sem isto, a hora de parede era lida no fuso do PROCESSO: o estúdio digitava 8
// e o cliente via 5, com o servidor em UTC e o navegador em Brasília.
Tenant_model.prototype.timezoneOfInstance = async function () {
  const doc = await this.dataOfInstance();
  return tempo.normalizar(doc?.timezone);
};

Tenant_model.prototype.saveTimezone = async function (userId, fuso) {
  if (!tempo.valido(fuso)) return null;

  const col = await this.collection();

  await col.updateOne(
    { user: new ObjectId(userId) },
    {
      $set: { timezone: fuso, updatedAt: new Date() },
      $setOnInsert: { user: new ObjectId(userId), status: "none", createdAt: new Date() },
    },
    { upsert: true }
  );

  return fuso;
};

// ── O DONO da instância ────────────────────────────────────────────────────
//
// Quem grava configuração DA CONTA precisa gravar no documento do dono, e não no
// de quem clicou.
//
// Isto conserta uma armadilha que já existe aqui: `saveTimezone`, `saveCurrency` e
// `saveTheme` recebem `userId` e gravam em `{ user: userId }`, mas os leitores
// (`timezoneOfInstance`, `currencyOfInstance`, `dataOfInstance`) leem o documento
// do profissional MAIS ANTIGO. Numa conta com uma pessoa só os dois são o mesmo
// documento e nada aparece. Numa equipe, um profissional com permissão salva o
// fuso, a resposta diz que salvou, e o fuso da conta não muda — porque a escrita
// foi para outro documento.
//
// As funções novas abaixo passam por aqui de propósito, para não repetir isso.
Tenant_model.prototype.ownerId = async function () {
  const users = await this.app.api.user.collection();

  // A mesma regra de `dataOfInstance`: o trainer mais antigo é a conta criada no
  // provisionamento, o dono do negócio. `createdAt` e não `_id`, para não depender
  // de um detalhe do driver.
  const dono = await users.findOne({ type: "trainer" }, { sort: { createdAt: 1 } });
  return dono?._id;
};

// ── O VOCABULÁRIO: aluno, paciente, cliente ────────────────────────────────
//
// Da CONTA, e não de cada pessoa.
//
// Ele morava no documento do usuário, e o efeito prático era ruim: quem entrava
// na equipe depois não herdava a palavra — caía em "pessoa/pessoas". O dono dizia
// "cadastra o cliente" e a tela da recepção dizia "Pessoas".
//
// Existe um argumento para ser por pessoa (clínica com nutricionista e personal
// falando "paciente" e "aluno" sobre as mesmas pessoas), e ele foi considerado e
// recusado: uma conta é um negócio, e um negócio fala de um jeito.
const PALAVRAS_PADRAO = { singular: "pessoa", plural: "pessoas" };

function limparPalavra(v) {
  // Minúscula porque as telas capitalizam onde precisam — "Aluno" digitado aqui
  // viraria "ALunos" no meio de uma frase.
  return String(v || "").trim().toLowerCase().slice(0, 30);
}

// A leitura tem TRÊS degraus, e o do meio é o que faz a mudança de lugar não
// quebrar nada:
//
//   1. o documento da conta (`tenants`) — onde a palavra passou a morar
//   2. o documento do DONO (`users.peopleSingular`) — onde ela morava antes
//   3. "pessoa / pessoas"
//
// Sem o degrau 2, o instante entre subir este código e rodar a migração seria uma
// conta inteira falando "pessoa" — e quem estivesse com a tela aberta veria o
// vocabulário desaparecer sem ter mexido em nada.
//
// O degrau 2 sai depois de a migração rodar em todas as instâncias. Enquanto
// estiver aqui, ele não custa consulta nenhuma: `dataOfInstance` já buscou o dono.
Tenant_model.prototype.wordsOfInstance = async function () {
  const doc = await this.dataOfInstance();

  if (limparPalavra(doc?.peopleSingular) && limparPalavra(doc?.peoplePlural)) {
    return {
      singular: limparPalavra(doc.peopleSingular),
      plural: limparPalavra(doc.peoplePlural),
    };
  }

  const dono = await this.ownerId();
  const antigo = dono ? await this.app.api.user.data(dono) : undefined;

  return {
    singular:
      limparPalavra(doc?.peopleSingular) ||
      limparPalavra(antigo?.peopleSingular) ||
      PALAVRAS_PADRAO.singular,
    plural:
      limparPalavra(doc?.peoplePlural) ||
      limparPalavra(antigo?.peoplePlural) ||
      PALAVRAS_PADRAO.plural,
  };
};

// Grava no documento do DONO, venha de quem vier. Ver `ownerId` acima.
Tenant_model.prototype.saveWords = async function (entrada) {
  const singular = limparPalavra(entrada?.peopleSingular);
  const plural = limparPalavra(entrada?.peoplePlural);

  // As duas juntas ou nenhuma: gravar só o singular deixaria a conta dizendo
  // "cliente" no singular e "pessoas" no plural, na mesma tela.
  if (!singular || !plural) return null;

  const dono = await this.ownerId();
  if (!dono) return null;

  const col = await this.collection();

  await col.updateOne(
    { user: new ObjectId(dono) },
    {
      $set: { peopleSingular: singular, peoplePlural: plural, updatedAt: new Date() },
      $setOnInsert: { user: new ObjectId(dono), status: "none", createdAt: new Date() },
    },
    { upsert: true }
  );

  return { singular, plural };
};

// ── O IDIOMA PADRÃO da conta ───────────────────────────────────────────────
//
// Diferente do vocabulário: aqui a conta define o PADRÃO e cada pessoa pode
// escolher o dela. É a divisão certa porque as duas coisas respondem perguntas
// diferentes — a palavra é do negócio, a língua é de quem lê.
//
// O padrão da conta serve para quem nunca escolheu: a pessoa nova da equipe, e a
// tela de entrar, que ainda não sabe quem está chegando.
Tenant_model.prototype.languageOfInstance = async function () {
  const { normalizeLanguage } = require("../lib/i18n");
  const doc = await this.dataOfInstance();
  return doc?.language ? normalizeLanguage(doc.language) : undefined;
};

Tenant_model.prototype.saveLanguage = async function (idioma) {
  const { LANGUAGES } = require("../lib/i18n");

  // Conferido contra a lista CRUA, e não passando por `normalizeLanguage`.
  //
  // Normalizar é certo para LER (qualquer coisa estranha cai no padrão) e errado
  // para GRAVAR: um idioma digitado errado viraria "pt-BR" gravado como se
  // alguém tivesse escolhido português.
  const alvo = String(idioma || "").trim();
  if (!LANGUAGES.includes(alvo)) return null;

  const dono = await this.ownerId();
  if (!dono) return null;

  const col = await this.collection();

  await col.updateOne(
    { user: new ObjectId(dono) },
    {
      $set: { language: alvo, updatedAt: new Date() },
      $setOnInsert: { user: new ObjectId(dono), status: "none", createdAt: new Date() },
    },
    { upsert: true }
  );

  return alvo;
};

Tenant_model.prototype.currencyOfInstance = async function () {
  const doc = await this.dataOfInstance();

  const padrao = currencies.normalize(doc?.currency);
  return {
    currency: padrao,
    // Conta antiga não tem a lista: ela trabalha com a padrão, e só.
    currencies: currencies.normalizeList(doc?.currencies, padrao),
  };
};

// A moeda de um lançamento: a pedida, se estiver habilitada; senão a padrão.
//
// Recusar seria pior: um pedido com moeda desabilitada viraria erro de tela
// numa situação em que a resposta certa é óbvia.
Tenant_model.prototype.currencyFor = async function (pedida) {
  const { currency, currencies: habilitadas } = await this.currencyOfInstance();

  const alvo = String(pedida || "").toUpperCase();
  return habilitadas.includes(alvo) ? alvo : currency;
};

// O que a tela de login recebe, sem sessão nenhuma.
//
// Só aparência: nada de dono, e-mail ou id. Um endereço público não pode
// entregar de quem ele é.
Tenant_model.prototype.publicTheme = function (doc) {
  const t = theme.sanitize(doc?.theme);
  return { theme: t, scale: theme.scale(t.brand) };
};

module.exports = Tenant_model;
