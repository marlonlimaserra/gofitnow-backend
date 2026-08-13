const { ObjectId } = require("mongodb");

// O catálogo de alimentos — ÚNICO, no banco central, como o de exercícios.
//
//   { name, nameSort, category, portion, unit, kcal, protein, carbs, fat, fiber }
//
// Arroz é arroz em qualquer instância. Copiar a tabela por cliente seria guardar
// a mesma informação N vezes para depois ter de corrigir N vezes — foi a mesma
// conclusão a que o catálogo de exercícios chegou.
//
// Os valores nutricionais são SEMPRE por 100 g (ou 100 ml). É a forma como as
// tabelas oficiais publicam, e ter uma base única evita a pergunta "por 100 g ou
// por porção?" toda vez que alguém for somar. A porção usual fica em `portion`,
// só para a tela sugerir uma quantidade — quem calcula sempre usa a regra de
// três sobre os 100 g.
//
// `category` é texto livre, como `muscleGroup` nos exercícios: a taxonomia
// cresce do uso em vez de ser fixada de antemão.
function Food_model(app) {
  this.app = app;
}

// Chave de busca e de ordenação: sem acento, minúscula, sem espaço sobrando.
// A ordenação binária do Mongo jogaria todo nome com maiúscula para a frente, e
// uma busca por "feijao" não acharia "feijão".
function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

Food_model.prototype.collection = async function () {
  // centralDb: o catálogo é de fora das instâncias.
  const db = await this.app.mongodb.centralDb();
  return db.collection("foods");
};

// As categorias em uso, para o filtro da tela.
// As tabelas presentes no catálogo, para os botões de filtro.
Food_model.prototype.sources = async function () {
  const col = await this.collection();
  const nomes = await col.distinct("source", { source: { $nin: [null, ""] } });
  return nomes.sort();
};

Food_model.prototype.categories = async function () {
  const col = await this.collection();
  const nomes = await col.distinct("category", { category: { $nin: [null, ""] } });
  return nomes.sort((a, b) => a.localeCompare(b, "pt-BR"));
};

Food_model.prototype.list = async function (filter = {}) {
  const col = await this.collection();
  const query = {};

  if (filter.search) {
    const termo = normalize(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.nameSort = { $regex: termo };
  }

  if (filter.category) query.category = String(filter.category);
  if (filter.source) query.source = String(filter.source);

  const page = Math.max(1, Number(filter.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(filter.limit) || 20));

  const total = await col.countDocuments(query);
  const rows = await col
    .find(query)
    .sort({ nameSort: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  return { rows, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
};

Food_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

// Número que pode faltar. Alimento sem valor nutricional é normal — uma receita
// da casa, um suplemento sem rótulo — e zero mentiria na soma do dia.
function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function limpar(obj) {
  return {
    name: String(obj.name || "").trim(),
    nameSort: normalize(obj.name),
    category: obj.category ? String(obj.category).trim() : "",
    // A porção usual, em gramas ou ml: "1 fatia = 25 g". Só sugestão de tela.
    portion: numeroOuNulo(obj.portion),
    portionLabel: obj.portionLabel ? String(obj.portionLabel).trim() : "",
    unit: obj.unit === "ml" ? "ml" : "g",
    // De qual TABELA veio: TACO, IBGE, USDA… Um alimento cadastrado à mão fica
    // sem fonte, e é assim que a tela sabe distinguir "isto veio da Unicamp" de
    // "isto alguém digitou aqui".
    source: obj.source ? String(obj.source).trim() : "",
    kcal: numeroOuNulo(obj.kcal),
    protein: numeroOuNulo(obj.protein),
    carbs: numeroOuNulo(obj.carbs),
    fat: numeroOuNulo(obj.fat),
    fiber: numeroOuNulo(obj.fiber),
  };
};

Food_model.prototype.insert = async function (obj) {
  const col = await this.collection();
  const r = await col.insertOne({ ...limpar(obj), createdAt: new Date(), updatedAt: new Date() });
  return r.insertedId;
};

Food_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...limpar(obj), updatedAt: new Date() } }
  );
  return r.matchedCount > 0;
};

Food_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

module.exports = Food_model;
