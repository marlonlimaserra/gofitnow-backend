const { ObjectId } = require("mongodb");
const instanceContext = require("../lib/instance.js");

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

// ── ENTRAR NA AULA DE HOJE ────────────────────────────────────────────────
//
// `inicio` é o HORÁRIO da aula, em minutos: a mesma aula acontece às 07:00 e
// às 18:00, e sem ele as duas presenças seriam a mesma linha.
//
// ── DOIS ÍNDICES ÚNICOS, e cada um responde uma pergunta ────────────────
//
// O primeiro, `{class, dia, person, inicio}`, impede a mesma pessoa de entrar
// DUAS VEZES NO MESMO HORÁRIO. Vale sempre, e é o que faz dois toques no
// celular com a rede ruim não virarem duas presenças.
//
// O segundo é PARCIAL: `{class, dia, person}` único, só nas linhas que têm
// `unico: true`. Ele é a regra que o Marlon pediu — *"se por não, o usuário só
// pode se inscrever uma vez por dia"* — e a marca é escrita só quando a aula
// diz que é assim.
//
// Por que um índice parcial e não um `findOne` antes de inserir: a consulta
// perde a corrida entre dois pedidos simultâneos, e dois pedidos simultâneos é
// exatamente o que acontece quando alguém toca duas vezes num celular lento. O
// índice não perde.
GroupClassCheckin_model.prototype.entrar = async function (aula, dia, pessoa, opcoes = {}) {
  if (!ObjectId.isValid(aula) || !ObjectId.isValid(pessoa)) return { ok: false, erro: "invalido" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia))) return { ok: false, erro: "dia" };

  const inicio = Number(opcoes.inicio);
  if (!Number.isInteger(inicio) || inicio < 0) return { ok: false, erro: "horario" };

  const col = await this.collection();

  const doc = {
    class: new ObjectId(aula),
    dia: String(dia),
    person: new ObjectId(pessoa),
    inicio,
    // ── TRÊS ESTADOS, e não dois ──────────────────────────────────────────
    //
    // *"ver aulas que ele fez check-in E se ele foi marcado como presente ou
    // não"*.
    //
    // `inscrito` é "disse que vem". `presente` é "veio, e alguém confirmou".
    // `faltou` é "não veio" — e ele NÃO é a ausência de `presente`: enquanto a
    // aula não acontece, ninguém faltou ainda.
    //
    // Dois estados (presente sim/não) fariam toda inscrição do futuro contar
    // como falta, e o histórico da pessoa nasceria cheio de faltas que ela
    // ainda não teve.
    presenca: "inscrito",
    createdAt: new Date(),
  };

  // A MARCA que liga o índice parcial. Só existe quando a aula é de um por
  // dia — e é ela, e não um `if` no meio do caminho, que segura a regra.
  if (!opcoes.variosHorarios) doc.unico = true;

  try {
    await col.insertOne(doc);
    return { ok: true, novo: true };
  } catch (erro) {
    if (erro?.code !== 11000) throw erro;

    // 11000 pode ser dois casos, e a resposta é diferente em cada um.
    //
    // Mesmo horário: já estava dentro. Não é falha — é a resposta certa para o
    // segundo clique.
    const mesmo = await col.findOne({ ...doc, createdAt: undefined, unico: undefined, inicio });
    if (mesmo) return { ok: true, novo: false };

    // Outro horário, numa aula de um por dia: aí é recusa, e a tela precisa
    // saber o porquê para dizer "você já entrou na aula das 07:00".
    return { ok: false, erro: "ja_entrou_hoje" };
  }
};

GroupClassCheckin_model.prototype.sair = async function (aula, dia, pessoa, inicio) {
  if (!ObjectId.isValid(aula) || !ObjectId.isValid(pessoa)) return false;

  const col = await this.collection();
  const filtro = {
    class: new ObjectId(aula),
    dia: String(dia),
    person: new ObjectId(pessoa),
  };

  // Com horário, sai daquele; sem, sai do dia inteiro daquela aula. Os dois
  // usos existem: o botão da tela sabe de qual horário está falando, e
  // "cancelar minha presença de hoje" não precisa saber.
  if (Number.isInteger(Number(inicio))) filtro.inicio = Number(inicio);

  const r = await col.deleteMany(filtro);
  return r.deletedCount > 0;
};

// Quantos entraram em cada aula naquele dia. Um `$group` e não uma contagem
// por aula: a tela mostra a grade inteira, e uma consulta por linha seria uma
// dúzia de idas ao banco para desenhar uma tela.
// Apaga UMA linha, pelo id dela. É o que a recepção desfaz quando inscreveu a
// pessoa errada: `sair` apaga pelo par (aula, dia, pessoa), e aqui quem se tem
// na mão é a linha que está na tela.
GroupClassCheckin_model.prototype.remover = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

