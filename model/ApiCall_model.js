const { ObjectId } = require("mongodb");

// A collection `api_calls` — toda chamada feita com chave de API.
//
// Existe para a pessoa poder responder "quem usou minha chave, quando e de
// onde". Por isso guarda IP e data mesmo quando a chamada foi RECUSADA: uma
// tentativa com chave revogada, ou um estouro de limite, é justamente o que
// interessa ver.
//
// Separado do user_action_history de propósito: aquele registra o que mudou no
// sistema, este registra o tráfego da chave. Misturar os dois encheria a tela
// de auditoria de leitura que não alterou nada.
function ApiCall_model(app) {
  this.app = app;
}

// Quanto tempo o registro fica. Um índice TTL (database/schema.js) varre o
// resto — sem isso a collection cresce para sempre.
const DIAS_RETENCAO = 90;

ApiCall_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("api_calls");
};

// Nunca rejeita e nunca é esperado por quem chama: um log que derruba a
// requisição é pior do que log nenhum.
ApiCall_model.prototype.record = function (dados) {
  this.collection()
    .then((col) =>
      col.insertOne({
        user: dados.user ? new ObjectId(dados.user) : null,
        apiKey: dados.apiKey ? new ObjectId(dados.apiKey) : null,
        // O prefixo fica desnormalizado no registro para o log continuar
        // dizendo qual chave foi mesmo depois de ela ser revogada.
        prefix: dados.prefix || null,
        method: String(dados.method || ""),
        path: String(dados.path || ""),
        status: Number(dados.status) || 0,
        ip: dados.ip || null,
        userAgent: dados.userAgent ? String(dados.userAgent).slice(0, 300) : null,
        // Quanto a chamada demorou, em ms. Ajuda a explicar lentidão sem
        // precisar reproduzir.
        ms: Number(dados.ms) || 0,
        createdAt: new Date(),
      })
    )
    .catch((error) => {
      console.error("[api-calls] falhou ao registrar:", error.message);
    });
};

ApiCall_model.prototype.list = async function (userId, filtro = {}) {
  const col = await this.collection();

  const query = { user: new ObjectId(userId) };
  if (filtro.prefix) query.prefix = String(filtro.prefix);
  if (filtro.status) query.status = Number(filtro.status);
  if (filtro.method) query.method = String(filtro.method).toUpperCase();

  if (filtro.from || filtro.to) {
    query.createdAt = {};
    if (filtro.from) query.createdAt.$gte = new Date(String(filtro.from) + "T00:00:00");
    // O fim do dia, não o começo: filtrar "até 07/01" tem de incluir o dia 7.
    if (filtro.to) query.createdAt.$lte = new Date(String(filtro.to) + "T23:59:59.999");
  }

  const limit = Math.min(Number(filtro.limit) || 50, 200);
  const skip = Math.max(Number(filtro.skip) || 0, 0);

  const [rows, total] = await Promise.all([
    col.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments(query),
  ]);

  return { rows, total };
};

// Números do topo da tela: quantas chamadas, quantas deram erro e quando foi a
// última — na janela que a pessoa está olhando.
ApiCall_model.prototype.summary = async function (userId) {
  const col = await this.collection();
  const user = new ObjectId(userId);
  const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, ultimas24h, erros, ultima] = await Promise.all([
    col.countDocuments({ user }),
    col.countDocuments({ user, createdAt: { $gte: desde } }),
    col.countDocuments({ user, status: { $gte: 400 } }),
    col.find({ user }).sort({ createdAt: -1 }).limit(1).next(),
  ]);

  return { total, last24h: ultimas24h, errors: erros, lastAt: ultima ? ultima.createdAt : null };
};

module.exports = ApiCall_model;
module.exports.DIAS_RETENCAO = DIAS_RETENCAO;
