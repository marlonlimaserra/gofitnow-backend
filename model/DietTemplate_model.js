const { ObjectId } = require("mongodb");
const { limparRefeicao, numeroOuNulo } = require("./Diet_model.js");
const { weekdaysOf } = require("../lib/weekdays.js");

// A collection `diet_templates` — os planos alimentares prontos do profissional.
//
// Cada template é de UM profissional. Não é catálogo compartilhado: "Cutting 1800"
// do nutricionista da clínica não quer dizer nada na tela de um personal, e o
// conteúdo de um plano alimentar é decisão clínica de quem assina.
//
// ── A diferença em relação ao template de TREINO ──────────────────────────
//
// O de treino guarda só o cabeçalho (nome, objetivo, dica, sessões previstas) — o
// trabalho de montar um treino está nas sessões, e elas ficam de fora.
//
// Aqui as REFEIÇÕES entram. É deliberado, e é o que faz o recurso valer a tela:
// montar um plano alimentar é escrever seis refeições com dez alimentos cada,
// pesando cada um. Um template com nome e meta de calorias economizaria trinta
// segundos; com as refeições dentro, economiza a tarde.
//
// ── O que NÃO entra ───────────────────────────────────────────────────────
//
// As DATAS. Um período só faz sentido no plano de uma pessoa, e um template
// carregando "20/08 a 20/09" estaria errado no dia seguinte ao que foi criado.
// Mesma decisão do template de treino, pelo mesmo motivo.
//
// E o ALUNO, claro: o template existe justamente para servir a qualquer um.
function DietTemplate_model(app) {
  this.app = app;
}

DietTemplate_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("diet_templates");
};

// Os campos que um template carrega, saneados.
//
// As refeições passam pelo MESMO `limparRefeicao` do plano (importado de
// `Diet_model`): é a garantia de que um plano criado a partir de template tem
// exatamente a forma de um plano criado à mão — inclusive a chave da foto de cada
// alimento e o grupo de substituição.
function limpar(obj) {
  return {
    name: String(obj.name || "").trim(),
    goal: obj.goal ? String(obj.goal).trim() : "",
    note: obj.note ? String(obj.note).trim() : "",
    weekdays: weekdaysOf(obj.weekdays),
    targetKcal: numeroOuNulo(obj.targetKcal),
    targetProtein: numeroOuNulo(obj.targetProtein),
    targetCarbs: numeroOuNulo(obj.targetCarbs),
    targetFat: numeroOuNulo(obj.targetFat),
    // O `_id` de cada refeição é PRESERVADO quando vem válido.
    //
    // Ele era descartado aqui, e isso quebrava a edição de refeição DENTRO do
    // template: cada salvamento gerava ids novos, então a tela ficava com ids velhos
    // em mão e a próxima edição criava uma refeição em vez de alterar a existente.
    //
    // Forçar id novo continua necessário — mas só onde há CÓPIA, e é lá que isso
    // agora acontece: no controller, ao criar um template a partir de um plano e ao
    // criar um plano a partir de um template. Ver `controllers/DietTemplate.js`.
    meals: (obj.meals || []).map((r, i) => limparRefeicao(r, i)),
  };
}

DietTemplate_model.prototype.list = async function (professionalId) {
  const col = await this.collection();

  const docs = await col
    .find({ professional: new ObjectId(professionalId) })
    .sort({ name: 1 })
    .toArray();

  // A CONTAGEM vai na lista, o CONTEÚDO não.
  //
  // A tela de configuração mostra "5 refeições · 32 alimentos" por template. Mandar
  // o array inteiro de refeições de doze templates para desenhar dois números seria
  // trazer doze planos alimentares para a tela de ajustes.
  return docs.map((d) => ({
    ...d,
    meals: undefined,
    mealCount: (d.meals || []).length,
    foodCount: (d.meals || []).reduce((t, m) => t + (m.foods || []).length, 0),
  }));
};

// Um template inteiro, COM as refeições. É o que o formulário de plano usa ao
// aplicar.
DietTemplate_model.prototype.data = async function (professionalId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({
    _id: new ObjectId(id),
    professional: new ObjectId(professionalId),
  });

  return doc || undefined;
};

DietTemplate_model.prototype.insert = async function (professionalId, obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    professional: new ObjectId(professionalId),
    ...limpar(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

DietTemplate_model.prototype.update = async function (professionalId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  // O dono é parte da CONSULTA, nunca do `$set`: é isso que impede um profissional
  // de editar o template de outro adivinhando um id.
  const r = await col.updateOne(
    { _id: new ObjectId(id), professional: new ObjectId(professionalId) },
    { $set: { ...limpar(obj), updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

DietTemplate_model.prototype.delete = async function (professionalId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({
    _id: new ObjectId(id),
    professional: new ObjectId(professionalId),
  });

  return r.deletedCount > 0;
};

module.exports = DietTemplate_model;
