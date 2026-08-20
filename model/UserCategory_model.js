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
  const registros = await this.app.api.center.list();
  const ativas = registros.filter((r) => r.active !== false && r.active !== 0);

  const total = {};

  for (const registro of ativas) {
    try {
      const db = await this.app.mongodb.instanceDb(registro.instance);

      const linhas = await db
        .collection("users")
        .aggregate([
          // Sem categoria também conta, como `(sem categoria)`: a diferença entre
          // "ninguém é nutricionista" e "ninguém preencheu" é a informação mais
          // útil desta tela no começo.
          { $group: { _id: { $ifNull: ["$category", "(sem categoria)"] }, n: { $sum: 1 } } },
        ])
        .toArray();

      for (const l of linhas) total[l._id] = (total[l._id] || 0) + l.n;
    } catch (error) {
      // Cliente com banco fora do ar sai desta leitura e volta na próxima. Melhor
      // um número incompleto que uma tela de erro.
      console.error(`[categorias] não li ${registro.instance}: ${error.message}`);
    }
  }

  return total;
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
    const db = await this.app.mongodb.instanceDb(instanceContext.required());
    const { ObjectId } = require("mongodb");
    await db.collection("users").updateOne({ _id: new ObjectId(userId) }, { $unset: { category: "" } });
    return { ok: true, category: "" };
  }

  const permitidas = await this.paraTipo(tipoDeUsuario);
  if (!permitidas.some((c) => c.key === chave)) return { erro: "invalid_category" };

  const db = await this.app.mongodb.instanceDb(instanceContext.required());
  const { ObjectId } = require("mongodb");
  const r = await db
    .collection("users")
    .updateOne({ _id: new ObjectId(userId) }, { $set: { category: chave, updatedAt: new Date() } });

  return r.matchedCount ? { ok: true, category: chave } : { erro: "not_found" };
};

module.exports = UserCategory_model;
