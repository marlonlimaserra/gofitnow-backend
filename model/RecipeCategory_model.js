const { ObjectId } = require("mongodb");
const instanceContext = require("../lib/instance.js");

// As categorias de dieta COMO O CLIENTE VÊ.
//
// São duas listas coladas: as que a gente publica (cutting, manutenção,
// bulking), que moram no catálogo compartilhado, e as que ele criou, que moram
// no banco dele.
//
// ── Por que o cliente não pode EDITAR as nossas ───────────────────────────
//
// Porque as receitas do catálogo estão classificadas por elas. Se cada cliente
// pudesse redefinir "bulking", a mesma receita significaria coisas diferentes em
// cada instalação — e a sugestão, que é o motivo de tudo isso existir, passaria a
// sugerir errado sem ninguém entender por quê.
//
// O que ele pode é ESCONDER: quem só atende atleta de força não quer "cutting"
// ocupando a tela. Esconder é decisão de tela, não mudança de significado.
//
// ── Onde mora o quê ───────────────────────────────────────────────────────
//
//   compartilhado  `recipe_categories`  — as nossas, publicadas pelo painel
//   do cliente     `recipe_categories`  — as dele, e as nossas que ele escondeu
//
// Mesmo nome de collection nos dois bancos de propósito: é a mesma ideia, e o
// que separa é o banco, como em todo o resto do sistema.
function RecipeCategory_model(app) {
  this.app = app;
}

// As nossas — leitura pura, do catálogo compartilhado.
//
// `centralDb()` e NÃO `connectToServer()`. A diferença é a que mais engana neste
// backend: `connectToServer()` aponta para o banco da INSTÂNCIA, porque é o caso
// da esmagadora maioria dos modelos. Quem é central chama `centralDb()` de
// propósito — e usar o errado aqui leria as categorias no banco do cliente, onde
// elas não existem, devolvendo lista vazia sem erro nenhum.
RecipeCategory_model.prototype.publicas = async function () {
  const db = await this.app.mongodb.centralDb();
  return db
    .collection("recipe_categories")
    .find({ active: { $ne: false } })
    .sort({ order: 1, name: 1 })
    .toArray();
};

// As do cliente — banco dele. Guarda dois tipos de documento:
//
//   { key, name, own: true }    uma categoria que ele criou
//   { key, hidden: true }        uma das nossas que ele escondeu
//
// Num documento só e não em duas collections porque a pergunta que a tela faz é
// uma só: "o que eu mostro?". Duas collections dariam duas consultas e uma
// junção para responder isso.
RecipeCategory_model.prototype.collection = async function () {
  // `instanceDb()` explícito: `connectToServer()` faria o mesmo hoje, mas ele
  // ignora argumento e esconde de qual banco se está falando. Nas duas linhas
  // acima e abaixo o banco é diferente — deixar isso legível é o que evita
  // repetir o erro.
  const db = await this.app.mongodb.instanceDb(instanceContext.required());
  return db.collection("recipe_categories");
};

// ── O QUE A TELA RECEBE ───────────────────────────────────────────────────
//
// A lista final, já resolvida: as nossas menos as escondidas, mais as dele.
//
// A junção acontece AQUI e não na tela porque ela é a regra do produto — quem
// escrever outra tela amanhã (o app do aluno, um relatório) recebe a mesma lista
// sem precisar reimplementar a subtração.
RecipeCategory_model.prototype.paraCliente = async function () {
  const [nossas, dele] = await Promise.all([
    this.publicas(),
    (await this.collection()).find({}).sort({ name: 1 }).toArray(),
  ]);

  const escondidas = new Set(dele.filter((c) => c.hidden).map((c) => c.key));

  const publicas = nossas
    .filter((c) => !escondidas.has(c.key))
    .map((c) => ({
      key: c.key,
      name: c.name,
      description: c.description || "",
      // `propria: false` é o que a tela usa para não oferecer editar nem apagar.
      propria: false,
    }));

  const proprias = dele
    .filter((c) => c.own)
    .map((c) => ({
      _id: c._id,
      key: c.key,
      name: c.name,
      description: c.description || "",
      propria: true,
    }));

  return [...publicas, ...proprias];
};

// As nossas COM o estado de escondida — para a tela de configuração, que precisa
// mostrar o que está oculto para poder desocultar.
RecipeCategory_model.prototype.paraConfigurar = async function () {
  const [nossas, dele] = await Promise.all([
    this.publicas(),
    (await this.collection()).find({}).toArray(),
  ]);

  const escondidas = new Set(dele.filter((c) => c.hidden).map((c) => c.key));

  return {
    padrao: nossas.map((c) => ({
      key: c.key,
      name: c.name,
      description: c.description || "",
      escondida: escondidas.has(c.key),
    })),
    proprias: dele
      .filter((c) => c.own)
      .map((c) => ({ _id: c._id, key: c.key, name: c.name, description: c.description || "" })),
  };
};

