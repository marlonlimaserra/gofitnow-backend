const sessaoGuardada = require("../lib/sessaoGuardada.js");
const telefones = require("../lib/telefone.js");
const { ObjectId } = require("mongodb");
const permissionCatalog = require("../lib/permissions.js");
const instanceContext = require("../lib/instance.js");
const tempo = require("../lib/tempo.js");
const { porPagina } = require("../lib/tetoDaLista.js");

// The `users` collection — every person in the system.
//
//   type: "trainer"  → a professional: follows people and manages their plans
//   type: "student"  → a person being followed
//
// A person is NOT owned by one professional. Who follows whom lives in
// `professional_links` (see Link_model), so the same person can be followed by
// an endocrinologist, a nutritionist and a personal trainer at once, each
// seeing the same record. `createdBy` only says who first registered the
// profile — it grants nothing on its own.
//
// `role` points at a document in `roles` and is what decides everything the
// user may DO. Several users share a role, and a role can be created on the
// Tipos de usuário screen — that is what makes a second admin-equivalent type
// possible without touching code.
//
// `admin: true` is the one exception: a MASTER SWITCH that grants every
// permission that exists, re-evaluated on each request. A permission shipped
// next month is already granted, so an owner can never be locked out of a
// screen they have not heard of yet. No role can express that — a role stores
// a fixed list, and a list written today cannot contain tomorrow's keys.
//
// Profile fields (weight, height, goal…) only make sense on a person being
// followed, but they sit on the same document — a separate collection would
// not pay off.
//
// `password`/`salt` stay null while a person has no access yet: a professional
// can register the profile before there is a login.
function User_model(app) {
  this.app = app;
}

const TYPES = ["trainer", "student"];

// Sexo biologico, que e o que entra em IMC e gasto calorico. Vazio significa
// nao informado — e como ficam as fichas cadastradas antes deste campo existir.
const SEXES = ["female", "male"];

// A UNIDADE de uma pessoa: um id, ou nada.
//
// Id inválido vira NADA, e não erro: o pior caso de um vínculo sujo é a pessoa
// ficar sem unidade — que é o estado normal de quem nunca escolheu uma —, e
// recusar a gravação inteira por causa dele perderia o resto do formulário.
function unidade(v) {
  const id = String(v || "").trim();
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

// ── AS UNIDADES A QUE UM USUÁRIO DA EQUIPE TEM ACESSO ───────────────────
//
// *"aqui, no usuário, quero poder escolher quais unidades ele tem acesso"*.
//
// Plural aqui e singular na pessoa, e a assimetria é o desenho: um aluno
// TREINA numa unidade, um recepcionista ATENDE em duas. São perguntas
// diferentes, e usar uma lista dos dois lados faria a pessoa poder estar em
// duas academias ao mesmo tempo.
//
// VAZIO QUER DIZER TODAS, e não "nenhuma". É a leitura que não estraga nada:
// toda conta que existe hoje tem a lista vazia, e nenhuma delas pode acordar
// amanhã sem ver ninguém. Quem quiser restringir, escolhe.
const MAX_UNIDADES = 50;

function unidades(v) {
  if (!Array.isArray(v)) return [];

  const vistas = new Set();
  const saida = [];

  for (const x of v) {
    const id = String(x || "");
    if (!ObjectId.isValid(id) || vistas.has(id)) continue;
    vistas.add(id);
    saida.push(new ObjectId(id));
    if (saida.length >= MAX_UNIDADES) break;
  }

  return saida;
}

User_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("users");
};

// SHA-512 with a per-user salt. The salt is drawn at signup and stored next to
// the document — without it, two identical passwords would hash the same.
User_model.prototype.generateSalt = function () {
  return this.app.crypto.randomBytes(16).toString("hex");
};

User_model.prototype.hashPassword = function (password, salt) {
  return this.app.crypto
    .createHash("sha512")
    .update(salt + ":" + password)
    .digest("base64");
};

// Never let password/salt leave the backend. `hasAccess` tells the screen what
// it needs to know (whether the person can log in) without exposing the hash.
User_model.prototype.filter = function (doc) {
  if (!doc) return doc;
  const { password, salt, ...rest } = doc;
  rest.hasAccess = !!password;
  return rest;
};

// The same document plus the role it points at, resolved into a name and a
// flat list of permission keys. This is what the frontend needs to decide
// which menus exist, and what every route guard reads.
User_model.prototype.withRole = async function (doc) {
  if (!doc) return doc;

  const user = this.filter(doc);
  const role = doc.role ? await this.app.api.role.data(doc.role) : undefined;

  user.roleName = role ? role.name : "";
  user.admin = doc.admin === true;

  // ── A SOMA: o TIPO mais os GRUPOS ────────────────────────────────────────
  //
  // *"aí posso pôr usuários nesse grupo, aí as permissões se somam"*
  // (26/09/2026).
  //
  // União pura, e nunca subtração: um grupo só ACRESCENTA ao que o tipo já dá.
  // Com soma e subtração juntas, responder "por que fulano não abre o
  // financeiro?" exigiria simular a ordem das regras; assim a pergunta é sempre
  // a mesma — quem dá? — e se responde olhando o tipo e os grupos.
  //
  // Este é o ÚNICO lugar onde `permissions` nasce, e é de propósito: é ele que
  // toda rota lê pelo `ReqProtected`, e é ele que o frontend recebe para
  // decidir que menu existe. Somar em dois lugares seria a garantia de que um
  // dos dois ficaria para trás.
  //
  // The master switch is read from the catalog, not from a stored list, so it
  // covers permissions that did not exist when the account was created.
  // Without it, no role means NO permissions — never "everything": a user
  // whose role was deleted must lose access, not inherit it.
  if (user.admin) {
    user.permissions = [...permissionCatalog.ALL];
    user.groups = Array.isArray(doc.groups) ? doc.groups.map(String) : [];
    return user;
  }

  const doTipo = role ? role.permissions || [] : [];
  const dosGrupos = await this.app.api.permissionGroup.permissoesDe(doc.groups);

  user.permissions = [...new Set([...doTipo, ...dosGrupos])];
  user.groups = Array.isArray(doc.groups) ? doc.groups.map(String) : [];

  return user;
};

// What a user may do, master switch included. Used by the guards that need to
// know whether somebody holds a permission WITHOUT loading a full session.
User_model.prototype.hasPermission = async function (doc, permission) {
  if (!doc) return false;
  if (doc.admin === true) return true;

  if (await this.app.api.role.grants(doc.role, permission)) return true;

  // E os GRUPOS, pela mesma soma de `withRole`. Sem esta linha existiriam dois
  // entendimentos de "o que esta pessoa pode" no mesmo servidor — e o segundo,
  // este, é o que alguns guardas usam quando não há sessão carregada.
  const dosGrupos = await this.app.api.permissionGroup.permissoesDe(doc.groups);
  return dosGrupos.includes(permission);
};

// An empty e-mail is stored as an ABSENT field, not as "". The unique index is
// partial (only where `email` exists), so two students without an e-mail can
// coexist, while two with "" would collide.
function normalizeEmail(email) {
  const v = String(email == null ? "" : email)
    .trim()
    .toLowerCase();
  return v === "" ? null : v;
}

// ── Nome de usuário ────────────────────────────────────────────────────────
//
// Alternativa ao e-mail para entrar: `marlon` em vez de marlon.20rj@gmail.com.
//
// A regra é apertada de propósito, e a razão é uma só: o campo de login aceita as
// DUAS coisas, então nome de usuário e e-mail não podem se confundir. Sem `@` e
// sem ponto, "marlon" nunca é lido como endereço e "a@b.com" nunca é lido como
// nome — o servidor decide qual dos dois é sem precisar adivinhar.
//
// Mínimo de 3 para não colidir com o hábito de digitar uma letra e dar enter.
// Começa por letra ou número para não existir `-marlon` e `marlon` como coisas
// diferentes que ninguém distingue de relance.
const USERNAME_PADRAO = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/;

