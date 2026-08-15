const { ObjectId } = require("mongodb");

// The `professional_links` collection — who follows whom.
//
// This is the piece that makes a PERSON shared instead of owned. Before it, a
// student had a single `trainer` field, so the same human seen by an
// endocrinologist, a nutritionist and a personal trainer had to exist three
// times, once under each professional. Now the person is one document and each
// professional holds a link to it.
//
// `source` records how the link came to be:
//   "created"   the professional registered this person themselves
//   "request"   the person approved an access request by e-mail
//
// `notes` lives here, on the LINK, and not on the person — it is the
// professional's private note about them. On the person's document it would be
// read by every other professional who follows them, and by the person
// themselves, which is the opposite of what a private note is for.
//
// `active` is here for the same reason, and to undo a collision: on the person
// it meant two different things at once — "this account may log in", which is
// the admin's call, and "this one is active on my list", which is each
// professional's. Someone can have stopped training with the personal trainer
// and still be in treatment with the nutritionist; and marking them inactive
// here never blocks their login, which is decided by `users.active`.
//
// The pair (professional, person) is unique — see database/schema.js — so the
// upsert below can run twice without producing a duplicate.
function Link_model(app) {
  this.app = app;
}

Link_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("professional_links");
};

Link_model.prototype.link = async function (professionalId, personId, source) {
  const col = await this.collection();

  await col.updateOne(
    { professional: new ObjectId(professionalId), person: new ObjectId(personId) },
    {
      $setOnInsert: {
        professional: new ObjectId(professionalId),
        person: new ObjectId(personId),
        source: source || "created",
        active: 1,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  return true;
};

Link_model.prototype.unlink = async function (professionalId, personId) {
  if (!ObjectId.isValid(personId)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
  });

  return r.deletedCount > 0;
};

// The professional's private note about this person. Never leaves the pair it
// belongs to.
Link_model.prototype.setNotes = async function (professionalId, personId, notes) {
  if (!ObjectId.isValid(personId)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { professional: new ObjectId(professionalId), person: new ObjectId(personId) },
    { $set: { notes: String(notes == null ? "" : notes).trim(), notesAt: new Date() } }
  );

  return r.matchedCount > 0;
};

Link_model.prototype.notesOf = async function (professionalId, personId) {
  if (!ObjectId.isValid(personId)) return "";
  const col = await this.collection();

  const doc = await col.findOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
  });

  return doc && doc.notes ? doc.notes : "";
};

// personId → note, for one professional. The list shows a marker on whoever
// has a note, and one query per row would be a query per line.
Link_model.prototype.notesMap = async function (professionalId) {
  const col = await this.collection();

  const docs = await col
    .find({ professional: new ObjectId(professionalId), notes: { $nin: [null, ""] } })
    .project({ person: 1, notes: 1 })
    .toArray();

  return new Map(docs.map((d) => [String(d.person), d.notes]));
};

// Ativo NA LISTA deste profissional. Não mexe no login da pessoa.
Link_model.prototype.setActive = async function (professionalId, personId, active) {
  if (!ObjectId.isValid(personId)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { professional: new ObjectId(professionalId), person: new ObjectId(personId) },
    { $set: { active: Number(active) ? 1 : 0 } }
  );

  return r.matchedCount > 0;
};

// personId → 1/0 para um profissional, em uma consulta só. Um vínculo antigo
// sem o campo conta como ativo: quem nunca desativou ninguém não deve ver a
// lista inteira apagada.
Link_model.prototype.activeMap = async function (professionalId) {
  const col = await this.collection();

  const docs = await col
    .find({ professional: new ObjectId(professionalId) })
    .project({ person: 1, active: 1 })
    .toArray();

  return new Map(docs.map((d) => [String(d.person), d.active === 0 ? 0 : 1]));
};

Link_model.prototype.activeOf = async function (professionalId, personId) {
  if (!ObjectId.isValid(personId)) return 1;
  const col = await this.collection();

  const doc = await col.findOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
  });

  return doc && doc.active === 0 ? 0 : 1;
};

Link_model.prototype.exists = async function (professionalId, personId) {
  if (!ObjectId.isValid(personId)) return false;
  const col = await this.collection();

  const doc = await col.findOne({
    professional: new ObjectId(professionalId),
    person: new ObjectId(personId),
  });

  return !!doc;
};

// The ids of everyone this professional follows.
// `filtros.active` filtra aqui em vez de na listagem de pessoas, e a diferença
// é de custo: lá o status só existe depois de juntar o vínculo de todo mundo —
// 30ms com 215 pessoas. Aqui os vínculos já estão na mão, e filtrar sai de
// graça; a lista de pessoas recebe menos ids e nem precisa da junção antes do
// corte.
Link_model.prototype.personIdsOf = async function (professionalId, filtros = {}) {
  const col = await this.collection();
  const docs = await col.find({ professional: new ObjectId(professionalId) }).toArray();

  if (filtros.active === undefined || filtros.active === "") return docs.map((d) => d.person);

  // Ativo é tudo que não é exatamente 0 — a mesma regra do `activeOf`, e a que
  // faz vínculo antigo, criado antes do campo existir, continuar contando como
  // ativo em vez de sumir da lista.
  const querAtivo = Number(filtros.active) ? 1 : 0;
  return docs.filter((d) => (d.active === 0 ? 0 : 1) === querAtivo).map((d) => d.person);
};

// The other direction: every professional who follows this person. The person
// sees this list to know who is looking at their data.
Link_model.prototype.professionalIdsOf = async function (personId) {
  const col = await this.collection();
  const docs = await col.find({ person: new ObjectId(personId) }).toArray();
  return docs.map((d) => d.professional);
};

Link_model.prototype.countPeopleOf = async function (professionalId) {
  const col = await this.collection();
  return await col.countDocuments({ professional: new ObjectId(professionalId) });
};

Link_model.prototype.countProfessionalsOf = async function (personId) {
  const col = await this.collection();
  return await col.countDocuments({ person: new ObjectId(personId) });
};

// How many people each professional follows, for the whole platform in one
// query — the admin list needs this for every row and one count per row would
// be N queries.
Link_model.prototype.countsByProfessional = async function () {
  const col = await this.collection();

  const rows = await col
    .aggregate([{ $group: { _id: "$professional", total: { $sum: 1 } } }])
    .toArray();

  return new Map(rows.map((r) => [String(r._id), r.total]));
};

// Called when a user is deleted for good: their links would otherwise point at
// an id that no longer exists.
Link_model.prototype.deleteAllOf = async function (userId) {
  const col = await this.collection();
  await col.deleteMany({
    $or: [{ professional: new ObjectId(userId) }, { person: new ObjectId(userId) }],
  });
};

module.exports = Link_model;
