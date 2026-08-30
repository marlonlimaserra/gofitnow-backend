const { ObjectId } = require("mongodb");
const instanceContext = require("../lib/instance.js");

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

// ── DE QUEM É UM ALIMENTO ─────────────────────────────────────────────────
//
// O catálogo mora no banco CENTRAL, fora das instâncias: são 10.398 linhas
// iguais para todo mundo, importadas da TACO, do IBGE e da USDA. Elas não têm
// dono, e é isso que as faz compartilhadas.
//
// Um alimento que um cliente CRIA ganha dono. A diferença importa porque este
// arquivo não passa pelo escopo de `lib/escopo.js` — `centralDb()` não é
// escopado de propósito, já que quase tudo aqui é de todos —, então o filtro
// por cliente é escrito à mão, como no catálogo de exercícios.
//
// ── O que isto conserta ───────────────────────────────────────────────────
//
// Até 29/08/2026 `update` e `delete` filtravam só pelo `_id`. Como a rota pede
// `foods.manage`, e `permissions.ALL` (que todo `admin: true` recebe) inclui
// essa chave, o administrador de QUALQUER cliente apagava um alimento do
// catálogo de TODOS — sem erro, sem aviso, e sem quebrar as dietas já montadas
// (cada refeição guarda uma cópia dos valores), então ninguém perceberia até
// tentar montar a próxima.
//
// Agora a escrita de cliente alcança só o que é dele. O catálogo compartilhado
// se cura pelo painel central, que é onde ele sempre deveria ter sido curado.
function minha() {
  return { instance: instanceContext.required() };
}

// O que ESTE cliente enxerga: o compartilhado (sem dono) mais o dele.
//
// Como `$and` e não solto no objeto para não disputar com um `$or` que a
// consulta venha a ganhar depois.
function visiveis() {
  return { $and: [{ $or: [{ instance: { $exists: false } }, minha()] }] };
}

Food_model.prototype.collection = async function () {
  // centralDb: o catálogo é de fora das instâncias.
  const db = await this.app.mongodb.centralDb();
  return db.collection("foods");
};

// As categorias em uso, para o filtro da tela.
// As tabelas presentes no catálogo, para os botões de filtro.
//
// A NOSSA entra na lista, e antes não entrava. Os 63 alimentos escritos à mão
// neste projeto nascem SEM o campo `source` — é assim que a importação os
// reconhece para não sobrescrevê-los, porque só eles têm medida caseira. O
// `distinct` os pulava, e a única tabela 100% fotografada era a que não dava
// para filtrar.
//
// "gofitnow" existe só na conversa entre a tela e a consulta; no banco o campo
// continua ausente. Mudá-lo lá quebraria a importação.
Food_model.prototype.sources = async function () {
  const col = await this.collection();

  const docs = await col
    .aggregate([
      // O `$match` do cliente à mão: esta collection não passa pelo escopo, e
      // sem ele os botões de filtro contariam o que outro cliente criou.
      { $match: visiveis() },
      { $group: { _id: "$source", total: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ])
    .toArray();

  return docs.map((d) => ({ name: d._id || "gofitnow", total: d.total }));
};

Food_model.prototype.categories = async function () {
  const col = await this.collection();
  const nomes = await col.distinct("category", { category: { $nin: [null, ""] }, ...visiveis() });
  return nomes.sort((a, b) => a.localeCompare(b, "pt-BR"));
};

Food_model.prototype.list = async function (filter = {}) {
  const col = await this.collection();
  const query = visiveis();

  if (filter.search) {
    const termo = normalize(filter.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.nameSort = { $regex: termo };
  }

  if (filter.category) query.category = String(filter.category);

  // Ver `sources()`: a nossa tabela é a que NÃO tem o campo.
  if (filter.source === "gofitnow") query.source = { $in: [null, ""] };
  else if (filter.source) query.source = String(filter.source);

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
  return (await col.findOne({ _id: new ObjectId(id), ...visiveis() })) || undefined;
};

// É DESTE cliente, e portanto pode ser alterado por ele?
//
// Existe separado do `data()` para a rota poder responder 403 com o motivo em
// vez de 404: o alimento existe e está à vista, ele é que não é dele.
Food_model.prototype.ehMinha = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  return Boolean(await col.findOne({ _id: new ObjectId(id), ...minha() }, { projection: { _id: 1 } }));
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
  // O dono é escrito DEPOIS do corpo limpo: um `instance` que viesse no pedido
  // não pode vencer o do contexto.
  const r = await col.insertOne({
    ...limpar(obj),
    ...minha(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return r.insertedId;
};

Food_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  // `minha()` e não `{_id}`: o compartilhado é de todos os clientes, e uma conta
  // não o altera. Quem quer uma variação cria a sua — é o que a tela oferece.
  const r = await col.updateOne(
    { _id: new ObjectId(id), ...minha() },
    { $set: { ...limpar(obj), updatedAt: new Date() } }
  );
  return r.matchedCount > 0;
};

Food_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), ...minha() });
  return r.deletedCount > 0;
};

module.exports = Food_model;