// Nomes que não podem ser de ninguém. `admin` e `suporte` porque um nome desses
// numa conversa faz a pessoa achar que está falando com a plataforma; o resto
// porque são endereços nossos e viram confusão na hora de explicar onde entrar.
const USERNAME_RESERVADOS = new Set([
  "admin",
  "administrador",
  "root",
  "suporte",
  "support",
  "gofitnow",
  "sistema",
  "system",
  "app",
  "api",
  "www",
  "backend",
  "central",
  "center",
]);

function normalizeUsername(username) {
  const v = String(username == null ? "" : username)
    .trim()
    .toLowerCase();
  return v === "" ? null : v;
}

// Devolve o nome pronto para gravar, ou o MOTIVO da recusa. Um booleano faria a
// tela dizer "inválido" sem dizer o quê, e a pessoa tentaria de novo no escuro.
function checkUsername(username) {
  const v = normalizeUsername(username);
  if (v === null) return { ok: true, value: null }; // não ter é permitido

  if (v.includes("@")) return { ok: false, reason: "at" };
  if (v.includes(".")) return { ok: false, reason: "dot" };
  if (v.length < 3) return { ok: false, reason: "short" };
  if (v.length > 32) return { ok: false, reason: "long" };
  if (!USERNAME_PADRAO.test(v)) return { ok: false, reason: "chars" };
  if (USERNAME_RESERVADOS.has(v)) return { ok: false, reason: "reserved" };

  return { ok: true, value: v };
}

// O que a pessoa digitou no campo de login: e-mail ou nome de usuário?
//
// O `@` é o que separa, e não uma lista de domínios: qualquer coisa com arroba é
// tentativa de e-mail, mesmo escrita errada — e tratá-la como nome de usuário
// faria a busca falhar por um motivo que não é o verdadeiro.
function looksLikeEmail(identificador) {
  return String(identificador || "").includes("@");
}

User_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// Só os nomes, de vários ids de uma vez.
//
// Existe para a lista geral de treinos: cada treino guarda o id da pessoa, e a
// tela precisa do nome. Buscar um por um seriam dezenas de idas ao banco numa
// única abertura de tela; aqui é uma só, e volta um Map pronto para consulta.
User_model.prototype.namesByIds = async function (ids) {
  const validos = [...new Set((ids || []).map(String))]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  if (!validos.length) return new Map();

  const col = await this.collection();
  const docs = await col.find({ _id: { $in: validos } }, { projection: { name: 1 } }).toArray();

  return new Map(docs.map((d) => [String(d._id), d.name]));
};

// Nome, e-mail e WhatsApp de várias contas de uma vez — o que a PLANILHA do
// financeiro precisa.
//
// Existe separado de `namesByIds` pela mesma razão do `briefByIds`: aquele
// devolve um Map de id → nome cru, consumido em vários lugares para escrever um
// nome solto. Acrescentar campo lá mudaria o formato para todos eles.
//
// O contato entra na exportação, e não na tela: *"coloque o e-mail e whatsapp
// também"*. Quem recebe a planilha para cobrar precisa de por onde falar, e
// abrir a ficha de trinta pessoas para copiar trinta telefones é o trabalho que
// a exportação existe para tirar. Quem pode chamar isto já é `finance.view`, que
// é a mesma permissão que abre a lista de pessoas com os contatos à mostra.
User_model.prototype.contactsByIds = async function (ids) {
  const validos = [...new Set((ids || []).map(String))]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  if (!validos.length) return new Map();

  const col = await this.collection();
  const docs = await col
    .find({ _id: { $in: validos } }, { projection: { name: 1, email: 1, phone: 1 } })
    .toArray();

  return new Map(
    docs.map((d) => [String(d._id), { name: d.name, email: d.email || "", phone: d.phone || "" }])
  );
};

// Nome e avatar de várias contas de uma vez — o mínimo para desenhar uma
// pessoa numa lista.
//
// Separado de `namesByIds` porque ali o retorno é um Map de id → nome, usado em
// vários lugares para escrever um nome solto. Acrescentar campo àquele mudaria
// o formato para todo mundo que já o consome.
User_model.prototype.briefByIds = async function (ids) {
  const validos = [...new Set((ids || []).map(String))]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  if (!validos.length) return {};

  const col = await this.collection();
  const docs = await col
    .find({ _id: { $in: validos } }, { projection: { name: 1, avatarAt: 1, bio: 1 } })
    .toArray();

  return Object.fromEntries(
    docs.map((d) => [
      String(d._id),
      { name: d.name, avatarAt: d.avatarAt || null, bio: d.bio || "" },
    ])
  );
};

// Os profissionais deste cliente — as contas que atendem.
//
// É `type: trainer` e não "quem tem permissão de agenda": permissão diz o que a
// conta PODE fazer, e a lista aqui responde quem EXISTE para ser escolhido. Uma
// recepcionista com acesso à agenda não é alguém a quem se marca um horário.
User_model.prototype.professionals = async function () {
  const col = await this.collection();

  const docs = await col
    .find({ type: "trainer" }, { projection: { name: 1, avatarAt: 1, bio: 1 } })
    .sort({ name: 1 })
    .toArray();

  return docs.map((d) => ({
    _id: d._id,
    name: d.name,
    avatarAt: d.avatarAt || null,
    bio: d.bio || "",
  }));
};

User_model.prototype.professionalIds = async function () {
  return (await this.professionals()).map((p) => p._id);
};

User_model.prototype.dataByEmail = async function (email) {
  const e = normalizeEmail(email);
  if (!e) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ email: e });
  return doc || undefined;
};

User_model.prototype.dataByUsername = async function (username) {
  const u = normalizeUsername(username);
  if (!u) return undefined;
  const col = await this.collection();
  // Busca pelo valor JÁ normalizado: é assim que ele é gravado, e comparar sem
  // normalizar faria "Marlon" não achar "marlon".
  const doc = await col.findOne({ username: u });
  return doc || undefined;
};

// Um identificador, dois jeitos de ser de alguém. É o que a tela de login manda.
User_model.prototype.dataByLogin = async function (identificador) {
  return looksLikeEmail(identificador)
    ? this.dataByEmail(identificador)
    : this.dataByUsername(identificador);
};

// Está livre? Usado antes de gravar, para a tela poder dizer na hora.
//
// O índice único é quem de fato garante — esta checagem perde a corrida entre
// duas requisições simultâneas. Ela existe para a MENSAGEM ser boa, não para a
// garantia.
User_model.prototype.usernameAvailable = async function (username, exceptId) {
  const doc = await this.dataByUsername(username);
  if (!doc) return true;
  return Boolean(exceptId) && String(doc._id) === String(exceptId);
};

// ── Trainers (the "clients" from the admin's point of view) ──────────────

