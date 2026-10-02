// O RASCUNHO ENTRE O CONSENTIMENTO E A ESCOLHA.
//
// *"quando eu adicionei o Facebook, ele adicionou todas as contas, tá errado,
// pois tem gente com mais de 200 páginas"* (26/09/2026). Ele está certo, e o
// conserto muda o desenho: a volta do Facebook deixou de GRAVAR e passou a
// PERGUNTAR.
//
// Entre as duas coisas existe um vão. A pessoa volta do consentimento com uma
// lista de Páginas na mão — cada uma com o token dela —, olha, marca, e só
// então a gente grava. Esse vão precisa de um lugar, e é esta collection.
//
// ── Por que no banco, e não na sessão ou na URL ─────────────────────────
//
// Na URL não cabe: são 200 Páginas com token cada. Na sessão seria estado de
// servidor que some no primeiro deploy, no meio da escolha de alguém.
//
// ── Por que ele MORRE SOZINHO ───────────────────────────────────────────
//
// Porque ele carrega token de Página, e token de Página não expira. Um
// rascunho abandonado — a pessoa fechou a aba, foi almoçar, desistiu — é um
// segredo vivo guardado para sempre, sem ninguém para usá-lo. O TTL de 30
// minutos é o que transforma "esqueci" em "some".
const COLLECTION = "connection_choices";

// Meia hora. Tempo de olhar uma lista longa com calma e ir tomar um café no
// meio; curto o bastante para um rascunho esquecido não virar moradia.
const VALIDADE_SEGUNDOS = 30 * 60;

function EscolhaDeConexao_model(app) {
  this.app = app;
}

EscolhaDeConexao_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection(COLLECTION);
};

EscolhaDeConexao_model.prototype.criar = async function (tipo, contas, extras = {}) {
  const col = await this.collection();
  const escolha = this.app.uuidv4();

  await col.insertOne({
    escolha,
    tipo: String(tipo),
    contas,
    truncada: Boolean(extras.truncada),
    userId: extras.userId ? String(extras.userId) : null,
    createdAt: new Date(),
  });

  return escolha;
};

EscolhaDeConexao_model.prototype.ler = async function (escolha) {
  if (!escolha) return null;
  const col = await this.collection();
  return col.findOne({ escolha: String(escolha) });
};

// O que a TELA vê: sem token nenhum. A lista é para marcar caixinha, e o
// token só é usado do lado de cá, na hora de gravar.
EscolhaDeConexao_model.prototype.paraTela = function (doc) {
  if (!doc) return null;
  return {
    escolha: doc.escolha,
    tipo: doc.tipo,
    truncada: Boolean(doc.truncada),
    contas: (doc.contas || []).map((c) => ({
      externalId: c.externalId,
      nome: c.nome || "",
      usuario: c.usuario || "",
      foto: c.foto || "",
      instagramVinculado: c.instagramVinculado || null,
    })),
  };
};

EscolhaDeConexao_model.prototype.apagar = async function (escolha) {
  const col = await this.collection();
  await col.deleteOne({ escolha: String(escolha) });
};

module.exports = EscolhaDeConexao_model;
module.exports.COLLECTION = COLLECTION;
module.exports.VALIDADE_SEGUNDOS = VALIDADE_SEGUNDOS;