GroupClassCheckin_model.prototype.contagemDoDia = async function (dia) {
  const col = await this.collection();

  const linhas = await col
    .aggregate([
      { $match: { dia: String(dia) } },
      { $group: { _id: { class: "$class", inicio: "$inicio" }, n: { $sum: 1 } } },
    ])
    .toArray();

  // A chave é `aula:minutos` porque a vaga é DO HORÁRIO: a de 07:00 lotar não
  // fecha a de 18:00, e uma contagem por aula diria que sim.
  return Object.fromEntries(linhas.map((l) => [`${l._id.class}:${l._id.inicio}`, l.n]));
};

GroupClassCheckin_model.prototype.daAula = async function (aula, dia) {
  if (!ObjectId.isValid(aula)) return [];

  const col = await this.collection();
  return col.find({ class: new ObjectId(aula), dia: String(dia) }).toArray();
};

const PRESENCAS = ["inscrito", "presente", "faltou"];

// ── MARCAR PRESENÇA ───────────────────────────────────────────────────────
//
// *"poder dar PRESENÇA"*.
//
// Por ID da linha, e não por (aula, dia, pessoa): a tela tem a linha na mão —
// ela acabou de listar os inscritos —, e três campos numa chamada são três
// chances de a tela mandar a combinação errada.
//
// Volta para `inscrito` é um caminho de verdade: quem marcou presença na
// pessoa errada precisa desfazer, e apagar a linha seria apagar a inscrição
// junto.
GroupClassCheckin_model.prototype.marcarPresenca = async function (id, presenca) {
  if (!ObjectId.isValid(id)) return false;
  if (!PRESENCAS.includes(String(presenca))) return false;

  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { presenca: String(presenca), presencaEm: new Date() } }
  );

  return r.matchedCount > 0;
};

// Os inscritos de um horário, com o nome de quem é.
//
// A junção é feita aqui e não na rota porque é uma pergunta só: "quem está
// nesta aula?" sem o nome não responde nada, e duas idas ao banco para montar
// uma lista de dez linhas é uma a mais.
GroupClassCheckin_model.prototype.inscritos = async function (aula, dia, inicio) {
  if (!ObjectId.isValid(aula)) return [];

  const col = await this.collection();
  const filtro = { class: new ObjectId(aula), dia: String(dia) };
  if (Number.isInteger(Number(inicio))) filtro.inicio = Number(inicio);

  return col
    .aggregate([
      { $match: filtro },
      {
        $lookup: {
          from: "users",
          let: { pessoa: "$person" },
          pipeline: [
            {
              // `instance` à mão: o escopo do cliente não entra em
              // sub-pipeline de `$lookup`. Aqui é desempenho — `person` é
              // ObjectId, único global —, e sem ele a junção varreria os
              // usuários de todos os clientes.
              $match: {
                instance: instanceContext.required(),
                $expr: { $eq: ["$_id", "$$pessoa"] },
              },
            },
            // O documento da pessoa NÃO sai inteiro: ela tem senha e sal.
            { $project: { name: 1, avatarAt: 1 } },
          ],
          as: "pessoa",
        },
      },
      {
        $addFields: {
          name: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
          avatarAt: { $ifNull: [{ $arrayElemAt: ["$pessoa.avatarAt", 0] }, null] },
        },
      },
      { $project: { pessoa: 0 } },
      // Em ordem de chegada: quem confirmou primeiro aparece primeiro, e é
      // isso que uma lista de presença é.
      { $sort: { createdAt: 1 } },
    ])
    .toArray();
};

// ── O HISTÓRICO DE UMA PESSOA ─────────────────────────────────────────────
//
// *"aqui no aluno preciso da parte do check-in, para ver aulas que ele fez
// check-in e se ele foi marcado como presente ou não"*.
//
// Do mais recente para o mais antigo, porque a pergunta é "como ele tem
// vindo?" — e a resposta está nas últimas semanas, não nas primeiras.
GroupClassCheckin_model.prototype.daPessoa = async function (pessoa, { limite = 60 } = {}) {
  if (!ObjectId.isValid(pessoa)) return [];

  const col = await this.collection();
  return col
    .find({ person: new ObjectId(pessoa) })
    .sort({ dia: -1, inicio: -1 })
    .limit(Math.min(Math.max(Number(limite) || 60, 1), 365))
    .toArray();
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