User_model.prototype.insertTrainer = async function (obj) {
  const col = await this.collection();
  const salt = this.generateSalt();

  // Nome de usuário inválido RECUSA o cadastro em vez de criar a conta sem ele:
  // criar e ignorar o campo deixaria a pessoa achando que pode entrar por um nome
  // que não existe.
  const nomeUsuario = checkUsername(obj.username);
  if (!nomeUsuario.ok) return { erro: "username", motivo: nomeUsuario.reason };

  const r = await col.insertOne({
    name: String(obj.name).trim(),
    email: normalizeEmail(obj.email),
    // Só entra no documento quando existe. `null` gravado colidiria no índice
    // único a partir da segunda conta sem nome de usuário.
    ...(nomeUsuario.value ? { username: nomeUsuario.value } : {}),
    password: this.hashPassword(obj.password, salt),
    salt: salt,
    type: "trainer",
    // Neither the role nor the master switch comes from self-signup: the
    // controller resolves them, so a crafted request cannot ask to be created
    // as an administrator.
    role: obj.role ? new ObjectId(obj.role) : null,
    admin: obj.admin === true,
    // As unidades em que ele atende. Vazio é TODAS — ver `unidades()`.
    units: unidades(obj.units),
    phone: obj.phone ? String(obj.phone).trim() : "",
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// Lists trainers — the admin view. Brings each one's student count along,
// which is what the screen shows.
User_model.prototype.listTrainers = async function (filter) {
  const col = await this.collection();

  const query = { type: "trainer" };

  if (filter && filter.search) {
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
      { username: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
    ];
  }

  if (filter && filter.active !== undefined && filter.active !== "") {
    query.active = Number(filter.active) ? 1 : 0;
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  // One aggregation over the links for the whole platform, instead of one
  // count per row — that would be N queries for a list of N.
  const byProfessional = await this.app.api.link.countsByProfessional();
  const roleNames = await this.roleNameMap();

  return docs.map((d) => ({
    ...this.filter(d),
    roleName: roleNames.get(String(d.role)) || "",
    totalStudents: byProfessional.get(String(d._id)) || 0,
  }));
};

// id → name for every role, in one read. Lists show the type on each row and
// looking it up per row would be a query per line.
User_model.prototype.roleNameMap = async function () {
  const col = await (await this.app.mongodb.connectToServer()).collection("roles");
  const docs = await col.find({}).project({ name: 1 }).toArray();
  return new Map(docs.map((d) => [String(d._id), d.name]));
};

User_model.prototype.dataTrainer = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id), type: "trainer" });
  return doc || undefined;
};

User_model.prototype.updateTrainer = async function (id, obj) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();

  // A APRESENTAÇÃO do profissional, para a página pública de agendamento.
  //
  // Fica na conta e não na página porque é sobre a PESSOA: quem escreve "Personal
  // trainer, 12 anos de CrossFit" não quer reescrever isso em cada página que
  // criar. Qual página mostra — ou se alguma mostra — é decisão da página.
  if (obj.bio !== undefined) set.bio = String(obj.bio).trim().slice(0, 600);

  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;
  if (obj.role !== undefined && ObjectId.isValid(obj.role)) set.role = new ObjectId(obj.role);
  if (obj.admin !== undefined) set.admin = obj.admin === true || obj.admin === 1;
  // Lista vazia é gravável: é assim que se tira a restrição e se devolve o
  // acesso a todas.
  if (obj.units !== undefined) set.units = unidades(obj.units);

  if (obj.email !== undefined) {
    const e = normalizeEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  // Nome de usuário: vazio APAGA o campo em vez de gravar string vazia.
  //
  // Gravar "" faria o índice único enxergar duas contas com o mesmo valor, e a
  // segunda pessoa a limpar o campo levaria erro de duplicado sem entender por
  // quê. Recusa inválido em vez de gravar torto — quem chama trata o motivo.
  if (obj.username !== undefined) {
    const conferido = checkUsername(obj.username);
    if (!conferido.ok) return { erro: "username", motivo: conferido.reason };
    if (conferido.value) set.username = conferido.value;
    else unset.username = "";
  }

  if (obj.password) {
    set.salt = this.generateSalt();
    set.password = this.hashPassword(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  const r = await col.updateOne({ _id: new ObjectId(id), type: "trainer" }, update);
  return r.matchedCount > 0;
};

User_model.prototype.deleteTrainer = async function (id) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), type: "trainer" });
  return r.deletedCount > 0;
};

User_model.prototype.countStudentsOfTrainer = async function (trainerId) {
  return await this.app.api.link.countPeopleOf(trainerId);
};

// Quantas contas de PROFISSIONAL existem nesta instância.
//
// Uma só pergunta a responde: "esta casa já tem dono?". É o que impede a rota
// interna de primeiro acesso de criar um segundo administrador em cliente que
// já está rodando.
User_model.prototype.countTrainers = async function () {
  const col = await this.collection();
  return await col.countDocuments({ type: "trainer" });
};

// How many ACTIVE accounts can still hand permissions out. Used to stop the
// last one from demoting or deleting themself and leaving the platform with
// no way back into the permission screens.
User_model.prototype.countAdmins = async function (ignoreUserId) {
  return await this.app.api.role.countActiveUsersWith("roles.manage", ignoreUserId);
};

// ── People a professional follows (always scoped through the links) ──────

// The professional never sees a person they are not linked to, and the id list
// comes from the links — never from the request.
// ── Link de cadastro ───────────────────────────────────────────────────────
//
// Um endereço público que o profissional manda por WhatsApp e a própria pessoa
// preenche. Quem chega por ele nasce já vinculado a quem mandou.
//
// É um TOKEN aleatório, e não o id do profissional na URL:
//   - id é adivinhável e permanente. Vazou uma vez, vazou para sempre, e não há
//     como cortar sem trocar o id — que outras coisas referenciam.
//   - token é trocável: um "gerar novo link" invalida o anterior na hora, o que
//     é a única defesa real contra um link que foi parar num grupo errado.
//
// Mora no documento do profissional em vez de numa collection própria: é UM por
// conta, sem histórico e sem validade — a revogação é a troca.
User_model.prototype.inviteToken = async function (trainerId, { renovar = false } = {}) {
  await sessaoGuardada.esquecerUsuario(trainerId);
  if (!ObjectId.isValid(trainerId)) return null;

  const col = await this.collection();
  const dono = await col.findOne({ _id: new ObjectId(trainerId) }, { projection: { inviteToken: 1 } });
  if (!dono) return null;

  if (dono.inviteToken && !renovar) return dono.inviteToken;

  // 24 bytes em base64url: curto o bastante para caber num WhatsApp sem quebrar
  // a linha, e longo o bastante para não ser tentado na força bruta.
  const token = this.app.crypto.randomBytes(24).toString("base64url");
  await col.updateOne(
    { _id: new ObjectId(trainerId) },
    { $set: { inviteToken: token, updatedAt: new Date() } }
  );

  return token;
};

User_model.prototype.trainerByInviteToken = async function (token) {
  const limpo = String(token || "").trim();
  // O comprimento mínimo evita que um token vazio ou "1" chegue a consultar o
  // banco — e, com ele, que alguém descubra por tempo de resposta o que existe.
  if (limpo.length < 20) return undefined;

  const col = await this.collection();
  const doc = await col.findOne({ inviteToken: limpo, type: { $ne: "student" } });
  return doc || undefined;
};

// A página da lista de pessoas, montada no BANCO.
//
// Antes esta rota devolvia a lista inteira e o navegador cortava, ordenava e
// contava. Funciona com duzentas pessoas e cai com vinte mil: a resposta cresce
// sem teto, o celular ordena tudo a cada clique, e a rede paga por 199 linhas
// que ninguém vai ver.
//
// O que obriga a ser agregação, e não um `find().sort().skip().limit()`:
// `active` e `notes` moram no VÍNCULO (professional_links), não na pessoa, e
// `hasAccess` é derivado da existência de senha. Ordenar ou filtrar por eles
// exige que existam antes do `$sort` — daí o `$lookup` e o `$addFields`.
const ORDEM_PESSOAS = {
  name: "name",
  contact: "email",
  goal: "goal",
  access: "hasAccess",
  status: "active",
  createdAt: "createdAt",
};

// ── Os filtros da tela de pessoas ──────────────────────────────────────────
//
// Três deles são de campo (`active`, `access`, período de cadastro) e um é de
// RELAÇÃO: "tem treino vencido" não é um valor guardado em lugar nenhum — é o
// que sobra de comparar os treinos da pessoa com a data de hoje.
//
// As três respostas são exclusivas entre si e cobrem todo mundo: quem tem algum
// treino vigente, quem já teve e todos venceram, e quem nunca teve.
const FILTROS_DE_TREINO = {
  current: { treinosEmDia: { $gt: 0 } },
  expired: { treinosTotal: { $gt: 0 }, treinosEmDia: 0 },
  none: { treinosTotal: 0 },
};

