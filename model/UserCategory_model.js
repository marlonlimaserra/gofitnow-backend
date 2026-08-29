const instanceContext = require("../lib/instance.js");

// O QUE CADA PESSOA É, pelo lado de quem tem os usuários.
//
// O CATÁLOGO mora no banco central, publicado pelo painel. A RESPOSTA mora no
// documento do usuário, aqui na instância. São dois lugares porque são duas coisas:
// a lista precisa ser igual para todos os clientes (senão "nutricionista" significa
// coisas diferentes e a soma não soma), e a resposta é de uma pessoa.
//
// ── `centralDb()` e NÃO `connectToServer()` ───────────────────────────────
//
// A armadilha que mais engana neste backend: `connectToServer()` aponta para o
// banco da INSTÂNCIA, porque é o caso da esmagadora maioria dos modelos. Quem é
// central chama `centralDb()` de propósito — usar o errado aqui leria o catálogo no
// banco do cliente, onde ele não existe, devolvendo lista vazia sem erro nenhum.
function UserCategory_model(app) {
  this.app = app;
}

UserCategory_model.prototype.publicas = async function () {
  const db = await this.app.mongodb.centralDb();
  return db
    .collection("user_categories")
    .find({ active: { $ne: false } })
    .sort({ order: 1, name: 1 })
    .toArray();
};

// A lista que a TELA recebe, já filtrada pelo tipo de usuário.
//
// Um aluno não escolhe "endocrinologista", e um profissional não escolhe "aluno".
// Oferecer a lista inteira nos dois casos é erro de cadastro esperando acontecer —
// e erro de cadastro aqui contamina a estatística que o site vai exibir.
UserCategory_model.prototype.paraTipo = async function (tipoDeUsuario) {
  const todas = await this.publicas();
  const querem = tipoDeUsuario === "student" ? ["atendido"] : ["profissional", "negocio"];

  return todas
    .filter((c) => querem.includes(c.tipo))
    .map((c) => ({ key: c.key, name: c.name, tipo: c.tipo }));
};

// ── A CONTAGEM, varrendo TODAS as instâncias ──────────────────────────────
//
// Ela mora aqui, e não no painel, pela mesma fronteira do provisionamento e do
// `stats`: o painel não abre banco de cliente, e nunca abriu. Quem é dono do dado
// da instância é esta API, e o painel pergunta a ela.
//
// Devolve `{ chave: quantos }` somando tudo. O painel usa para mostrar o retrato de
// quem usa o sistema, e o site para exibir prova social.
UserCategory_model.prototype.contagens = async function () {
  // ── ERA UM LAÇO POR TODOS OS BANCOS ────────────────────────────────────────
  //
  // Com um banco por cliente, esta contagem abria o banco de cada cliente ativo,
  // rodava uma agregação em cada um e somava em JavaScript. Com mil clientes
  // seriam mil agregações por abertura de tela — e um `try/catch` por volta,
  // porque um banco fora do ar derrubava a página.
  //
  // Num banco só é UMA agregação, servida pelo índice `{ instance: 1, ... }` de
  // `users`. O `try/catch` por cliente deixou de fazer sentido: não há mais
  // "banco de um cliente fora do ar" — ou o banco está de pé, ou nada está.
  //
  // O banco vem CRU de propósito: esta é a única leitura do sistema que é sobre
  // TODOS os clientes ao mesmo tempo. Ela alimenta o painel, que é nosso, e o
  // resultado é agregado — sai contagem por categoria, nunca documento de
  // ninguém.
  const db = await this.app.mongodb.bancoCruSemEscopo();

  // Só os clientes ATIVOS entram na conta, como antes. A lista vem do registro
  // central, que é quem sabe quem está ativo.
  const registros = await this.app.api.center.list();
  const ativos = registros
    .filter((r) => r.active !== false && r.active !== 0)
    .map((r) => r.instance);

  const linhas = await db
    .collection("users")
    .aggregate([
      { $match: { instance: { $in: ativos } } },
      // Sem categoria também conta, como `(sem categoria)`: a diferença entre
      // "ninguém é nutricionista" e "ninguém preencheu" é a informação mais
      // útil desta tela no começo.
      { $group: { _id: { $ifNull: ["$category", "(sem categoria)"] }, n: { $sum: 1 } } },
    ])
    .toArray();

  const total = {};
  for (const l of linhas) total[l._id] = l.n;
  return total;
};

// Só a CONFERÊNCIA, sem gravar. Os formulários de cadastro validam ANTES de
// criar o documento — recusar a categoria depois de inserir deixaria uma ficha
// criada pela metade, com um 400 dizendo que nada foi salvo.
//
// Vazio é válido: quem não quis dizer o que é tem direito de não dizer.
UserCategory_model.prototype.valida = async function (key, tipoDeUsuario) {
  const chave = String(key || "").trim();
  if (!chave) return true;

  const permitidas = await this.paraTipo(tipoDeUsuario);
  return permitidas.some((c) => c.key === chave);
};

// A categoria de UMA pessoa. Conferida contra o catálogo antes de gravar.
//
// Sem a conferência, um `category: "nutrisionista"` gravado por um cliente com
// typo no formulário viraria uma categoria fantasma na contagem — que ninguém
// cadastrou e ninguém consegue renomear.
UserCategory_model.prototype.gravar = async function (userId, key, tipoDeUsuario) {
  const chave = String(key || "").trim();

  // Vazio APAGA o campo, e é diferente de inválido: quem não quis dizer o que é
  // tem direito de não dizer.
  if (!chave) {
    const db = await this.app.mongodb.connectToServer();
    const { ObjectId } = require("mongodb");
    await db.collection("users").updateOne({ _id: new ObjectId(userId) }, { $unset: { category: "" } });
    return { ok: true, category: "" };
  }

  if (!(await this.valida(chave, tipoDeUsuario))) return { erro: "invalid_category" };

  const db = await this.app.mongodb.connectToServer();
  const { ObjectId } = require("mongodb");
  const r = await db
    .collection("users")
    .updateOne({ _id: new ObjectId(userId) }, { $set: { category: chave, updatedAt: new Date() } });

  return r.matchedCount ? { ok: true, category: chave } : { erro: "not_found" };
};

module.exports = UserCategory_model;
