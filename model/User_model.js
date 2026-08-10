const { ObjectId } = require("mongodb");

// Coleção `users` — toda pessoa do sistema. Os campos do banco são em INGLÊS;
// o português fica só na interface.
//
//   type: "trainer"  → cadastra e enxerga os próprios alunos
//   type: "student"  → tem `trainer` apontando pro dono; enxerga só a si
//
// `admin` é uma flag SEPARADA do type: marca quem administra a plataforma
// (cadastra os trainers). Um admin normalmente é também um trainer, então os
// dois convivem no mesmo documento em vez de virarem um terceiro type.
//
// Campos de ficha (weight, height, goal…) só fazem sentido no student, mas
// ficam no mesmo documento — não vale uma coleção separada pra isso.
//
// `password`/`salt` ficam null enquanto o student não tem acesso liberado: o
// trainer pode cadastrar a ficha antes de dar login pra ele.
function User_model(app) {
  this.app = app;
}

const TYPES = ["trainer", "student"];

User_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("users");
};

// Hash sha512 com salt por usuário. O salt é sorteado no cadastro e guardado
// junto do documento — sem ele, duas senhas iguais gerariam o mesmo hash.
User_model.prototype.gerarSalt = function () {
  return this.app.crypto.randomBytes(16).toString("hex");
};

User_model.prototype.hashSenha = function (senha, salt) {
  return this.app.crypto
    .createHash("sha512")
    .update(salt + ":" + senha)
    .digest("base64");
};

// Nunca devolver password/salt pra fora do backend. `hasAccess` entrega o que
// a tela precisa saber (se o student já consegue logar) sem expor o hash.
User_model.prototype.filter = function (doc) {
  if (!doc) return doc;
  const { password, salt, ...rest } = doc;
  rest.hasAccess = !!password;
  return rest;
};

// E-mail vazio é gravado como campo AUSENTE, não como "". O índice único é
// parcial (só onde `email` existe), então dois students sem e-mail conviveriam,
// mas dois com "" colidiriam.
function normalizaEmail(email) {
  const v = String(email == null ? "" : email)
    .trim()
    .toLowerCase();
  return v === "" ? null : v;
}

User_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

User_model.prototype.dataByEmail = async function (email) {
  const e = normalizaEmail(email);
  if (!e) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ email: e });
  return doc || undefined;
};

// ── Trainer (o "cliente" na visão do admin) ──────────────────────────────

User_model.prototype.insertTrainer = async function (obj) {
  const col = await this.collection();
  const salt = this.gerarSalt();

  const r = await col.insertOne({
    name: String(obj.name).trim(),
    email: normalizaEmail(obj.email),
    password: this.hashSenha(obj.password, salt),
    salt: salt,
    type: "trainer",
    // `admin` nunca vem de auto-cadastro: só o admin marca outro admin.
    admin: obj.admin === true,
    phone: obj.phone ? String(obj.phone).trim() : "",
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// Lista os trainers — visão de admin. Traz junto quantos students cada um
// tem, que é a informação que a tela mostra.
User_model.prototype.listTrainers = async function (filtro) {
  const col = await this.collection();

  const query = { type: "trainer" };

  if (filtro && filtro.busca) {
    const termo = String(filtro.busca).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: termo, $options: "i" } },
      { email: { $regex: termo, $options: "i" } },
      { phone: { $regex: termo, $options: "i" } },
    ];
  }

  if (filtro && filtro.active !== undefined && filtro.active !== "") {
    query.active = Number(filtro.active) ? 1 : 0;
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();

  // Uma agregação só pra todos os trainers — em vez de um countDocuments por
  // linha, que faria N consultas numa lista de N.
  const contagem = await col
    .aggregate([{ $match: { type: "student" } }, { $group: { _id: "$trainer", total: { $sum: 1 } } }])
    .toArray();

  const porTrainer = new Map(contagem.map((c) => [String(c._id), c.total]));

  return docs.map((d) => ({
    ...this.filter(d),
    totalStudents: porTrainer.get(String(d._id)) || 0,
  }));
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
  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;
  if (obj.admin !== undefined) set.admin = obj.admin === true || obj.admin === 1;

  if (obj.email !== undefined) {
    const e = normalizaEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.password) {
    set.salt = this.gerarSalt();
    set.password = this.hashSenha(obj.password, set.salt);
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
  const col = await this.collection();
  return await col.countDocuments({ type: "student", trainer: new ObjectId(trainerId) });
};

// Quantos admins ATIVOS existem. Serve pra impedir que o último admin se
// rebaixe ou se apague e deixe a plataforma sem ninguém no menu Clientes.
User_model.prototype.countAdmins = async function () {
  const col = await this.collection();
  return await col.countDocuments({ admin: true, active: 1 });
};

// ── Students (sempre no escopo de um trainer) ────────────────────────────

User_model.prototype.listStudents = async function (trainerId, filtro) {
  const col = await this.collection();

  const query = { type: "student", trainer: new ObjectId(trainerId) };

  if (filtro && filtro.busca) {
    // Escapa a busca: sem isso um "(" digitado pelo usuário derruba o regex.
    const termo = String(filtro.busca).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: termo, $options: "i" } },
      { email: { $regex: termo, $options: "i" } },
      { phone: { $regex: termo, $options: "i" } },
    ];
  }

  if (filtro && filtro.active !== undefined && filtro.active !== "") {
    query.active = Number(filtro.active) ? 1 : 0;
  }

  const docs = await col.find(query).sort({ createdAt: -1 }).toArray();
  return docs.map((d) => this.filter(d));
};

