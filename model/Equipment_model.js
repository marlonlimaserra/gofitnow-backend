const { ObjectId } = require("mongodb");
const cat = require("../lib/catalogosDeEstrutura.js");

// OS EQUIPAMENTOS DA CASA — a esteira, o leg press, o ar-condicionado.
//
// *"equipamentos que precisam de manutenção etc."*
//
// ── O QUE INTERESSA NUM EQUIPAMENTO É A HISTÓRIA ────────────────────────
//
// Não o cadastro. Saber que existe uma esteira não ajuda ninguém; saber que ELA
// quebrou três vezes este ano, sempre no mesmo motor, é o que decide entre
// consertar de novo e comprar outra.
//
// Por isso a manutenção é uma collection à parte, e não um campo "última
// manutenção" no equipamento: um campo guarda a última e esquece as outras
// duas — justamente as que contam a história.
function Equipment_model(app) {
  this.app = app;
}

Equipment_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("equipments");
};

Equipment_model.prototype.manutencoes = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("equipment_maintenances");
};

function texto(max) {
  return (v) => String(v || "").trim().slice(0, max);
}

function data(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function centavos(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000000) : 0;
}

const CAMPOS = {
  name: texto(120),
  categoria: (v) => (cat.ehEquipamento(v) ? String(v) : "outro"),
  marca: texto(60),
  modelo: texto(60),
  // O número de série é o que identifica a peça na assistência técnica, e é o
  // que separa a esteira 1 da esteira 2 quando as duas são o mesmo modelo.
  serie: texto(60),
  // Onde ela está. Texto livre porque "sala de cardio", "mezanino" e "ao lado
  // do bebedouro" são todos respostas certas, e uma lista fechada obrigaria
  // alguém a cadastrar "mezanino" antes de cadastrar a esteira.
  local: texto(80),
  unit: (v) => (ObjectId.isValid(v) ? new ObjectId(String(v)) : null),
  compradoEm: data,
  valor: centavos,
  garantiaAte: data,
  estado: (v) => (cat.ehEstado(v) ? String(v) : "ok"),
  note: texto(2000),
  // Só o ID da foto, nunca a URL: guardar o endereço prenderia o equipamento ao
  // domínio do backend do dia em que a foto subiu. `""` é uma EDIÇÃO — tirar a
  // foto é uma escolha, e precisa ser gravável.
  photo: (v) => {
    const id = String(v || "").split("/").pop();
    return ObjectId.isValid(id) ? new ObjectId(id) : null;
  },
};

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);
  return saida;
}