// O fuso da CONTA, não o do processo. O servidor roda em UTC de propósito (ver
// lib/tempo.js), então perguntar as horas a ele responde a pergunta errada.
User_model.prototype.fusoDaConta = async function () {
  try {
    return await this.app.api.tenant.timezoneOfInstance();
  } catch (error) {
    // Sem o documento do cliente ainda assim há um dia de hoje: o padrão de
    // `lib/tempo.js`. Um filtro que estoura é pior que um filtro que usa
    // Brasília numa conta que nunca escolheu fuso.
    return tempo.PADRAO;
  }
};

// "AAAA-MM-DD" nas duas pontas, qualquer uma opcional, virando um intervalo de
// instantes. Devolve `undefined` quando nenhuma das duas veio — e é isso que
// faz o filtro sumir do pipeline em vez de virar um `$match` que aceita tudo.
const DIA = /^\d{4}-\d{2}-\d{2}$/;

User_model.prototype.periodoDeCadastro = async function (filtros = {}) {
  const de = String(filtros.createdFrom || "").trim();
  const ate = String(filtros.createdTo || "").trim();
  if (!DIA.test(de) && !DIA.test(ate)) return undefined;

  const fuso = await this.fusoDaConta();
  const faixa = {};

  if (DIA.test(de)) {
    const [ano, mes, dia] = de.split("-").map(Number);
    faixa.$gte = tempo.instante({ ano, mes, dia }, fuso);
  }

  if (DIA.test(ate)) {
    const [ano, mes, dia] = ate.split("-").map(Number);
    // `dia + 1` pode passar do fim do mês; `Date.UTC`, lá dentro, vira o mês
    // seguinte sozinho — 32 de setembro é 1º de outubro.
    faixa.$lt = tempo.instante({ ano, mes, dia: dia + 1 }, fuso);
  }

  return faixa;
};

User_model.prototype.pageStudents = async function (trainerId, filtros = {}) {
  const col = await this.collection();

  // O filtro de ativo/inativo vai no VÍNCULO, que é onde o status mora — e é
  // por isso que ele some do pipeline lá embaixo.
  const ids = await this.app.api.link.personIdsOf(trainerId, { active: filtros.active });
  if (!ids.length) return { rows: [], total: 0 };

  const etapas = [{ $match: { _id: { $in: ids } } }];

  // ── SÓ OS ESCOLHIDOS ────────────────────────────────────────────────────
  //
  // *"então veja no web TUDO que fizemos de checkbox e faça no app também"*
  // (23/09/2026). Exportar o que está MARCADO precisa de um recorte por id, e
  // ele entra aqui — dentro do mesmo pipeline — em vez de virar uma consulta
  // à parte.
  //
  // O motivo é o vínculo: a lista já nasce restrita a quem é aluno DESTE
  // profissional (`ids`, logo acima). Uma consulta separada por ids buscaria
  // no banco inteiro, e bastaria alguém mandar um id de outra pessoa para ele
  // sair na planilha. Aqui os dois `$match` se somam: o que veio marcado E que
  // seja aluno dele.
  if (Array.isArray(filtros.ids) || typeof filtros.ids === "string") {
    const escolhidos = (Array.isArray(filtros.ids) ? filtros.ids : String(filtros.ids).split(","))
      .map((x) => String(x).trim())
      .filter((x) => ObjectId.isValid(x))
      .map((x) => new ObjectId(x));

    // Nenhum id VÁLIDO quer dizer nenhuma linha, e não "todas": mandar uma
    // lista de marcados que o servidor não entende e receber a base inteira
    // seria o pior resultado possível.
    etapas.push({ $match: { _id: { $in: escolhidos } } });
  }

  const termo = String(filtros.search || "").trim();
  if (termo) {
    const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    etapas.push({
      $match: {
        $or: ["name", "email", "username", "phone"].map((campo) => ({
          [campo]: { $regex: escapado, $options: "i" },
        })),
      },
    });
  }

  // ── A LENTE DA UNIDADE ──────────────────────────────────────────────────
  //
  // *"se tiver acesso a mais de uma, aparece um selectzinho ali em cima, para
  // poder escolher qual unidade eu quero navegar pelos dados"*.
  //
  // É uma LENTE, e não uma tranca. A tela escolhe por onde olhar, e a escolha
  // fica visível no alto — quem não está vendo alguém sabe por quê e desfaz
  // num clique. Uma tranca invisível esconderia gente sem dizer nada.
  //
  // ── A LENTE É ESTRITA, e a primeira versão não era ────────────────────
  //
  // Eu tinha deixado quem NÃO TEM unidade aparecer junto, com medo de a lista
  // ficar vazia numa conta que acabou de cadastrar a primeira unidade.
  //
  // O medo era real e o remédio estava errado: com quase ninguém atribuído,
  // escolher "Paraty" continuava mostrando os cem alunos — e uma lente que não
  // muda nada não parece cautelosa, parece quebrada. *"se eu to em paraty,
  // deveria mostrar as coisas só de paraty"*.
  //
  // Então ela filtra pelo que diz filtrar. A lista vazia deixou de ser um
  // risco a evitar e virou uma RESPOSTA: "nenhum aluno nesta unidade ainda", e
  // a tela oferece voltar para todas num clique. Quem não foi atribuído
  // continua alcançável em "Todas as unidades", que é onde ele de fato está.
  if (ObjectId.isValid(filtros.unit)) {
    etapas.push({ $match: { unit: new ObjectId(filtros.unit) } });
  }

  // ── Cadastrado entre tal e tal dia ───────────────────────────────────────
  //
  // `createdAt` é um INSTANTE; "de 01/09 a 13/09" é uma pergunta de CALENDÁRIO,
  // e as duas só se encontram passando pelo fuso da conta. Sem isso, quem foi
  // cadastrado às 21h em Brasília fica gravado como 00h do dia seguinte em UTC
  // e sumiria de um filtro que termina no dia dele.
  //
  // O fim é `$lt` da meia-noite do dia SEGUINTE, e não `$lte` do dia escolhido:
  // `$lte` de "13/09" pararia em 00:00 e deixaria o dia 13 inteiro de fora.
  const periodo = await this.periodoDeCadastro(filtros);
  if (periodo) etapas.push({ $match: { createdAt: periodo } });

  // A junção com o vínculo — e o `active`/`notes` que saem dela.
  //
  // Ela é a parte cara desta consulta: um `$expr` correlacionado por pessoa, que
  // o Mongo não resolve por índice. Rodá-la antes do corte custa 32ms com 215
  // pessoas; depois do corte, 5ms — porque aí são quinze junções em vez de 215.
  //
  // Só que nem sempre dá: filtrar ou ordenar por `active` precisa do campo antes
  // de escolher QUAIS quinze. Nesses dois casos ela sobe, e é o preço de filtrar
  // por algo que não mora na pessoa.
  const juntarVinculo = [
    {
      $lookup: {
        from: "professional_links",
        let: { pessoa: "$_id" },
        pipeline: [
          {
            // ── O ÚNICO LUGAR ONDE O CLIENTE É ESCRITO À MÃO ────────────────
            //
            // `lib/escopo.js` injeta o cliente em toda consulta, mas não alcança
            // DENTRO de um `$lookup`: a sub-pipeline é outra consulta, e o `from`
            // aponta para a collection inteira.
            //
            // Correção não depende disto — `person` e `professional` são
            // ObjectId, únicos globais, então nenhum vínculo de outro cliente
            // casaria. É DESEMPENHO: sem o `instance` aqui, a junção varreria os
            // vínculos de todos os clientes a cada pessoa da página.
            //
            // E os dois campos entram como IGUALDADE simples, fora do `$expr`, de
            // propósito: assim o Mongo usa o índice
            // `{ instance: 1, professional: 1, person: 1 }` pelo prefixo. Dentro
            // do `$expr` ele não usaria — que é como estava antes, quando a
            // collection era pequena porque o banco era de um cliente só.
            $match: {
              instance: instanceContext.required(),
              professional: new ObjectId(trainerId),
              $expr: { $eq: ["$person", "$$pessoa"] },
            },
          },
          { $project: { active: 1, notes: 1 } },
        ],
        as: "vinculo",
      },
    },
    {
      $addFields: {
        active: { $ifNull: [{ $arrayElemAt: ["$vinculo.active", 0] }, 1] },
        notes: { $ifNull: [{ $arrayElemAt: ["$vinculo.notes", 0] }, ""] },
      },
    },
  ];

  // `hasAccess` fica sempre antes: é campo de ordenação e não custa nada — sai
  // de um `$cond` no próprio documento, sem junção.
  etapas.push({
    $addFields: { hasAccess: { $cond: [{ $ifNull: ["$password", false] }, true, false] } },
  });

  // SÓ QUEM ENTRA NO APP.
  //
  // O filtro existe por causa de "iniciar uma conversa": só se conversa com quem
  // tem acesso, e sem isto a tela pedia uma página de pessoas ao servidor e
  // descartava metade dela no navegador — o que faz uma página de vinte virar
  // uma lista de três, e a de trás não existir. Filtrar aqui é o que mantém a
  // paginação dizendo a verdade.
  // `1` só quem entra, `0` só quem não entra. Qualquer outra coisa — inclusive
  // vazio, que é o que um filtro em branco manda — não filtra nada.
  if (String(filtros.access) === "1") etapas.push({ $match: { hasAccess: true } });
  else if (String(filtros.access) === "0") etapas.push({ $match: { hasAccess: false } });

  // ── Em dia, vencido, ou sem treino nenhum ────────────────────────────────
  //
  // Esta é a única junção do arquivo que NÃO dá para adiar para depois do corte:
  // ela decide quem entra na página. Por isso ela só é montada quando alguém
  // pede o filtro — sem ele, a consulta continua exatamente a de antes.
  //
  // O `$group` devolve duas contagens por pessoa em vez dos treinos: contar
  // dentro do `$lookup` é o que evita trazer os exercícios de todo mundo para
  // responder "tem treino vigente?".
  if (FILTROS_DE_TREINO[filtros.workout]) {
    const hoje = tempo.paredeDe(new Date(), await this.fusoDaConta()).data;

    etapas.push(
      {
        $lookup: {
          from: "workouts",
          let: { pessoa: "$_id" },
          pipeline: [
            {
              // `instance` à mão pela mesma razão da junção do vínculo: o escopo
              // do cliente não entra em sub-pipeline de `$lookup`. Aqui ele é
              // desempenho e nada mais — `trainer` e `student` são ObjectId.
              $match: {
                instance: instanceContext.required(),
                trainer: new ObjectId(trainerId),
                $expr: { $eq: ["$student", "$$pessoa"] },
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                // Vigente = tudo que não terminou antes de hoje. Treino sem data
                // de fim nunca vence — é o mesmo `statusOf` do Workout_model.
                emDia: {
                  $sum: {
                    $cond: [
                      { $and: [{ $ne: ["$endDate", ""] }, { $lt: ["$endDate", hoje] }] },
                      0,
                      1,
                    ],
                  },
                },
              },
            },
          ],
          as: "treinos",
        },
      },
      {
        $addFields: {
          treinosTotal: { $ifNull: [{ $arrayElemAt: ["$treinos.total", 0] }, 0] },
          treinosEmDia: { $ifNull: [{ $arrayElemAt: ["$treinos.emDia", 0] }, 0] },
        },
      },
      { $match: FILTROS_DE_TREINO[filtros.workout] }
    );
  }

  const campo = ORDEM_PESSOAS[filtros.sort] || "createdAt";
  const direcao = filtros.dir === "asc" ? 1 : -1;

  // Filtrar por status já aconteceu, na escolha dos ids. O que ainda obriga a
  // junção a subir é ORDENAR por ele: não dá para escolher as quinze primeiras
  // por um campo que só existe depois de juntar.
  const precisaDoVinculoAntes = campo === "active";
  if (precisaDoVinculoAntes) etapas.push(...juntarVinculo);

  // Vazio sempre no fim, nas duas direções — a mesma regra que a tela seguia
  // quando ordenava sozinha. Ordenar por Objetivo para encontrar uma fileira de
  // "—" no topo não ajuda ninguém.
  etapas.push({
    $addFields: { __vazio: { $cond: [{ $in: [`$${campo}`, [null, ""]] }, 1, 0] } },
  });

  // `_id` no fim desempata: sem um critério estável, duas pessoas com o mesmo
  // nome podem trocar de lugar entre uma página e outra e uma delas some.
  const ordem = { __vazio: 1, [campo]: direcao, _id: 1 };

  // `exportando` só chega de dentro do servidor (o registro de listas), nunca
  // da query — ver `lib/tetoDaLista.js`.
  const limite = porPagina(filtros.limit, { padrao: 15, maximo: 200, exportando: filtros.exportando });
  const pagina = Math.max(Number(filtros.page) || 1, 1);

  etapas.push({
    $facet: {
      rows: [
        { $sort: ordem },
        { $skip: (pagina - 1) * limite },
        { $limit: limite },
        // Daqui para baixo são quinze pessoas, não a lista inteira.
        ...(precisaDoVinculoAntes ? [] : juntarVinculo),
        // `treinos` e as duas contagens são andaime do filtro: úteis para
        // escolher quem entra, ruído na resposta.
        {
          $project: {
            password: 0,
            salt: 0,
            vinculo: 0,
            __vazio: 0,
            treinos: 0,
            treinosTotal: 0,
            treinosEmDia: 0,
          },
        },
      ],
      total: [{ $count: "n" }],
    },
  });

  // Collation do banco em vez de localeCompare no navegador: é ela que faz
  // "Ávila" cair perto de "Avila", e não depois de "Zanetti".
  //
  // Vai nas OPÇÕES do aggregate, não encadeada no cursor: `.collation()` como
  // método só existe no cursor de `find`.
  const [saida] = await col
    .aggregate(etapas, { collation: { locale: "pt", strength: 1 } })
    .toArray();

  return { rows: saida?.rows || [], total: saida?.total?.[0]?.n || 0 };
};