function chaveDe(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Esconder ou mostrar uma das NOSSAS.
//
// Só aceita chave que exista no catálogo compartilhado: sem essa conferência,
// esconder um nome digitado errado criaria lixo silencioso no banco do cliente —
// registros que nunca escondem nada e nunca aparecem em lugar nenhum.
RecipeCategory_model.prototype.esconder = async function (key, esconder) {
  const chave = chaveDe(key);
  if (!chave) return { erro: "invalid_key" };

  const nossas = await this.publicas();
  if (!nossas.some((c) => c.key === chave)) return { erro: "not_found" };

  const col = await this.collection();

  if (esconder) {
    await col.updateOne(
      { key: chave, own: { $ne: true } },
      { $set: { key: chave, hidden: true, updatedAt: new Date() } },
      { upsert: true }
    );
  } else {
    // Desesconder APAGA o registro em vez de gravar `hidden: false`.
    //
    // O padrão é aparecer. Guardar "não está escondida" seria guardar a ausência
    // de uma decisão — e acumularia um documento por categoria por cliente sem
    // nenhum deles significar nada.
    await col.deleteOne({ key: chave, own: { $ne: true } });
  }

  return { ok: true };
};

// Criar uma DELE.
RecipeCategory_model.prototype.criar = async function (entrada) {
  const nome = String(entrada?.name || "").trim().slice(0, 60);
  if (!nome) return { erro: "invalid_name" };

  const chave = chaveDe(nome);
  if (!chave) return { erro: "invalid_name" };

  // Não pode colidir com uma nossa: duas categorias com a mesma chave fariam a
  // receita classificada pelo catálogo aparecer sob a categoria dele.
  const nossas = await this.publicas();
  if (nossas.some((c) => c.key === chave)) return { erro: "reserved" };

  const col = await this.collection();
  await col.createIndex({ key: 1 }, { unique: true, name: "por_chave" });

  try {
    const r = await col.insertOne({
      key: chave,
      name: nome,
      description: String(entrada?.description || "").trim().slice(0, 300),
      own: true,
      createdAt: new Date(),
    });
    return { id: r.insertedId, key: chave };
  } catch (error) {
    if (error?.code === 11000) return { erro: "duplicated" };
    throw error;
  }
};

RecipeCategory_model.prototype.renomear = async function (id, nome) {
  if (!ObjectId.isValid(id)) return { ok: false };

  const limpo = String(nome || "").trim().slice(0, 60);
  if (!limpo) return { erro: "invalid_name" };

  const col = await this.collection();
  // `own: true` na condição: é a linha que impede renomear uma ocultação nossa
  // por um id copiado à mão.
  const r = await col.updateOne(
    { _id: new ObjectId(id), own: true },
    { $set: { name: limpo, updatedAt: new Date() } }
  );

  return { ok: r.matchedCount > 0 };
};

RecipeCategory_model.prototype.apagar = async function (id) {
  if (!ObjectId.isValid(id)) return { ok: false };

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id), own: true });

  return { ok: r.deletedCount > 0 };
};

// ── O QUE OS CLIENTES INVENTARAM ──────────────────────────────────────────
//
// Varre todas as instâncias e devolve as categorias que elas criaram, agrupadas
// por chave e com a lista de quem criou.
//
// Não é curiosidade: é a taxonomia REAL emergindo do uso. Quando cinco clientes
// criam "low carb" por conta própria, isso é um pedido de produto escrito por
// quem usa — e a resposta certa é promover a categoria para padrão, não deixar
// cada um cadastrar a sua para sempre.
//
// ── Por que a varredura mora AQUI e não no painel ─────────────────────────
//
// Porque o painel não abre banco de cliente, e nunca abriu: quem é dono dos
// dados da instância é esta API, e o painel pergunta a ela — a mesma fronteira
// do provisionamento e do `stats`. Manter isso vale mais que economizar uma
// chamada HTTP.
RecipeCategory_model.prototype.dosClientes = async function () {
  const registros = await this.app.api.center.list();
  const ativas = registros.filter((r) => r.active !== false && r.active !== 0);

  const porChave = new Map();

  for (const registro of ativas) {
    try {
      const db = await this.app.mongodb.instanceDb(registro.instance);
      const dele = await db.collection("recipe_categories").find({ own: true }).toArray();

      for (const c of dele) {
        const atual = porChave.get(c.key) || { key: c.key, name: c.name, clientes: [] };
        atual.clientes.push(registro.instance);
        porChave.set(c.key, atual);
      }
    } catch (error) {
      // Cliente com banco fora do ar sai desta leitura e volta na próxima.
      // Melhor uma lista incompleta que uma tela de erro.
      console.error(`[categorias] não li ${registro.instance}: ${error.message}`);
    }
  }

  // Mais usadas primeiro: é a ordem que responde "o que eu deveria promover?".
  return [...porChave.values()].sort(
    (a, b) => b.clientes.length - a.clientes.length || a.name.localeCompare(b.name)
  );
};

module.exports = RecipeCategory_model;
module.exports.chaveDe = chaveDe;