function limparParcial(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

function normalizar(t) {
  return String(t || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ── A LISTA, com o que PEDE ATENÇÃO na frente ─────────────────────────────
//
// `precisaDeAtencao` é calculado: está em manutenção, ou a próxima preventiva
// já venceu. É o único número que a tela precisa mostrar em vermelho, e é a
// razão de a lista existir.
Equipment_model.prototype.listar = async function ({ busca, categoria, estado, unit, semUnidade } = {}) {
  const col = await this.collection();
  const filtro = {};

  const termo = normalizar(busca);
  if (termo) {
    const esc = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filtro.$or = [
      { nameSort: { $regex: esc } },
      { serie: { $regex: esc, $options: "i" } },
      { local: { $regex: esc, $options: "i" } },
    ];
  }

  if (categoria) filtro.categoria = String(categoria);
  if (estado) filtro.estado = String(estado);
  if (semUnidade) filtro.unit = null;
  else if (unit && ObjectId.isValid(unit)) filtro.unit = new ObjectId(unit);

  const hoje = new Date();

  const linhas = await col
    .aggregate([
      { $match: filtro },
      // A PRÓXIMA manutenção prevista vem da última que foi lançada com data
      // futura. Guardá-la no equipamento faria dois lugares dizerem quando é.
      {
        $lookup: {
          from: "equipment_maintenances",
          let: { eq: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$equipment", "$$eq"] } } },
            { $sort: { data: -1 } },
            { $limit: 1 },
            { $project: { data: 1, proximaEm: 1, tipo: 1 } },
          ],
          as: "ultima",
        },
      },
      // ── O QUE JÁ CUSTOU EM CONSERTO, na própria linha ──────────────────
      //
      // *"seria um histórico dentro do equipamento, com as manutenções e o
      // valor, para depois a gente poder gerar esses relatórios de gasto"*.
      //
      // O total acumulado fica na LINHA, e não só dentro da ficha, porque a
      // pergunta que ele responde é comparativa: qual aparelho está consumindo
      // dinheiro. Ela não se responde abrindo trinta fichas uma a uma.
      {
        $lookup: {
          from: "equipment_maintenances",
          let: { eq: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$equipment", "$$eq"] } } },
            { $group: { _id: null, total: { $sum: "$custo" }, quantas: { $sum: 1 } } },
          ],
          as: "conta",
        },
      },
      {
        $addFields: {
          ultimaManutencao: { $arrayElemAt: ["$ultima.data", 0] },
          proximaEm: { $arrayElemAt: ["$ultima.proximaEm", 0] },
          gastoEmManutencao: { $ifNull: [{ $arrayElemAt: ["$conta.total", 0] }, 0] },
          quantasManutencoes: { $ifNull: [{ $arrayElemAt: ["$conta.quantas", 0] }, 0] },
        },
      },
      {
        $addFields: {
          precisaDeAtencao: {
            $or: [
              { $eq: ["$estado", "manutencao"] },
              {
                $and: [
                  { $ne: ["$proximaEm", null] },
                  { $lte: [{ $ifNull: ["$proximaEm", new Date(8640000000000000)] }, hoje] },
                  // Um equipamento baixado não pede manutenção: ele saiu.
                  { $ne: ["$estado", "baixado"] },
                ],
              },
            ],
          },
        },
      },
      // Quem pede atenção primeiro. Depois, alfabético — a lista é lida
      // inteira, e a ordem do resto só precisa ser previsível.
      { $sort: { precisaDeAtencao: -1, nameSort: 1 } },
      { $project: { ultima: 0, conta: 0 } },
    ])
    .toArray();

  return linhas.map(paraTela);
};

function paraTela(e) {
  return {
    id: String(e._id),
    name: e.name,
    categoria: e.categoria,
    marca: e.marca || "",
    modelo: e.modelo || "",
    serie: e.serie || "",
    local: e.local || "",
    unit: e.unit ? String(e.unit) : null,
    compradoEm: e.compradoEm || null,
    valor: e.valor || 0,
    garantiaAte: e.garantiaAte || null,
    estado: e.estado || "ok",
    note: e.note || "",
    photo: e.photo ? String(e.photo) : null,
    ultimaManutencao: e.ultimaManutencao || null,
    proximaEm: e.proximaEm || null,
    precisaDeAtencao: !!e.precisaDeAtencao,
    // Vem do $lookup da lista; numa ficha aberta sozinha ele não existe, e 0
    // seria uma mentira barata — `null` diz "não perguntei".
    gastoEmManutencao: e.gastoEmManutencao === undefined ? null : e.gastoEmManutencao,
    quantasManutencoes: e.quantasManutencoes === undefined ? null : e.quantasManutencoes,
  };
}

Equipment_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc ? paraTela(doc) : undefined;
};

Equipment_model.prototype.contagem = async function () {
  const col = await this.collection();
  return col.countDocuments({});
};

Equipment_model.prototype.insert = async function (obj) {
  const doc = limpar(obj);
  if (!doc.name) return null;

  const col = await this.collection();
  const r = await col.insertOne({
    ...doc,
    nameSort: normalizar(doc.name),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await this.recolherFotos(r.insertedId, doc.photo);
  return r.insertedId;
};

Equipment_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const set = limparParcial(obj);
  if (set.name !== undefined) {
    if (!set.name) return false;
    set.nameSort = normalizar(set.name);
  }

  const col = await this.collection();
  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: { ...set, updatedAt: new Date() } });
  if (!r.matchedCount) return false;

  const depois = await col.findOne({ _id: new ObjectId(id) }, { projection: { photo: 1 } });
  await this.recolherFotos(id, depois?.photo);
  return true;
};

// ── A FAXINA DAS FOTOS ────────────────────────────────────────────────────
//
// Subir a foto e salvar o equipamento são dois pedidos, e entre um e outro a
// pessoa pode fechar a janela — ou trocar a foto três vezes antes de salvar. O
// que sobra são bytes órfãos no balde, que ninguém vai procurar.
//
// A faxina roda depois de toda gravação e apaga tudo o que não é a foto SALVA.
// O dono da verdade é o equipamento gravado, sempre.
//
// Nunca estoura: é faxina, e faxina que falha não pode impedir ninguém de
// salvar. A próxima gravação tenta de novo.
Equipment_model.prototype.recolherFotos = async function (id, photo) {
  try {
    await this.app.api.equipmentImage.pruneUnused(id, photo ? [String(photo)] : []);
  } catch (erro) {
    console.error("[equipamento] faxina das fotos:", erro.message);
  }
};

// Apagar leva a história junto — e por isso o caminho normal é BAIXAR, que
// tira o aparelho da operação e mantém o que ele custou em conserto.
Equipment_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  if (!r.deletedCount) return false;

  const man = await this.manutencoes();
  await man.deleteMany({ equipment: new ObjectId(id) });

  // A foto vai junto: ela mora no R2, e um documento apagado sem ela deixa
  // bytes pagos no balde que nenhuma tela alcança de novo.
  await this.app.api.equipmentImage.removeAllOf(id);
  return true;
};

