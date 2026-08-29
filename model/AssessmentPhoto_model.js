const { ObjectId } = require("mongodb");
const { parseImageDataUri } = require("../lib/imageDataUri.js");
const lados = require("../lib/assessmentPhotoSides.js");

// A collection `assessment_photos` — as fotos de evolução de cada coleta.
//
// Um ângulo por vaga, e os ângulos são os que a CASA configurou — de fábrica os
// quatro de sempre (frente, lado direito, lado esquerdo, costas). Sejam quais
// forem, são os MESMOS em toda coleta da conta, porque a comparação depende
// disso: duas fotos de ângulos diferentes não mostram progresso, mostram duas
// poses. Quem escreve a lista é `lib/assessmentPhotoSides.js`.
//
// Ficam SEPARADAS do documento da avaliação, pelo mesmo motivo do avatar: no
// documento, as fotos viajariam em toda listagem da aba, e a tela carregaria
// oitenta imagens para desenhar cinco cartões de número. Aqui cada uma tem a
// própria URL, que o navegador cacheia.
//
// O que fica NO documento da avaliação é só um carimbo de data por lado
// (`photos: { front: 1723… }`). Ele responde de graça as duas perguntas da
// tela — "esta coleta tem foto de frente?" e "a que eu cacheei ainda vale?" —
// sem consulta nenhuma a esta collection.
function AssessmentPhoto_model(app) {
  this.app = app;
}

// Uma foto de corpo inteiro precisa de mais detalhe que um avatar de 512 px —
// é nela que se enxerga a diferença de três meses. A tela envia por volta de
// 300 KB; o teto existe para o que não veio da tela.
const MAX_BYTES = 4 * 1024 * 1024;

AssessmentPhoto_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("assessment_photos");
};

AssessmentPhoto_model.prototype.parseDataUri = function (dataUri) {
  return parseImageDataUri(dataUri, MAX_BYTES);
};

// Vale este ângulo NESTA casa?
//
// Era uma checagem contra quatro constantes; virou uma consulta porque a lista
// passou a ser da instância. A leitura é o documento único de configuração — o
// mesmo que já responde vocabulário, moeda e tema —, então não é uma ida nova
// ao banco por conta desta função, é a mesma que a tela já faz.
//
// Continua sendo a porta que impede `photos.$set` de virar campo arbitrário no
// documento da coleta: o que não está na lista não existe.
AssessmentPhoto_model.prototype.isSide = async function (side) {
  const lista = await this.app.api.tenant.assessmentPhotoSides();
  return lista.some((l) => l.key === String(side));
};

AssessmentPhoto_model.prototype.save = async function (assessmentId, side, mime, buffer) {
  const col = await this.collection();
  const agora = new Date();

  // Um documento por (avaliação, lado): trocar a foto de frente substitui
  // aquela, e não mexe nas outras três.
  await col.updateOne(
    { assessment: new ObjectId(assessmentId), side },
    {
      $set: {
        assessment: new ObjectId(assessmentId),
        side,
        mime,
        data: buffer,
        size: buffer.length,
        updatedAt: agora,
      },
    },
    { upsert: true }
  );

  return agora;
};

AssessmentPhoto_model.prototype.data = async function (assessmentId, side) {
  if (!ObjectId.isValid(assessmentId)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ assessment: new ObjectId(assessmentId), side });
  return doc || undefined;
};

AssessmentPhoto_model.prototype.remove = async function (assessmentId, side) {
  if (!ObjectId.isValid(assessmentId)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ assessment: new ObjectId(assessmentId), side });
  return r.deletedCount > 0;
};

// Apagadas junto com a coleta. Sem isto, os bytes ficariam no banco para
// sempre, sem nada apontando para eles — e ninguém procura o que não aparece.
AssessmentPhoto_model.prototype.deleteAllOfAssessment = async function (assessmentId) {
  if (!ObjectId.isValid(assessmentId)) return 0;
  const col = await this.collection();

  const r = await col.deleteMany({ assessment: new ObjectId(assessmentId) });
  return r.deletedCount || 0;
};

AssessmentPhoto_model.prototype.deleteAllOfAssessments = async function (ids) {
  const validos = (ids || []).filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (!validos.length) return 0;

  const col = await this.collection();
  const r = await col.deleteMany({ assessment: { $in: validos } });
  return r.deletedCount || 0;
};

module.exports = AssessmentPhoto_model;
module.exports.PADRAO = lados.PADRAO;
