const { ObjectId } = require("mongodb");
const currencies = require("../lib/currencies.js");
const tempo = require("../lib/tempo.js");

const theme = require("../lib/theme.js");
const domainLib = require("../lib/domain.js");
const photoSides = require("../lib/assessmentPhotoSides.js");

// A CONFIGURAÇÃO DA CASA: o endereço, a marca, o vocabulário, a moeda, o fuso e
// o assistente. Um documento por instância, na collection `configurations`.
//
// ── POR QUE DEIXOU DE SER `tenants` ────────────────────────────────────────
//
// Lá o documento era chaveado pelo USUÁRIO — "um profissional, um domínio" —, e
// isso fazia sentido no tempo de banco único, quando vários profissionais
// dividiam a mesma base e cada um queria o próprio endereço. Com um banco por
// cliente, a instância JÁ é o negócio: a chave por usuário virou um lugar onde
// a mesma casa podia ter duas marcas.
//
// E cobrou. O Marlon entrou em `will.gofitnow.fit` com a conta dele (usuário da
// casa, não o dono): o `/me/tenant` procurou o documento DELE, não achou, e o
// web aplicou esse vazio por cima do tema que o host já tinha carregado — logo
// e cores do Willian sumiram no instante em que ele entrou. Se ele tivesse
// salvo a Aparência, teria criado um segundo tema que ninguém mais veria.
//
// Aqui não há chave por dono: `{ chave: "instancia" }`, com índice único. Um
// segundo documento é recusado pelo BANCO, e não pela boa vontade do código.
//
// O `userId` que vários métodos ainda recebem virou HISTÓRICO (quem mexeu, para
// a auditoria) — nunca mais o endereço do documento.
const CHAVE = { chave: "instancia" };

function Tenant_model(app) {
  this.app = app;
}

Tenant_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("configurations");
};

// O documento da casa. É este o método; todo o resto lê dele.
Tenant_model.prototype.data = async function () {
  const col = await this.collection();
  return (await col.findOne(CHAVE)) || undefined;
};

// Gravar é sempre no MESMO documento, com upsert: uma instância que ainda não
// configurou nada não pode perder o primeiro salvamento.
Tenant_model.prototype.gravar = async function (set) {
  const col = await this.collection();

  await col.updateOne(
    CHAVE,
    { $set: { ...set, updatedAt: new Date() }, $setOnInsert: { ...CHAVE, createdAt: new Date() } },
    { upsert: true }
  );
};