// ── AS MANUTENÇÕES ────────────────────────────────────────────────────────

Equipment_model.prototype.listarManutencoes = async function (id) {
  if (!ObjectId.isValid(id)) return [];

  const man = await this.manutencoes();
  const docs = await man.find({ equipment: new ObjectId(id) }).sort({ data: -1 }).toArray();

  return docs.map((m) => ({
    id: String(m._id),
    tipo: m.tipo,
    data: m.data,
    descricao: m.descricao || "",
    custo: m.custo || 0,
    fornecedor: m.fornecedor || "",
    proximaEm: m.proximaEm || null,
    createdByName: m.createdByName || "",
  }));
};

Equipment_model.prototype.lancarManutencao = async function (id, obj, quem) {
  if (!ObjectId.isValid(id)) return null;

  const man = await this.manutencoes();
  const doc = {
    equipment: new ObjectId(id),
    tipo: cat.ehManutencao(obj.tipo) ? String(obj.tipo) : "corretiva",
    data: data(obj.data) || new Date(),
    descricao: texto(1000)(obj.descricao),
    custo: centavos(obj.custo),
    fornecedor: texto(120)(obj.fornecedor),
    // A PRÓXIMA é opcional, e é ela que faz a preventiva existir: sem uma data
    // futura, "revisar a cada seis meses" é uma intenção que ninguém lembra.
    proximaEm: data(obj.proximaEm),
    createdBy: quem?._id ? new ObjectId(String(quem._id)) : null,
    createdByName: String(quem?.name || "").slice(0, 120),
    createdAt: new Date(),
  };

  const r = await man.insertOne(doc);

  // ── LANÇAR CONSERTO VOLTA O APARELHO PARA USO ───────────────────────
  //
  // Quem registra a manutenção acabou de consertar. Deixar o estado em
  // "manutenção" obrigaria um segundo gesto que ninguém faz — e a lista
  // continuaria em vermelho com o aparelho já funcionando.
  //
  // Só quando estava EM MANUTENÇÃO: um aparelho baixado que recebe uma
  // manutenção histórica não volta à operação por causa disso.
  const col = await this.collection();
  await col.updateOne(
    { _id: new ObjectId(id), estado: "manutencao" },
    { $set: { estado: "ok", updatedAt: new Date() } }
  );

  return r.insertedId;
};

Equipment_model.prototype.removerManutencao = async function (id, manutencaoId) {
  if (!ObjectId.isValid(id) || !ObjectId.isValid(manutencaoId)) return false;

  const man = await this.manutencoes();
  const r = await man.deleteOne({ _id: new ObjectId(manutencaoId), equipment: new ObjectId(id) });
  return r.deletedCount > 0;
};

