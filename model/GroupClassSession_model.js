const { ObjectId } = require("mongodb");

// A AULA DE UM DIA — o que muda de uma ocorrência para a outra.
//
// *"'fechar' aula para ninguém mais se inscrever"*.
//
// ── Por que uma collection, e não um campo na aula ──────────────────────
//
// A aula é permanente; fechar é de HOJE. Um `fechada: true` no documento da
// aula ficaria fechado amanhã também — e alguém teria de lembrar de reabrir
// toda manhã, ou uma rotina teria de fazê-lo (e no dia em que falhasse, a
// academia inteira ficaria sem inscrição sem ninguém entender).
//
// É a mesma escolha do check-in: a chave é (aula, dia, horário), e o dia
// seguinte nasce limpo porque ninguém escreveu a linha dele.
//
// ── E POR QUE A LINHA SÓ NASCE QUANDO SE FECHA ──────────────────────────
//
// Não há um documento por aula por dia esperando ser usado. Aula aberta é a
// ausência de linha, e é o estado de 99% delas: criar uma linha por aula por
// dia encheria a collection para gravar "nada aconteceu".
function GroupClassSession_model(app) {
  this.app = app;
}

GroupClassSession_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("group_class_sessions");
};

// Fechar ou reabrir. `upsert` porque a linha pode não existir — e ela não
// existe justamente no caso mais comum, que é fechar uma aula pela primeira
// vez naquele dia.
GroupClassSession_model.prototype.fechar = async function (aula, dia, inicio, fechada, quem) {
  if (!ObjectId.isValid(aula)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia))) return false;

  const n = Number(inicio);
  if (!Number.isInteger(n) || n < 0) return false;

  const col = await this.collection();
  await col.updateOne(
    { class: new ObjectId(aula), dia: String(dia), inicio: n },
    {
      $set: {
        fechada: fechada === true,
        // QUEM fechou e QUANDO. Não é auditoria por precaução: numa academia
        // com três pessoas no balcão, "quem fechou a aula das 7?" é uma
        // pergunta que se faz no mesmo dia.
        fechadaPor: fechada === true && quem ? new ObjectId(quem) : null,
        fechadaEm: fechada === true ? new Date() : null,
      },
    },
    { upsert: true }
  );

  return true;
};

// As fechadas de um dia, como um conjunto de chaves `aula:minutos`. Uma
// consulta para a grade inteira: perguntar por aula seria uma dúzia de idas ao
// banco para desenhar uma tela.
GroupClassSession_model.prototype.fechadasDoDia = async function (dia) {
  const col = await this.collection();

  const linhas = await col
    .find({ dia: String(dia), fechada: true }, { projection: { class: 1, inicio: 1 } })
    .toArray();

  return new Set(linhas.map((l) => `${l.class}:${l.inicio}`));
};

GroupClassSession_model.prototype.estaFechada = async function (aula, dia, inicio) {
  if (!ObjectId.isValid(aula)) return false;

  const col = await this.collection();
  const doc = await col.findOne({
    class: new ObjectId(aula),
    dia: String(dia),
    inicio: Number(inicio),
  });

  return doc?.fechada === true;
};

// Tudo de uma aula apagada — as linhas não têm vida própria sem ela.
GroupClassSession_model.prototype.removeAllOf = async function (aula) {
  if (!ObjectId.isValid(aula)) return 0;

  const col = await this.collection();
  const r = await col.deleteMany({ class: new ObjectId(aula) });
  return r.deletedCount;
};

module.exports = GroupClassSession_model;
