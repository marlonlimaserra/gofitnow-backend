const { ObjectId } = require("mongodb");

// QUEM ENTROU NA AULA DE HOJE.
//
// *"a diferença é que vai resetar todo o dia"*.
//
// ── O RESET NÃO É UMA ROTINA, é a chave ─────────────────────────────────
//
// Uma linha por (aula, DIA, pessoa). A aula de amanhã nasce vazia porque
// ninguém escreveu a linha de amanhã ainda — não porque algo apagou a de
// ontem.
//
// A alternativa seria um campo `presentes` na aula e uma rotina que o esvazia
// à meia-noite. Ela teria de rodar em todo fuso, em toda instância, todo dia; e
// no dia em que falhasse, a aula das 07:00 apareceria cheia de gente do dia
// anterior — sem ninguém entender por quê. Um reset que depende de algo rodar é
// um reset que um dia não roda.
//
// E há o ganho de graça: o HISTÓRICO fica. "Quantas vezes a Ana veio este mês"
// é uma consulta, e não um dado que a meia-noite comeu.
//
// ── O DIA É TEXTO, "AAAA-MM-DD", no fuso da CONTA ───────────────────────
//
// Não é um instante. A pergunta "quem veio hoje?" é de calendário, e quem
// responde é o relógio de quem atende — uma academia em Manaus às 22h de
// terça não pode ter os check-ins dela gravados como quarta porque o servidor
// está em UTC.
function GroupClassCheckin_model(app) {
  this.app = app;
}

GroupClassCheckin_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("group_class_checkins");
};

// Entrar na aula de hoje. Idempotente: dois cliques no mesmo botão não são
// duas presenças, e o índice único é quem garante isso — não uma consulta
// antes, que perderia a corrida entre dois cliques rápidos.
GroupClassCheckin_model.prototype.entrar = async function (aula, dia, pessoa) {
  if (!ObjectId.isValid(aula) || !ObjectId.isValid(pessoa)) return { ok: false, erro: "invalido" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia))) return { ok: false, erro: "dia" };

  const col = await this.collection();

  try {
    await col.insertOne({
      class: new ObjectId(aula),
      dia: String(dia),
      person: new ObjectId(pessoa),
      createdAt: new Date(),
    });
    return { ok: true, novo: true };
  } catch (erro) {
    // 11000 é o índice único: já estava dentro. Isso não é falha — é a
    // resposta certa para o segundo clique.
    if (erro?.code === 11000) return { ok: true, novo: false };
    throw erro;
  }
};

GroupClassCheckin_model.prototype.sair = async function (aula, dia, pessoa) {
  if (!ObjectId.isValid(aula) || !ObjectId.isValid(pessoa)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({
    class: new ObjectId(aula),
    dia: String(dia),
    person: new ObjectId(pessoa),
  });

  return r.deletedCount > 0;
};

// Quantos entraram em cada aula naquele dia. Um `$group` e não uma contagem
// por aula: a tela mostra a grade inteira, e uma consulta por linha seria uma
// dúzia de idas ao banco para desenhar uma tela.
GroupClassCheckin_model.prototype.contagemDoDia = async function (dia) {
  const col = await this.collection();

  const linhas = await col
    .aggregate([{ $match: { dia: String(dia) } }, { $group: { _id: "$class", n: { $sum: 1 } } }])
    .toArray();

  return Object.fromEntries(linhas.map((l) => [String(l._id), l.n]));
};

GroupClassCheckin_model.prototype.daAula = async function (aula, dia) {
  if (!ObjectId.isValid(aula)) return [];

  const col = await this.collection();
  return col.find({ class: new ObjectId(aula), dia: String(dia) }).toArray();
};

// Tudo de uma aula apagada. Sem isto os check-ins ficariam apontando para uma
// aula que não existe — nenhuma tela os alcançaria e nada os apagaria.
GroupClassCheckin_model.prototype.removeAllOf = async function (aula) {
  if (!ObjectId.isValid(aula)) return 0;

  const col = await this.collection();
  const r = await col.deleteMany({ class: new ObjectId(aula) });
  return r.deletedCount;
};

module.exports = GroupClassCheckin_model;