// ── O QUE JÁ FOI DIGITADO ANTES ──────────────────────────────────────────
//
// *"coloque auto completar em marca, modelo e onde está"*.
//
// As sugestões saem do PRÓPRIO cadastro, e não de uma lista que alguém mantém:
// quem escreveu "Movement" uma vez não deveria ter que escrever de novo, nem
// ter que cadastrar "Movement" num lugar antes de cadastrar a esteira.
//
// É também o que mantém a lista limpa: sem isso, a mesma marca vira "Movement",
// "movement" e "Moviment", e o filtro por marca deixa de funcionar — a razão de
// o campo existir.
//
// Os modelos vêm EMPARELHADOS com a marca, para a tela sugerir os modelos
// daquela marca em vez de todos os modelos da casa.
Equipment_model.prototype.sugestoes = async function () {
  const col = await this.collection();

  const [r] = await col
    .aggregate([
      {
        $facet: {
          marcas: [
            { $match: { marca: { $nin: ["", null] } } },
            { $group: { _id: "$marca" } },
            { $sort: { _id: 1 } },
            { $limit: 200 },
          ],
          modelos: [
            { $match: { modelo: { $nin: ["", null] } } },
            { $group: { _id: { marca: { $ifNull: ["$marca", ""] }, modelo: "$modelo" } } },
            { $sort: { "_id.modelo": 1 } },
            { $limit: 400 },
          ],
          locais: [
            { $match: { local: { $nin: ["", null] } } },
            { $group: { _id: "$local" } },
            { $sort: { _id: 1 } },
            { $limit: 200 },
          ],
          // A OBSERVAÇÃO também repete: "fora de garantia", "comprado usado",
          // "barulho no rolamento desde a entrega". O teto é menor porque texto
          // longo não vira lista de escolha — passando de umas dezenas, quem
          // digita acha mais rápido do que quem procura.
          notas: [
            { $match: { note: { $nin: ["", null] } } },
            { $group: { _id: "$note" } },
            { $sort: { _id: 1 } },
            { $limit: 100 },
          ],
        },
      },
    ])
    .toArray();

  return {
    marcas: (r?.marcas || []).map((x) => x._id),
    modelos: (r?.modelos || []).map((x) => ({ marca: x._id.marca || "", modelo: x._id.modelo })),
    locais: (r?.locais || []).map((x) => x._id),
    notas: (r?.notas || []).map((x) => x._id),
  };
};

// ── TUDO O QUE ACONTECEU NA JANELA ────────────────────────────────────────
//
// *"senti falta de filtro de data, para saber tudo que ocorreu em certo
// período"*.
//
// O relatório responde QUANTO; esta lista responde O QUÊ. São perguntas
// diferentes e a segunda não sai da primeira: um total de R$ 1.840 não diz que
// a esteira quebrou três vezes em maio.
//
// Vem com o NOME do aparelho embutido, porque uma linha de histórico sem dizer
// de quem ela é não é histórico — e buscar trinta fichas na tela para descobrir
// seria trinta idas ao servidor.

// Os IDS dos aparelhos de uma unidade.
//
// *"estrutura também não respeita unidades"*: a lista de aparelhos já
// filtrava, mas o GASTO e o HISTÓRICO de manutenção da mesma tela não — a
// lente em Paraty mostrava zero aparelhos e o gasto da casa inteira embaixo.
//
// A manutenção aponta para o APARELHO, e é ele que tem unidade. Traduzir para
// ids resolve os dois relatórios sem mexer nos dois pipelines: são dezenas de
// aparelhos numa academia, não milhares, então o `$in` é barato aqui.
//
// Devolve `null` quando não há lente — e `null` é diferente de lista vazia:
// vazia quer dizer "esta unidade não tem aparelho nenhum", e aí o relatório
// tem de dar zero mesmo.
Equipment_model.prototype.idsDaUnidade = async function (unit) {
  if (!ObjectId.isValid(String(unit || ""))) return null;

  const col = await this.collection();
  const docs = await col
    .find({ unit: new ObjectId(String(unit)) }, { projection: { _id: 1 } })
    .toArray();

  return docs.map((d) => d._id);
};

