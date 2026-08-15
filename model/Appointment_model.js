const { ObjectId } = require("mongodb");

// A collection `appointments` — os compromissos marcados com cada pessoa.
//
// Um documento é UM encontro: quando começa, quanto dura, com quem, e o que
// aconteceu com ele. Repetição semanal não existe aqui de propósito — quando
// existir, ela vai GERAR documentos como estes, não substituí-los. Uma agenda
// que guarda regra em vez de encontro não sabe responder "o que aconteceu na
// terça passada" depois que a regra mudou.
//
// O horário é gravado como INSTANTE (Date), não como "18/08 às 7h" em texto.
// Texto não se ordena por tempo, não se compara com "agora" e não sobrevive a
// quem abre o sistema de outro fuso.
function Appointment_model(app) {
  this.app = app;
}

// O que aconteceu com o compromisso.
//
//   scheduled → marcado, ainda vai acontecer
//   done      → aconteceu
//   missed    → a pessoa não veio
//   canceled  → desmarcado antes
//
// `missed` e `canceled` são coisas DIFERENTES e é por isso que são dois: um é
// falta, o outro é combinado. Juntá-los apagaria a única informação que a
// agenda tem sobre assiduidade.
const STATUS = ["scheduled", "done", "missed", "canceled"];

const DURACAO_PADRAO = 60;

Appointment_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("appointments");
};

// Uma lista de ids válidos. Aceita um só ou vários, porque as duas formas
// aparecem: "minha agenda" é uma lista de um.
function paraIds(valor) {
  const bruto = Array.isArray(valor) ? valor : [valor];
  return bruto.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
}

function inteiroOuNulo(valor, { min = 1, max = 24 * 60 } = {}) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Math.round(Number(valor));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function limpar(obj) {
  const inicio = obj.date ? new Date(obj.date) : null;

  return {
    // O INSTANTE em que começa. Quem escolhe é a tela, no fuso de quem marca.
    date: inicio && !Number.isNaN(inicio.getTime()) ? inicio : new Date(),
    minutes: inteiroOuNulo(obj.minutes) || DURACAO_PADRAO,

    // O que é o encontro: "Treino", "Consulta", "Reavaliação". Texto livre e
    // não lista fechada — cada profissional chama o próprio trabalho do jeito
    // dele, e uma lista nossa obrigaria todo mundo a caber nas nossas palavras.
    title: obj.title ? String(obj.title).trim().slice(0, 120) : "",

    // De qual SERVIÇO é o compromisso. É daqui que saem a duração sugerida e o
    // valor da cobrança automática.
    service: ObjectId.isValid(obj.service) ? new ObjectId(obj.service) : null,

    status: STATUS.includes(obj.status) ? obj.status : "scheduled",
    note: obj.note ? String(obj.note).trim().slice(0, 2000) : "",
  };
}

// Quando termina, derivado. Fica fora do documento pelo mesmo motivo do IMC na
// avaliação: é conta sobre dois campos que estão ali do lado, e um valor
// gravado pode discordar deles depois de uma edição.
function fim(doc) {
  return new Date(new Date(doc.date).getTime() + (doc.minutes || DURACAO_PADRAO) * 60000);
}

// Os compromissos de um PERÍODO, de um ou vários profissionais.
//
// Uma LISTA de profissionais, e não um só, porque a agenda da equipe é o caso
// de quem coordena: ver dois colegas lado a lado responde "quem tem horário na
// quinta", que é a pergunta real. Com um por consulta, a tela teria de somar as
// respostas e a ordenação por horário se perderia entre elas.
//
// O corte é por início: um compromisso que começa antes da janela e termina
// dentro dela entraria pela metade, e desenhar meia barra confunde mais que
// omitir. Na prática não acontece — a janela é a semana e nada dura sete dias.
Appointment_model.prototype.between = async function (trainerIds, from, to) {
  const col = await this.collection();

  const ids = paraIds(trainerIds);
  if (!ids.length) return [];

  return await col
    .find({
      trainer: { $in: ids },
      date: { $gte: new Date(from), $lt: new Date(to) },
    })
    .sort({ date: 1 })
    .toArray();
};

// Os compromissos de UMA pessoa, do mais recente para o mais antigo.
//
// Esta ordem, e não a cronológica: a aba mostra "próximos" e "anteriores", e os
// dois grupos crescem a partir de hoje para lados opostos.
Appointment_model.prototype.listOfStudent = async function (trainerIds, studentId) {
  const col = await this.collection();

  const ids = paraIds(trainerIds);
  if (!ids.length) return [];

  return await col
    .find({ trainer: { $in: ids }, student: new ObjectId(studentId) })
    .sort({ date: -1 })
    .toArray();
};

