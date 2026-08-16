const { ObjectId } = require("mongodb");
const permissionCatalog = require("../lib/permissions.js");

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

  // The master switch is read from the catalog, not from a stored list, so it
  // covers permissions that did not exist when the account was created.
  // Without it, no role means NO permissions — never "everything": a user
  // whose role was deleted must lose access, not inherit it.
  user.permissions = user.admin ? [...permissionCatalog.ALL] : role ? role.permissions || [] : [];

  return user;
};

// What a user may do, master switch included. Used by the guards that need to
// know whether somebody holds a permission WITHOUT loading a full session.
User_model.prototype.hasPermission = async function (doc, permission) {
  if (!doc) return false;
  if (doc.admin === true) return true;
  return await this.app.api.role.grants(doc.role, permission);
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

User_model.prototype.pageStudents = async function (trainerId, filtros = {}) {
  const col = await this.collection();

  // O filtro de ativo/inativo vai no VÍNCULO, que é onde o status mora — e é
  // por isso que ele some do pipeline lá embaixo.
  const ids = await this.app.api.link.personIdsOf(trainerId, { active: filtros.active });
  if (!ids.length) return { rows: [], total: 0 };

  const etapas = [{ $match: { _id: { $in: ids } } }];

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
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$person", "$$pessoa"] },
                  { $eq: ["$professional", new ObjectId(trainerId)] },
                ],
              },
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

  const limite = Math.min(Math.max(Number(filtros.limit) || 15, 1), 200);
  const pagina = Math.max(Number(filtros.page) || 1, 1);

  etapas.push({
    $facet: {
      rows: [
        { $sort: ordem },
        { $skip: (pagina - 1) * limite },
        { $limit: limite },
        // Daqui para baixo são quinze pessoas, não a lista inteira.
        ...(precisaDoVinculoAntes ? [] : juntarVinculo),
        { $project: { password: 0, salt: 0, vinculo: 0, __vazio: 0 } },
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

User_model.prototype.updateStudent = async function (trainerId, id, obj) {
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
  if (!ObjectId.isValid(id)) return false;
  if (!(await this.app.api.link.exists(trainerId, id))) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });

  await this.app.api.link.deleteAllOf(id);
  await this.app.api.workout.deleteAllOfStudent(id);
  await this.app.api.diet.deleteAllOfStudent(id);
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
User_model.prototype.updateSelf = async function (id, obj) {
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
  if (!user) return undefined;
  if (user.active === 0) return undefined;

  // Student registered as a profile, with no access granted yet.
  if (!user.password || !user.salt) return undefined;

  if (this.hashPassword(password, user.salt) !== user.password) return undefined;

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
User_model.prototype.updateAny = async function (id, obj) {
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

User_model.prototype.deleteAny = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id) });
  // Links in BOTH directions go with them, otherwise a list would try to load
  // an id that no longer exists.
  await this.app.api.link.deleteAllOf(id);

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

module.exports = User_model;
module.exports.checkUsername = checkUsername;
module.exports.normalizeUsername = normalizeUsername;
module.exports.looksLikeEmail = looksLikeEmail;
module.exports.USERNAME_RESERVADOS = USERNAME_RESERVADOS;
module.exports.TYPES = TYPES;