Equipment_model.prototype.manutencoesNoPeriodo = async function ({ de, ate, limite, unit } = {}) {
  const man = await this.manutencoes();
  const filtro = {};
  if (de || ate) {
    filtro.data = {};
    if (de) filtro.data.$gte = new Date(de);
    if (ate) filtro.data.$lte = new Date(ate);
  }

  // A lente: a manutenção é DE UM APARELHO, e quem tem unidade é o aparelho.
  const daUnidade = await this.idsDaUnidade(unit);
  if (daUnidade) filtro.equipment = { $in: daUnidade };

  const docs = await man
    .aggregate([
      { $match: filtro },
      { $sort: { data: -1 } },
      { $limit: Math.min(Math.max(Number(limite) || 200, 1), 500) },
      { $lookup: { from: "equipments", localField: "equipment", foreignField: "_id", as: "eq" } },
    ])
    .toArray();

  return docs.map((m) => ({
    id: String(m._id),
    equipment: String(m.equipment),
    // O aparelho pode ter sido apagado depois; a manutenção some junto, mas
    // entre uma leitura e outra o `$lookup` pode voltar vazio.
    equipmentName: m.eq?.[0]?.name || "",
    // A UNIDADE do aparelho. *"quando eu pôr todas as unidades, sempre exiba
    // em qual unidade pertence"* — e quem resolve o nome é a tela, que já tem
    // a lista de unidades pela lente.
    unit: m.eq?.[0]?.unit || null,
    tipo: m.tipo,
    data: m.data,
    descricao: m.descricao || "",
    custo: m.custo || 0,
    fornecedor: m.fornecedor || "",
    createdByName: m.createdByName || "",
  }));
};

// ── O RELATÓRIO DE GASTO ──────────────────────────────────────────────────
//
// *"para depois a gente poder gerar esses relatórios de gasto"*.
//
// Três cortes do mesmo dinheiro, porque são três perguntas diferentes e todas
// são feitas na mesma conversa:
//
//   total        quanto a manutenção custou no período
//   porMes       está piorando ou melhorando
//   porEquipamento  qual aparelho está drenando o caixa
//   porTipo      quanto foi prevenção e quanto foi conserto — a resposta a
//                "vale a pena fazer preventiva?" é a razão entre os dois
//
// O mês sai já formatado como `AAAA-MM` pelo próprio banco: montar isso em JS
// exigiria decidir fuso na mão, e `$dateToString` usa o mesmo do resto.
Equipment_model.prototype.custoNoPeriodo = async function ({ de, ate, unit } = {}) {
  const man = await this.manutencoes();
  const filtro = {};
  if (de || ate) {
    filtro.data = {};
    if (de) filtro.data.$gte = new Date(de);
    if (ate) filtro.data.$lte = new Date(ate);
  }

  // A lente: a manutenção é DE UM APARELHO, e quem tem unidade é o aparelho.
  const daUnidade = await this.idsDaUnidade(unit);
  if (daUnidade) filtro.equipment = { $in: daUnidade };

  const [linhas] = await man
    .aggregate([
      { $match: filtro },
      {
        $facet: {
          geral: [{ $group: { _id: null, total: { $sum: "$custo" }, quantas: { $sum: 1 } } }],
          porMes: [
            { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$data" } }, total: { $sum: "$custo" }, quantas: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          porTipo: [
            { $group: { _id: "$tipo", total: { $sum: "$custo" }, quantas: { $sum: 1 } } },
            { $sort: { total: -1 } },
          ],
          porEquipamento: [
            { $group: { _id: "$equipment", total: { $sum: "$custo" }, quantas: { $sum: 1 } } },
            // Sem custo nenhum a linha não é notícia: ela entraria no relatório
            // só para empurrar para baixo quem de fato gastou.
            { $match: { total: { $gt: 0 } } },
            { $sort: { total: -1 } },
            { $limit: 20 },
            { $lookup: { from: "equipments", localField: "_id", foreignField: "_id", as: "eq" } },
            {
              $project: {
                total: 1,
                quantas: 1,
                name: { $ifNull: [{ $arrayElemAt: ["$eq.name", 0] }, ""] },
                categoria: { $ifNull: [{ $arrayElemAt: ["$eq.categoria", 0] }, "outro"] },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const geral = linhas?.geral?.[0];

  return {
    total: geral?.total || 0,
    quantas: geral?.quantas || 0,
    porMes: (linhas?.porMes || []).map((m) => ({ mes: m._id, total: m.total || 0, quantas: m.quantas })),
    porTipo: (linhas?.porTipo || []).map((m) => ({ tipo: m._id || "corretiva", total: m.total || 0, quantas: m.quantas })),
    porEquipamento: (linhas?.porEquipamento || []).map((m) => ({
      id: String(m._id),
      name: m.name,
      categoria: m.categoria,
      total: m.total || 0,
      quantas: m.quantas,
    })),
  };
};

module.exports = Equipment_model;
module.exports.paraTela = paraTela;