User_model.prototype.listStudents = async function (trainerId, filter) {
  const col = await this.collection();

  const ids = await this.app.api.link.personIdsOf(trainerId);
  if (ids.length === 0) return [];

  const query = { _id: { $in: ids } };

  if (filter && filter.search) {
    // Escape the term — without this a "(" typed by the user breaks the regex.
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
      { username: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
    ];
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  // Observação e status vêm do VÍNCULO: cada profissional vê os seus, nunca os
  // de outro. O `active` do vínculo sobrescreve o da conta de propósito — na
  // lista de quem acompanha, "ativo" quer dizer ativo AQUI.
  const notes = await this.app.api.link.notesMap(trainerId);
  const active = await this.app.api.link.activeMap(trainerId);

  const rows = docs.map((d) => ({
    ...this.filter(d),
    notes: notes.get(String(d._id)) || "",
    active: active.get(String(d._id)) ?? 1,
  }));

  // O filtro é aplicado depois porque o valor está no vínculo, não na consulta
  // que trouxe as pessoas.
  if (filter && filter.active !== undefined && filter.active !== "") {
    const wanted = Number(filter.active) ? 1 : 0;
    return rows.filter((r) => r.active === wanted);
  }

  return rows;
};

User_model.prototype.dataStudent = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;

  // The link IS the permission check: no link, no access, even if the id is
  // real and the caller knows it.
  if (!(await this.app.api.link.exists(trainerId, id))) return undefined;

  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

User_model.prototype.insertStudent = async function (trainerId, obj) {
  const col = await this.collection();

  const doc = {
    name: String(obj.name).trim(),
    email: normalizeEmail(obj.email),
    password: null,
    salt: null,
    type: "student",
    role: obj.role ? new ObjectId(obj.role) : null,
    // Who first registered the profile. It does NOT grant access — the link
    // does — but it is what lets that professional still manage the login of
    // someone who never signed up on their own.
    createdBy: new ObjectId(trainerId),
    phone: obj.phone ? String(obj.phone).trim() : "",
    birthDate: obj.birthDate ? String(obj.birthDate) : "",
    sex: SEXES.includes(String(obj.sex)) ? String(obj.sex) : "",
    goal: obj.goal ? String(obj.goal).trim() : "",
    // ── A UNIDADE, e ela é UMA SÓ ─────────────────────────────────────
    //
    // *"o aluno pode fazer parte ou não, de apenas 1 unidade"*. Um campo que
    // aceita um id só é impossível de encher com dois; uma lista precisaria
    // de uma regra dizendo que ninguém repete em duas, e regra se esquece.
    //
    // `null` é "nenhuma", e é o padrão: quem atende num lugar só nunca
    // precisa saber que esta tela existe.
    unit: unidade(obj.unit),
    weight: obj.weight !== undefined && obj.weight !== "" ? Number(obj.weight) : null,
    height: obj.height !== undefined && obj.height !== "" ? Number(obj.height) : null,
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // The password is optional at signup: without it the student exists as a
  // profile but cannot log in yet.
  if (obj.password) {
    doc.salt = this.generateSalt();
    doc.password = this.hashPassword(obj.password, doc.salt);
  }

  const r = await col.insertOne(doc);

  // Registering someone already puts them on your list.
  await this.app.api.link.link(trainerId, r.insertedId, "created");

  return r.insertedId;
};

// Mexeu na pessoa: a sessão guardada dela morre agora. Ver Auth_model.
User_model.prototype.updateStudent = async function (trainerId, id, obj) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  if (!(await this.app.api.link.exists(trainerId, id))) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();
  if (obj.birthDate !== undefined) set.birthDate = String(obj.birthDate);
  if (obj.sex !== undefined) set.sex = SEXES.includes(String(obj.sex)) ? String(obj.sex) : "";
  if (obj.goal !== undefined) set.goal = String(obj.goal).trim();
  // Vazio é "saiu da unidade", e precisa ser gravável: sem isto não haveria
  // como desfazer o vínculo depois de criá-lo.
  if (obj.unit !== undefined) set.unit = unidade(obj.unit);
  if (obj.weight !== undefined) set.weight = obj.weight === "" ? null : Number(obj.weight);
  if (obj.height !== undefined) set.height = obj.height === "" ? null : Number(obj.height);
  // `active` NÃO entra aqui: na visão do profissional ele quer dizer "ativo na
  // minha lista" e mora no vínculo. O da conta é do admin, em Usuários.

  if (obj.email !== undefined) {
    const e = normalizeEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.password) {
    set.salt = this.generateSalt();
    set.password = this.hashPassword(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  const r = await col.updateOne({ _id: new ObjectId(id) }, update);

  return r.matchedCount > 0;
};

// Apaga a pessoa de vez: o cadastro, os vínculos e os TREINOS.
//
// Os treinos vão junto desde 13/08/2026. Antes ficavam no banco apontando para
// um `student` apagado: nenhuma tela os alcançava e nada os apagava depois —
// lixo permanente. Quem quer só cortar o login da pessoa e manter a ficha usa
// `revokeStudentAccess`, que é outro botão na tela.
User_model.prototype.deleteStudent = async function (trainerId, id) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  if (!(await this.app.api.link.exists(trainerId, id))) return false;

  return await this.apagarTudoDoAluno(id);
};

// A CASCATA, sozinha — sem a conferência de vínculo.
//
// Extraída de `deleteStudent` em 02/09/2026 porque ganhou um segundo chamador: a
// própria pessoa apagando a conta dela (`excluirMinhaConta`). Duplicar esta
// lista era garantir que uma das duas cópias esquecesse uma collection na
// próxima tela que nascesse — e o que fica para trás num apagar de conta é
// justamente dado de saúde de alguém que pediu para sair.
//
// Quem chama decide QUEM pode: aqui não há autorização nenhuma, de propósito.
User_model.prototype.apagarTudoDoAluno = async function (id) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });

  await this.app.api.link.deleteAllOf(id);
  await this.app.api.workout.deleteAllOfStudent(id);
  await this.app.api.diet.deleteAllOfStudent(id);
  await this.app.api.anamnesis.deleteAllOfStudent(id);
  await this.app.api.anamnesisLink.deleteAllOfStudent(id);
  await this.app.api.supplement.deleteAllOfStudent(id);
  await this.app.api.exam.deleteAllOfStudent(id);
  await this.app.api.prescription.deleteAllOfStudent(id);
  // As fotos são referenciadas pela COLETA, não pela pessoa — então os ids
  // precisam ser lidos antes de as coletas sumirem.
  // As conversas somem com a pessoa: uma linha na lista apontando para uma
  // conta apagada não abre nada e não explica por quê.
  await this.app.api.chat.deleteAllOfUser(id);
  await this.app.api.appointment.deleteAllOfStudent(id);
  await this.app.api.finance.deleteAllOfStudent(id);

  const coletas = await this.app.api.assessment.idsOfStudent(id);
  await this.app.api.assessmentPhoto.deleteAllOfAssessments(coletas);
  await this.app.api.assessment.deleteAllOfStudent(id);

  return r.deletedCount > 0;
};