Tenant_model.prototype.remover = async function (campos) {
  const col = await this.collection();
  await col.updateOne(CHAVE, { $unset: campos, $set: { updatedAt: new Date() } });
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

// A configuração DA INSTÂNCIA.
//
// Antes isto era uma busca em três passos — achar o profissional mais antigo,
// assumir que ele era o dono, ler o documento dele — e existia só para
// contornar a chave por usuário. Com o documento único, é uma leitura direta.
//
// O nome fica: são 44 chamadas espalhadas, e `dataOfInstance` continua dizendo
// exatamente o que faz.
Tenant_model.prototype.dataOfInstance = async function () {
  return this.data();
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
      CHAVE,
      {
        $set: { subdomain: nome, status: "pending", updatedAt: agora, criadoPor: new ObjectId(userId) },
        $setOnInsert: { ...CHAVE, theme: theme.defaults(), createdAt: agora },
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
    CHAVE,
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
      CHAVE,
      {
        $set: { customDomain: nome, customStatus: "pending", customError: null, updatedAt: agora },
        $setOnInsert: { ...CHAVE, theme: theme.defaults(), createdAt: agora },
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
    CHAVE,
    { $set: { customStatus: status, customError: erro || null, updatedAt: new Date() } }
  );
};

// Sai o campo inteiro, não vira string vazia: o índice único é parcial por
// `$type: "string"`, e um "" guardado seria um valor que duas contas disputariam.
Tenant_model.prototype.removeCustomDomain = async function (userId) {
  const col = await this.collection();
  await col.updateOne(
    CHAVE,
    { $unset: { customDomain: "", customStatus: "", customError: "" }, $set: { updatedAt: new Date() } }
  );
};

// ── A APARÊNCIA É DA INSTÂNCIA, e o documento tem UM dono ─────────────────
//
// Gravava no tenant de QUEM SALVOU, e isso partia a marca em duas: um segundo
// usuário da equipe que abrisse a Aparência criava um tema paralelo, que os
// outros nunca veriam. Uma instância é UM negócio com UMA marca — a mesma regra
// que a leitura segue.
//
// `userId` continua na assinatura porque é ele quem entra na auditoria: quem
// mexeu na marca da casa importa, mesmo que o documento seja o da casa.
Tenant_model.prototype.saveTheme = async function (userId, entrada) {
  const col = await this.collection();
  const limpo = theme.sanitize(entrada);

  // Sem contorno nenhum: o documento é o da casa, e é sempre o mesmo. A busca
  // pelo dono que existia aqui era para achar em qual documento gravar — a
  // pergunta deixou de existir junto com a chave por usuário.
  await col.updateOne(
    CHAVE,
    {
      $set: { theme: limpo, updatedAt: new Date(), temaPor: new ObjectId(userId) },
      $setOnInsert: { ...CHAVE, status: "none", createdAt: new Date() },
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
    CHAVE,
    {
      $set: { currency: padrao, currencies: habilitadas, updatedAt: new Date() },
      $setOnInsert: { ...CHAVE, status: "none", createdAt: new Date() },
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
    CHAVE,
    {
      $set: { timezone: fuso, updatedAt: new Date() },
      $setOnInsert: { ...CHAVE, status: "none", createdAt: new Date() },
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

// Grava no documento ÚNICO da instância — o mesmo que `wordsOfInstance` lê.
//
// ── O DEFEITO QUE MOROU AQUI ───────────────────────────────────────────────
//
// Isto gravava em `{ user: dono }`, da época da chave por usuário. Quando o
// documento virou único (`{ chave: "instancia" }`), a LEITURA foi migrada e a
// escrita não: salvar o vocabulário passou a criar um segundo documento em
// `configurations` que ninguém lê.
//
// E foi um defeito calado, o pior tipo. A tela dizia "salvo", a rota respondia
// 200 com as palavras certas, e a interface continuava mostrando as antigas —
// porque o degrau de compatibilidade do leitor (`users.peopleSingular`, o lugar
// de antes) seguia respondendo. Quem trocasse "aluno" por "paciente" veria a
// confirmação e nenhuma mudança, sem erro em lugar nenhum.
//
// Daí `gravar()`, e não um `updateOne` próprio: é a função que já sabe onde é o
// documento da casa, e passar por ela é o que impede a próxima configuração de
// repetir isto.
Tenant_model.prototype.saveWords = async function (entrada) {
  const singular = limparPalavra(entrada?.peopleSingular);
  const plural = limparPalavra(entrada?.peoplePlural);

  // As duas juntas ou nenhuma: gravar só o singular deixaria a conta dizendo
  // "cliente" no singular e "pessoas" no plural, na mesma tela.
  if (!singular || !plural) return null;

  await this.gravar({ peopleSingular: singular, peoplePlural: plural });

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

  // Documento único, como o vocabulário e pelo mesmo motivo: `languageOfInstance`
  // lê daqui. Ver a nota em `saveWords`.
  await this.gravar({ language: alvo });

  return alvo;
};

// VESTE um usuário com o que é da CONTA, antes de ele sair pela API.
//
// O vocabulário mora na conta, mas TODA a interface o lê de `user.peopleSingular`
// (peopleWords no menuConfig) — a fonte mudou, a forma não. Quem monta uma
// resposta com um usuário dentro precisa passar por aqui, senão devolve o campo
// FÓSSIL do documento (a palavra que o dono escolheu no cadastro e nunca mais).
//
// Foi exatamente esse o defeito: o `GET /me` vestia e o `/auth/verify` não. O app
// bota pelo verify — então salvar a palavra funcionava, a tela trocava... e o F5
// ressuscitava a antiga, porque o boot lia o fóssil. Um F5 que DESFAZ o que foi
// salvo é o tipo de defeito que faz a pessoa desconfiar do salvar inteiro.
//
// O idioma segue regra diferente do vocabulário, de propósito: a conta define o
// PADRÃO e cada pessoa pode ter o dela — então o pessoal ganha, e o padrão só
// aparece para quem nunca escolheu.
Tenant_model.prototype.vestirComAConta = async function (usuario) {
  const payload = { ...usuario };

  try {
    const [palavras, idiomaDaConta, acompanhadoPor] = await Promise.all([
      this.wordsOfInstance(),
      this.languageOfInstance(),
      // ── SOU ACOMPANHADO POR ALGUÉM? ────────────────────────────────────
      //
      // Não é dado da conta como o resto daqui, mas viaja no mesmo funil pela
      // mesma razão: TODA rota que devolve um usuário passa por este método, e
      // a tela precisa saber disso já no boot para decidir se oferece a área de
      // quem é atendido.
      //
      // Existe porque profissional TAMBÉM pode ser atendido: o Marlon é dono da
      // conta dele e paciente na do Willian, com dietas montadas para ele que
      // tela nenhuma alcançava. Sem este campo, a única forma de descobrir
      // seria bater numa rota e ler um 403 — pedir para levar não.
      //
      // Uma contagem com índice (`by_person` em professional_links); o verify
      // roda a cada abertura, e por isso ela não pode ser cara.
      this.app.api.link.countProfessionalsOf(usuario._id),
    ]);

    payload.peopleSingular = palavras.singular;
    payload.peoplePlural = palavras.plural;
    payload.accountLanguage = idiomaDaConta || null;
    payload.lang = usuario.lang || idiomaDaConta || undefined;
    payload.acompanhado = acompanhadoPor > 0;
  } catch (error) {
    // Nunca derruba a resposta que o chamador ia dar: sem as palavras a
    // interface cai no padrão "pessoa/pessoas", que é feio e funciona.
    console.error("[tenant] não consegui vestir o usuário com a conta:", error.message);
  }

  // ── O ASSISTENTE ESTÁ LIGADO? ─────────────────────────────────────────────
  //
  // Viaja no `user` pelo mesmo motivo do vocabulário: a BOLINHA do assistente é
  // desenhada em toda tela, e uma decisão que ela precisa saber no boot não pode
  // custar uma requisição por navegação.
  //
  // Num `try` PRÓPRIO, e não junto do resto. Ele nasceu dentro daquele
  // `Promise.all` e os testes mostraram o preço na hora: uma leitura que falha
  // ali derruba as três irmãs, e a pessoa perde o VOCABULÁRIO por causa de um
  // campo de bolinha. O menos importante não pode custar o mais importante.
  //
  // Ligado é a AUSÊNCIA: só um `false` gravado desliga. Ler ausência como
  // desligado tiraria o assistente de todas as contas no instante do deploy.
  try {
    const doc = await this.dataOfInstance();
    payload.aiEnabled = doc?.ai?.enabled !== false;
  } catch (error) {
    // Sem resposta, a bolinha aparece: é o estado de sempre, e esconder o
    // assistente por causa de uma leitura que falhou seria tirar da pessoa uma
    // coisa que ela tem.
    payload.aiEnabled = true;
  }

  // ── OS MENUS QUE ESTA CONTA NÃO LIBEROU ───────────────────────────────────
  //
  // Viaja no `user` pela razão do vocabulário e da bolinha do assistente: a
  // barra lateral é desenhada em toda navegação, e uma decisão que ela precisa
  // saber na primeira pintura não pode custar uma requisição por tela. Sem isso
  // o menu de um módulo não liberado apareceria por um instante e sumiria — o
  // pior dos dois mundos, porque a pessoa clica no que está vendo.
  //
  // `try` PRÓPRIO, como o do assistente e pelo mesmo motivo: uma leitura que
  // falha aqui não pode custar o vocabulário de quem chamou.
  //
  // E FALHA ABRINDO: sem resposta, nada é escondido. Esconder Aulões de quem
  // está com a aula de sábado aberta, porque uma consulta não voltou, é tirar da
  // pessoa uma coisa que ela tem — a mesma regra que deixa a bolinha acesa.
  try {
    payload.menusEscondidos = await this.app.api.modulo.menusEscondidos();
  } catch (error) {
    payload.menusEscondidos = [];
  }

  return payload;
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

// ── OS ÂNGULOS DA FOTO DE EVOLUÇÃO ─────────────────────────────────────────
//
// Da CASA, como o vocabulário: a avaliação física de uma clínica de nutrição e a
// de quem prepara atleta para palco não fotografam a mesma coisa, e antes disto
// as duas eram obrigadas aos mesmos quatro ângulos.
//
// A leitura distingue "nunca configurou" de "configurou e apagou tudo" — a
// primeira quer os quatro de fábrica, a segunda quer nenhum. Quem separa os dois
// é `lib/assessmentPhotoSides.js`; aqui só se busca o documento.
Tenant_model.prototype.assessmentPhotoSides = async function () {
  const doc = await this.dataOfInstance();
  return photoSides.daInstancia(doc?.assessmentPhotoSides);
};

// Grava no documento ÚNICO da instância (`gravar`), e não em `{ user: dono }`.
//
// A distinção não é estilo: `saveWords` e `saveLanguage` ainda escrevem pela
// chave antiga, e os leitores já leem o documento único — é dívida de uma
// migração que passou pela leitura e não pela escrita, e copiá-la aqui seria
// criar um segundo lugar onde salvar não salva.
Tenant_model.prototype.saveAssessmentPhotoSides = async function (entrada) {
  const lista = photoSides.normalizar(entrada);
  if (!lista) return null;

  await this.gravar({ assessmentPhotoSides: lista });
  return lista;
};

module.exports = Tenant_model;