// `trainerIds` é o conjunto de profissionais que esta conta pode alcançar —
// ela mesma, ou a equipe inteira. É o mesmo filtro em ler, editar e apagar:
// sem ele, bastaria trocar o id na URL para mexer na agenda de um colega.
Appointment_model.prototype.data = async function (trainerIds, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const ids = paraIds(trainerIds);
  if (!ids.length) return undefined;

  const doc = await col.findOne({ _id: new ObjectId(id), trainer: { $in: ids } });
  return doc || undefined;
};

// Os compromissos que se sobrepõem a um horário.
//
// A agenda NÃO recusa a sobreposição: atendimento em dupla existe, e duas
// pessoas no mesmo horário é decisão de quem marca. O que ela faz é AVISAR
// antes de salvar — o erro comum é esquecer que o horário já estava ocupado,
// não querer dois de propósito.
//
// Dois intervalos se cruzam quando cada um começa antes de o outro terminar.
// Escrito assim, sem `$or`, é uma condição só e o índice de data serve.
Appointment_model.prototype.conflicts = async function (trainerId, inicio, minutos, ignorarId) {
  const col = await this.collection();


  const comeco = new Date(inicio);
  const termino = new Date(comeco.getTime() + (Number(minutos) || DURACAO_PADRAO) * 60000);

  const filtro = {
    trainer: new ObjectId(trainerId),
    // Cancelado não ocupa horário: foi desmarcado justamente para liberá-lo.
    status: { $ne: "canceled" },
    date: { $lt: termino },
  };

  if (ObjectId.isValid(ignorarId)) filtro._id = { $ne: new ObjectId(ignorarId) };

  const candidatos = await col.find(filtro).sort({ date: -1 }).limit(50).toArray();

  // O fim é derivado, então o corte final é aqui e não na consulta. O `limit`
  // acima é o que impede isto de percorrer a agenda inteira: só interessam os
  // que começam pouco antes do término.
  return candidatos.filter((doc) => fim(doc) > comeco);
};

// `trainer` é quem ATENDE; `createdBy` é quem registrou.
//
// Eram a mesma coisa enquanto cada um só marcava para si. Com a agenda da
// equipe deixam de ser: a recepção marca no horário do professor, e o
// compromisso é dele — mas o histórico precisa saber quem digitou.
Appointment_model.prototype.insert = async function (trainerId, studentId, obj, createdBy) {
  const col = await this.collection();

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    createdBy: new ObjectId(createdBy || trainerId),
    ...limpar(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Appointment_model.prototype.update = async function (trainerIds, id, obj, novoTrainer) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const ids = paraIds(trainerIds);
  if (!ids.length) return false;

  const mudanca = { ...limpar(obj), updatedAt: new Date() };
  // Trocar o compromisso de profissional é remarcar com outra pessoa, e só
  // acontece quando a rota permitiu — daí vir separado do corpo do pedido.
  if (ObjectId.isValid(novoTrainer)) mudanca.trainer = new ObjectId(novoTrainer);

  const r = await col.updateOne({ _id: new ObjectId(id), trainer: { $in: ids } }, { $set: mudanca });

  return r.matchedCount > 0;
};

// Só o status. Rota própria porque é o que mais se mexe — marcar presença é um
// clique no fim da aula, e obrigar a abrir o formulário inteiro para isso faria
// ninguém marcar.
Appointment_model.prototype.setStatus = async function (trainerIds, id, status) {
  if (!ObjectId.isValid(id) || !STATUS.includes(status)) return false;
  const col = await this.collection();

  const ids = paraIds(trainerIds);
  if (!ids.length) return false;

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: { $in: ids } },
    { $set: { status, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

Appointment_model.prototype.delete = async function (trainerIds, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const ids = paraIds(trainerIds);
  if (!ids.length) return false;

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: { $in: ids } });
  return r.deletedCount > 0;
};

// Apagados junto com a pessoa, como treinos, dietas e avaliações.
Appointment_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;
  const col = await this.collection();

  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount || 0;
};

module.exports = Appointment_model;
module.exports.STATUS = STATUS;
module.exports.DURACAO_PADRAO = DURACAO_PADRAO;