// Revokes the person's login without deleting the profile.
//
// Restricted to whoever created the profile: a professional who merely got
// access by request must not be able to lock the person out of an account the
// person owns.
User_model.prototype.revokeStudentAccess = async function (trainerId, id) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id), createdBy: new ObjectId(trainerId) },
    { $set: { password: null, salt: null, updatedAt: new Date() } }
  );
  return r.matchedCount > 0;
};

// ── Common to both types ─────────────────────────────────────────────────

// As preferências de TELA: quais colunas a pessoa quer ver, por qual ordenou,
// quantas linhas por página.
//
// Guardadas como um saco de chaves, sem esquema: é gosto de quem olha, não
// regra de negócio, e cada tela nova traria uma migração se isso fosse tipado.
// O que existe é um TETO de tamanho — sem ele, um cliente com defeito encheria
// o documento do usuário até o limite de 16 MB do Mongo.
const PREFERENCIAS_MAX = 4000;

User_model.prototype.savePreferences = async function (id, prefs) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return false;

  const chaves = Object.entries(prefs);
  if (!chaves.length) return false;
  if (JSON.stringify(prefs).length > PREFERENCIAS_MAX) return false;

  // Gravadas chave a chave, e não como um objeto inteiro: cada tela salva a
  // sua sem apagar as das outras. Mandar `preferences` de uma vez faria a lista
  // de pessoas derrubar o que a tela de treinos tivesse guardado.
  const set = { updatedAt: new Date() };
  for (const [k, v] of chaves) set[`preferences.${String(k)}`] = v;

  const col = await this.collection();
  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
  return r.matchedCount > 0;
};