User_model.prototype.dataStudent = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({
    _id: new ObjectId(id),
    type: "student",
    trainer: new ObjectId(trainerId),
  });
  return doc || undefined;
};

User_model.prototype.insertStudent = async function (trainerId, obj) {
  const col = await this.collection();

  const doc = {
    name: String(obj.name).trim(),
    email: normalizaEmail(obj.email),
    password: null,
    salt: null,
    type: "student",
    trainer: new ObjectId(trainerId),
    phone: obj.phone ? String(obj.phone).trim() : "",
    birthDate: obj.birthDate ? String(obj.birthDate) : "",
    goal: obj.goal ? String(obj.goal).trim() : "",
    weight: obj.weight !== undefined && obj.weight !== "" ? Number(obj.weight) : null,
    height: obj.height !== undefined && obj.height !== "" ? Number(obj.height) : null,
    notes: obj.notes ? String(obj.notes).trim() : "",
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Senha é opcional no cadastro: sem ela o student existe como ficha, mas
  // ainda não loga.
  if (obj.password) {
    doc.salt = this.gerarSalt();
    doc.password = this.hashSenha(obj.password, doc.salt);
  }

  const r = await col.insertOne(doc);
  return r.insertedId;
};

User_model.prototype.updateStudent = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.phone !== undefined) set.phone = String(obj.phone).trim();
  if (obj.birthDate !== undefined) set.birthDate = String(obj.birthDate);
  if (obj.goal !== undefined) set.goal = String(obj.goal).trim();
  if (obj.notes !== undefined) set.notes = String(obj.notes).trim();
  if (obj.weight !== undefined) set.weight = obj.weight === "" ? null : Number(obj.weight);
  if (obj.height !== undefined) set.height = obj.height === "" ? null : Number(obj.height);
  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;

  if (obj.email !== undefined) {
    const e = normalizaEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.password) {
    set.salt = this.gerarSalt();
    set.password = this.hashSenha(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  const r = await col.updateOne(
    { _id: new ObjectId(id), type: "student", trainer: new ObjectId(trainerId) },
    update
  );

  return r.matchedCount > 0;
};

User_model.prototype.deleteStudent = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({
    _id: new ObjectId(id),
    type: "student",
    trainer: new ObjectId(trainerId),
  });
  return r.deletedCount > 0;
};

// Tira o acesso do student sem apagar a ficha.
User_model.prototype.revokeStudentAccess = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id), type: "student", trainer: new ObjectId(trainerId) },
    { $set: { password: null, salt: null, updatedAt: new Date() } }
  );
  return r.matchedCount > 0;
};

// ── Comum aos dois types ─────────────────────────────────────────────────

// Atualiza os dados da própria conta (name/email) ou a senha.
User_model.prototype.updateSelf = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  const unset = {};

  if (obj.name !== undefined) set.name = String(obj.name).trim();

  if (obj.email !== undefined) {
    const e = normalizaEmail(obj.email);
    if (e) set.email = e;
    else unset.email = "";
  }

  if (obj.password) {
    set.salt = this.gerarSalt();
    set.password = this.hashSenha(obj.password, set.salt);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  await col.updateOne({ _id: new ObjectId(id) }, update);
  return true;
};

// Confere e-mail + senha. Devolve o documento cru (com hash) ou undefined.
User_model.prototype.autenticar = async function (email, senha) {
  const user = await this.dataByEmail(email);
  if (!user) return undefined;
  if (user.active === 0) return undefined;

  // Student cadastrado como ficha, sem acesso liberado ainda.
  if (!user.password || !user.salt) return undefined;

  if (this.hashSenha(senha, user.salt) !== user.password) return undefined;

  return user;
};

// Números do dashboard do trainer.
User_model.prototype.studentsSummary = async function (trainerId) {
  const col = await this.collection();
  const base = { type: "student", trainer: new ObjectId(trainerId) };

  const total = await col.countDocuments(base);
  const active = await col.countDocuments({ ...base, active: 1 });
  const withAccess = await col.countDocuments({ ...base, password: { $ne: null } });

  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  const newThisMonth = await col.countDocuments({ ...base, createdAt: { $gte: inicioMes } });

  return { total, active, inactive: total - active, withAccess, newThisMonth };
};

// Números da plataforma inteira — só o admin enxerga.
User_model.prototype.platformSummary = async function () {
  const col = await this.collection();

  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);

  return {
    trainers: await col.countDocuments({ type: "trainer" }),
    activeTrainers: await col.countDocuments({ type: "trainer", active: 1 }),
    students: await col.countDocuments({ type: "student" }),
    admins: await col.countDocuments({ admin: true, active: 1 }),
    newThisMonth: await col.countDocuments({ createdAt: { $gte: inicioMes } }),
  };
};

module.exports = User_model;
module.exports.TYPES = TYPES;