// Updates the user's own account data (name/email) or password.
// Mexeu na conta (senha, idioma, vocabulário): a sessão guardada morre.
User_model.prototype.updateSelf = async function (id, obj) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();

  // A APRESENTAÇÃO do profissional, para a página pública de agendamento.
  //
  // Fica na conta e não na página porque é sobre a PESSOA: quem escreve "Personal
  // trainer, 12 anos de CrossFit" não quer reescrever isso em cada página que
  // criar. Qual página mostra — ou se alguma mostra — é decisão da página.
  if (obj.bio !== undefined) set.bio = String(obj.bio).trim().slice(0, 600);

  // O idioma escolhido na tela, guardado na conta.
  //
  // Não é para responder às requisições dela — para isso vem o Accept-Language,
  // que é sempre o idioma da aba que está aberta agora. É para os E-MAILS: quem
  // dispara um e-mail é outra pessoa, e o que vale é a língua de quem vai ler.
  // Quem nunca escolheu não tem o campo, e aí o e-mail sai em pt-BR.
  if (obj.lang !== undefined) {
    const { normalizeLanguage } = require("../lib/i18n");
    set.lang = normalizeLanguage(obj.lang);
  }

  // What this professional calls the people they follow: aluno, paciente,
  // cliente. Stored lowercase — the screens capitalise where they need to, so
  // "Aluno" typed here does not become "ALunos" in the middle of a sentence.
  if (obj.peopleSingular !== undefined) {
    set.peopleSingular = String(obj.peopleSingular).trim().toLowerCase();
  }
  if (obj.peoplePlural !== undefined) {
    set.peoplePlural = String(obj.peoplePlural).trim().toLowerCase();
  }

  if (obj.email !== undefined) {
    const e = normalizeEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  // Nome de usuário: vazio APAGA o campo em vez de gravar string vazia.
  //
  // Gravar "" faria o índice único enxergar duas contas com o mesmo valor, e a
  // segunda pessoa a limpar o campo levaria erro de duplicado sem entender por
  // quê. Recusa inválido em vez de gravar torto — quem chama trata o motivo.
  if (obj.username !== undefined) {
    const conferido = checkUsername(obj.username);
    if (!conferido.ok) return { erro: "username", motivo: conferido.reason };
    if (conferido.value) set.username = conferido.value;
    else unset.username = "";
  }

  if (obj.password) {
    set.salt = this.generateSalt();
    set.password = this.hashPassword(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  await col.updateOne({ _id: new ObjectId(id) }, update);
  return true;
};

// Checks e-mail + password. Returns the raw document (with the hash) or
// undefined.
// `identificador` é e-mail OU nome de usuário — o campo de login é um só, e
// obrigar a escolher entre dois campos seria empurrar para a pessoa uma decisão
// que o servidor toma sozinho.
User_model.prototype.authenticate = async function (identificador, password) {
  const user = await this.dataByLogin(identificador);
  if (!this.podeEntrar(user)) return undefined;

  if (this.hashPassword(password, user.salt) !== user.password) return undefined;

  return user;
};

// QUEM pode entrar — independentemente de COMO provou quem é.
//
// Isto era um par de `if` dentro de `authenticate`, e saiu de lá quando o login
// pelo Google apareceu: agora há duas provas de identidade, e as duas têm de
// recusar as MESMAS contas. Deixado como estava, o caminho do Google nasceria sem
// essas recusas — e entrar pelo Google seria justamente o jeito de furar o
// "acesso ainda não liberado".
User_model.prototype.podeEntrar = function (user) {
  if (!user) return false;
  // Conta desativada pelo negócio.
  if (user.active === 0) return false;
  // Perfil de aluno/paciente criado pelo profissional e SEM acesso concedido: a
  // ficha existe, o login ainda não. Sem senha definida não há o que conferir —
  // e um caminho de login que dispensa senha entraria por essa porta.
  if (!user.password || !user.salt) return false;
  return true;
};

// Entrar por um e-mail que um provedor de fora JÁ VERIFICOU (hoje o Google).
//
// ── Não cria conta, e isto é a decisão principal ──────────────────────────
//
// Achar-ou-criar aqui deixaria qualquer pessoa com conta no Google criar uma
// conta dentro do sistema de um profissional só clicando no botão — no
// subdomínio dele, com dados dele por perto. Quem entra por aqui é quem JÁ é da
// casa; e-mail sem conta é recusa, e criar alguém continua sendo ato do
// profissional.
//
// Por consequência, o Google só entra em conta que já tem acesso por senha
// (`podeEntrar` exige senha definida). Conta que só existe no Google não é
// possível hoje — e não vai ser por acidente.
User_model.prototype.porEmailVerificado = async function (email) {
  const user = await this.dataByEmail(email);
  if (!this.podeEntrar(user)) return undefined;
  return user;
};

// Numbers for the trainer's dashboard.
User_model.prototype.studentsSummary = async function (trainerId) {
  const col = await this.collection();

  const ids = await this.app.api.link.personIdsOf(trainerId);
  if (ids.length === 0) {
    return { total: 0, active: 0, inactive: 0, withAccess: 0, newThisMonth: 0 };
  }

  const base = { _id: { $in: ids } };

  const total = ids.length;
  // Ativo aqui é ativo NA LISTA deste profissional, igual ao que a tela mostra
  // — contar pelo `active` da conta daria um número que não bate com a lista.
  const activeMap = await this.app.api.link.activeMap(trainerId);
  const active = ids.filter((id) => (activeMap.get(String(id)) ?? 1) === 1).length;
  const withAccess = await col.countDocuments({ ...base, password: { $ne: null } });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const newThisMonth = await col.countDocuments({ ...base, createdAt: { $gte: monthStart } });

  return { total, active, inactive: total - active, withAccess, newThisMonth };
};

// ── Every user, no scoping — admin only ──────────────────────────────────

// Powers the Users screen. Unlike listStudents/listTrainers this one is not
// filtered by ownership at all, which is exactly why every route that reaches
// it asks for the users.view permission first.
User_model.prototype.listAll = async function (filter) {
  const col = await this.collection();
  const query = {};

  if (filter && filter.search) {
    const term = String(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: term, $options: "i" } },
      { email: { $regex: term, $options: "i" } },
      { username: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
    ];
  }

  if (filter && filter.type) query.type = String(filter.type);
  if (filter && filter.active !== undefined && filter.active !== "") {
    query.active = Number(filter.active) ? 1 : 0;
  }
  if (filter && filter.role && ObjectId.isValid(filter.role)) query.role = new ObjectId(filter.role);

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  const byProfessional = await this.app.api.link.countsByProfessional();
  const roleNames = await this.roleNameMap();

  return docs.map((d) => ({
    ...this.filter(d),
    roleName: roleNames.get(String(d.role)) || "",
    totalStudents: byProfessional.get(String(d._id)) || 0,
  }));
};

// Admin edit of ANY user. Separate from updateTrainer/updateStudent because
// those two pin `type` in the query — here type itself can change.
// O painel mexeu na conta — papel, permissões, ativo/inativo. É o caso que
// MAIS importa: desativar alguém não pode demorar um minuto para valer.
User_model.prototype.updateAny = async function (id, obj) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();

  // A APRESENTAÇÃO do profissional, para a página pública de agendamento.
  //
  // Fica na conta e não na página porque é sobre a PESSOA: quem escreve "Personal
  // trainer, 12 anos de CrossFit" não quer reescrever isso em cada página que
  // criar. Qual página mostra — ou se alguma mostra — é decisão da página.
  if (obj.bio !== undefined) set.bio = String(obj.bio).trim().slice(0, 600);

  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;
  if (obj.role !== undefined && ObjectId.isValid(obj.role)) set.role = new ObjectId(obj.role);
  if (obj.admin !== undefined) set.admin = obj.admin === true || obj.admin === 1;
  // Lista vazia é gravável: é assim que se tira a restrição e se devolve o
  // acesso a todas.
  if (obj.units !== undefined) set.units = unidades(obj.units);
  if (obj.type !== undefined && TYPES.includes(String(obj.type))) set.type = String(obj.type);

  if (obj.email !== undefined) {
    const e = normalizeEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.username !== undefined) {
    const conferido = checkUsername(obj.username);
    if (!conferido.ok) return { erro: "username", motivo: conferido.reason };
    if (conferido.value) set.username = conferido.value;
    else unset.username = "";
  }

  if (obj.password) {
    set.salt = this.generateSalt();
    set.password = this.hashPassword(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  const r = await col.updateOne({ _id: new ObjectId(id) }, update);
  return r.matchedCount > 0;
};

// A conta morreu. A sessão guardada não pode sobreviver a ela.
User_model.prototype.deleteAny = async function (id) {
  await sessaoGuardada.esquecerUsuario(id);
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id) });
  // Links in BOTH directions go with them, otherwise a list would try to load
  // an id that no longer exists.
  await this.app.api.link.deleteAllOf(id);

  // ── E A FOTO, no banco E no balde ──────────────────────────────────────
  //
  // *"quando exclui algo, você exclui de lá?"* — aqui não excluía nem do banco.
  //
  // A conta saía e o `avatars` ficava com um documento apontando para um id que
  // não existe mais, com os bytes no R2 atrás dele. Ninguém via: a foto só é
  // pedida por `/avatars/:userId`, e ninguém mais pede por aquele id.
  //
  // `avatar.delete` é quem sabe apagar dos dois lugares. Num `catch` porque uma
  // falha na faxina não pode impedir a conta de ser excluída — o pedido de
  // exclusão de dados tem prazo, e a foto órfã é o menor dos males.
  await this.app.api.avatar.delete(id).catch((erro) => {
    console.error("[usuarios] foto não apagada:", erro.message);
  });

  return r.deletedCount > 0;
};

// Platform-wide numbers — admin only.
User_model.prototype.platformSummary = async function () {
  const col = await this.collection();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  return {
    trainers: await col.countDocuments({ type: "trainer" }),
    activeTrainers: await col.countDocuments({ type: "trainer", active: 1 }),
    students: await col.countDocuments({ type: "student" }),
    admins: await this.countAdmins(),
    newThisMonth: await col.countDocuments({ createdAt: { $gte: monthStart } }),
  };
};

// ── PEDIR A EXCLUSÃO DA PRÓPRIA CONTA ─────────────────────────────────────
//
// Exigência da diretriz 5.1.1(v) da App Store: app que deixa criar conta TEM de
// deixar pedir a exclusão de dentro do app. "Fale com o suporte" é recusa. O
// Google Play pede o mesmo e ainda exige um endereço na web que funcione sem
// instalar o app.
//
// ── NADA APAGA AQUI, E ISSO MUDOU EM 02/09/2026 ───────────────────────────
//
// A primeira versão apagava: aluno e profissional na hora, dono com 30 dias de
// prazo e um script cumprindo a data. O Marlon cortou: "não exclua automático,
// mande uma solicitação de exclusão lá para a central, para eu ver quem
// solicitou, para eu entrar em contato perguntar o motivo".
//
// E ele está certo por uma razão que o prazo não resolvia: quase todo pedido de
// exclusão é outro problema com outro nome — cobrança indevida, recurso que a
// pessoa não achou, ou dado que ela quer tirar de um profissional e não do
// sistema. Apagar no prazo atende o pedido e perde a conversa. E o dado não
// volta.
//
// A loja não exige exclusão INSTANTÂNEA; exige que comece no app. E abre
// exceção explícita para setor regulado, onde o pedido pode ser processado por
// atendimento — dado de saúde é exatamente esse caso. O que sustenta isso é o
// texto da tela dizer a verdade: pedido registrado, alguém vai entrar em
// contato. Uma tela que dissesse "excluída" sem excluir seria o problema.
//
// O papel continua sendo calculado, e não por vaidade: é o que diz ao painel o
// TAMANHO do que está sendo pedido antes de alguém ligar.

// Qual dos três papéis é esta pessoa.
//
// O dono não é "quem tem admin: true" — vários podem ter. É quem, saindo,
// deixaria a casa SEM NINGUÉM que possa administrá-la, e apagar a conta dele
// alcança o dado de todos os alunos dele. É a mesma pergunta que `countAdmins`
// já respondia para impedir o painel de remover o último administrador.
User_model.prototype.papelNaExclusao = async function (user) {
  if (!user) return undefined;
  if (user.type === "student") return "aluno";

  const outros = await this.countAdmins(String(user._id));
  return outros > 0 ? "profissional" : "dono";
};

// O QUE VAI SUMIR, em números — para a tela avisar antes de perguntar, e para o
// painel saber o peso do pedido sem abrir o banco do cliente.
//
// Falha em silêncio para vazio: um número que não veio não pode travar a tela
// que existe para a pessoa poder sair.
User_model.prototype.oQueVaiSumirNaExclusao = async function (user) {
  const papel = await this.papelNaExclusao(user);
  const col = await this.collection();

  if (papel === "dono") {
    try {
      return {
        alunos: await col.countDocuments({ type: "student" }),
        profissionais: await col.countDocuments({ type: "trainer" }),
      };
    } catch (erro) {
      return {};
    }
  }

  return {};
};

// Registra o pedido na fila do painel. NÃO apaga nada.
User_model.prototype.pedirExclusaoDaConta = async function (user, motivo) {
  const papel = await this.papelNaExclusao(user);

  const pedido = await this.app.api.center.pedirExclusao(instanceContext.required(), {
    usuarioId: String(user._id),
    nome: user.name,
    email: user.email,
    papel,
    motivo,
    oQueVaiSumir: await this.oQueVaiSumirNaExclusao(user),
  });

  if (!pedido) return { papel, feito: false };

  return { papel, feito: true, pedidaEm: pedido.pedidaEm, jaExistia: Boolean(pedido.jaExistia) };
};

User_model.prototype.exclusaoPedida = async function (user) {
  return await this.app.api.center.exclusaoPedida(instanceContext.required(), String(user._id));
};

User_model.prototype.cancelarExclusaoDaConta = async function (user) {
  return await this.app.api.center.cancelarExclusaoPedida(
    instanceContext.required(),
    String(user._id)
  );
};

// A senha desta pessoa, conferida — sem passar pelo login.
//
// `authenticate` não serve aqui: ele recebe e-mail ou nome de usuário e faz a
// busca, e quem já está autenticado tem o id em mãos. Pior, ele passa por
// `podeEntrar` e devolve o documento inteiro, com o hash — coisas que uma
// reconferência de senha não precisa carregar.
//
// Por que reconferir: a sessão do app fica aberta por semanas. Sem a senha,
// bastaria pegar o telefone destravado de alguém para apagar a conta dele e
// todos os alunos dele.
User_model.prototype.conferirSenha = async function (id, senha) {
  if (!ObjectId.isValid(id) || !senha) return false;

  const col = await this.collection();
  const doc = await col.findOne(
    { _id: new ObjectId(id) },
    { projection: { password: 1, salt: 1 } }
  );

  if (!doc || !doc.password || !doc.salt) return false;
  return this.hashPassword(String(senha), doc.salt) === doc.password;
};

module.exports = User_model;
module.exports.checkUsername = checkUsername;
module.exports.normalizeUsername = normalizeUsername;
module.exports.looksLikeEmail = looksLikeEmail;
module.exports.USERNAME_RESERVADOS = USERNAME_RESERVADOS;
module.exports.TYPES = TYPES;

// ── ACHAR UMA PESSOA PELO TELEFONE ────────────────────────────────────────
//
// Para a inscrição pelo WhatsApp na página pública do aulão: quem chega digita o
// número, e isto responde se ela já é aluna do estúdio.
//
// ── Comparação em MEMÓRIA, e o motivo ─────────────────────────────────────
//
// O telefone é gravado como foi digitado, então o banco tem "(11) 98765-0001" e
// "11987650001" para a mesma pessoa. Um `findOne({ phone })` acharia quase
// nunca — e não achar aqui não dá erro: cria um aluno DUPLICADO do próprio
// cliente, com o histórico partido em dois.
//
// Então lê `{_id, name, phone}` de todo mundo da instância e compara pela regra
// de `lib/telefone.js`. Custa uma leitura pequena: a maior instância tem 217
// pessoas. Quando alguma passar de alguns milhares, isto vira varredura por
// requisição numa rota pública, e aí o certo é um campo normalizado com índice
// (como o `nameSort` que já existe) — está escrito no cabeçalho de `telefone.js`.
//
// ── A PRIMEIRA CRIADA GANHA ───────────────────────────────────────────────
//
// Se já houver duas fichas com o mesmo número — e há, de antes desta regra
// existir —, vale a mais antiga. É a que tem histórico, e é a escolha que
// `dataOfInstance` e o importador do Wiki4Fit já fazem nos empates deles.
User_model.prototype.dataByPhone = async function (telefone) {
  const alvo = telefones.chave(telefone);
  if (!alvo) return undefined;

  const col = await this.collection();

  const candidatos = await col
    .find({}, { projection: { name: 1, phone: 1, email: 1, type: 1, createdAt: 1 } })
    .sort({ createdAt: 1 })
    .toArray();

  return candidatos.find((c) => telefones.chave(c.phone) === alvo) || undefined;
};
