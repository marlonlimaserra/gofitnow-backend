const { ObjectId } = require("mongodb");
const cat = require("../lib/catalogosDeEstrutura.js");

// O ESTOQUE — desinfetante, papel higiênico, barrinha de revenda.
//
// *"tem gasto com produtos de limpeza; como a gente poderia controlar isso — o
// que saiu, o que entrou"*.
//
// ── O ESTOQUE É UM LIVRO-CAIXA, e essa é a decisão que rege o arquivo ───
//
// Cada movimento é uma linha que NUNCA se edita nem se apaga. Errou a
// quantidade? Lança um ajuste dizendo por quê. É como todo sistema de estoque
// sério funciona, e a razão é simples: um livro que se corrige para trás deixa
// de ser prova de alguma coisa — e a primeira pergunta que alguém faz quando
// falta material é "mas o sistema não dizia que tinha cinco?".
//
// ── O SALDO É GUARDADO, e não somado toda vez ───────────────────────────
//
// Ele vive no insumo e anda com `$inc` a cada movimento, na mesma operação.
// Somar o livro inteiro a cada leitura seria correto e ficaria lento no ano em
// que houver dez mil linhas — e a lista de estoque é aberta todo dia.
//
// O risco de um saldo guardado é ele divergir do livro. Aqui ele não pode: só
// existe UM caminho de escrita (`movimentar`), e ele grava os dois juntos.
function Supply_model(app) {
  this.app = app;
}

Supply_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("supplies");
};

Supply_model.prototype.movimentos = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("supply_moves");
};

function texto(max) {
  return (v) => String(v || "").trim().slice(0, max);
}

// A quantidade aceita fração: meio litro de desinfetante é meio litro. Três
// casas porque abaixo disso ninguém conta, e acima vira ruído de arredondamento.
function quantidade(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function centavos(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000000) : 0;
}

const CAMPOS = {
  name: texto(120),
  categoria: (v) => (cat.ehInsumo(v) ? String(v) : "outro"),
  medida: (v) => (cat.ehMedida(v) ? String(v) : "un"),
  // ── O MÍNIMO É O QUE FAZ O MÓDULO VALER ───────────────────────────────
  //
  // Sem ele, o estoque é um número que ninguém olha. Com ele, a lista tem uma
  // linha vermelha dizendo "o desinfetante está acabando" — que é o único
  // momento em que alguém abre esta tela por vontade própria.
  minimo: (v) => Math.max(0, quantidade(v)),
  note: texto(500),
  active: (v) => v !== false,
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

// ── O ESTOQUE DE UMA UNIDADE ──────────────────────────────────────────────
//
// *"a parte de estoque não respeita a unidade"*.
//
// Eu tinha deixado o catálogo de fora da lente de propósito, e escrevi o
// porquê: o INSUMO é da casa e não tem unidade. Isso continua verdade — o que
// eu errei foi a conclusão. Quem tem unidade é o MOVIMENTO, e a quantidade
// dele é gravada com sinal justamente para que somar a coluna dê o saldo. Ou
// seja: o saldo de Niterói é calculável, e a pergunta "quanto de desinfetante
// tem em Niterói" tem resposta.
//
// O que NÃO dá para fazer é filtrar o catálogo e mostrar o saldo da casa
// ao lado: seria um número de duas unidades com o nome de uma. Por isso aqui
// o saldo é RECALCULADO, e não filtrado.
//
// Só entram os insumos que TIVERAM movimento na unidade. Um item nunca usado
// em Niterói não é "zero em Niterói", é um item que não é de lá — e listar o
// catálogo inteiro zerado faria toda unidade parecer vazia.
Supply_model.prototype.saldosDaUnidade = async function (unit) {
  if (!ObjectId.isValid(String(unit || ""))) return null;

  const mov = await this.movimentos();
  const linhas = await mov
    .aggregate([
      { $match: { unit: new ObjectId(String(unit)) } },
      {
        $group: {
          _id: "$supply",
          saldo: { $sum: "$quantidade" },
          ultimoEm: { $max: "$em" },
        },
      },
    ])
    .toArray();

  return new Map(linhas.map((l) => [String(l._id), l]));
};

// ── ONDE ESTÁ ESTE INSUMO ─────────────────────────────────────────────────
//
// *"ok, e para editar de qual unidade faz parte?"* — olhando o formulário do
// insumo.
//
// A resposta é que NÃO SE EDITA, e isso é desenho e não esquecimento: o
// insumo é o item do catálogo (nome, categoria, medida, mínimo) e vale para a
// casa inteira. Quem tem unidade é o MOVIMENTO — é ele que diz de onde saiu o
// galão.
//
// Se o insumo tivesse unidade, "Desinfetante" precisaria existir duas vezes,
// uma por unidade, com nome, categoria e mínimo mantidos em dobro — e mudar a
// medida em uma e esquecer a outra seria questão de tempo.
//
// O que faltava não era o campo: era a RESPOSTA. Esta função a dá — quanto
// deste insumo há em cada unidade, somando os movimentos de cada uma.
Supply_model.prototype.saldosPorUnidade = async function (id) {
  if (!ObjectId.isValid(String(id || ""))) return [];

  const mov = await this.movimentos();

  return mov
    .aggregate([
      { $match: { supply: new ObjectId(String(id)) } },
      { $group: { _id: "$unit", saldo: { $sum: "$quantidade" }, ultimoEm: { $max: "$em" } } },
      { $sort: { saldo: -1 } },
    ])
    .toArray()
    .then((linhas) =>
      linhas.map((l) => ({
        // `null` é legítimo e aparece: é o que entrou "para a casa toda", e
        // é onde está todo o histórico anterior a esta tela existir.
        unit: l._id ? String(l._id) : null,
        saldo: l.saldo || 0,
        ultimoEm: l.ultimoEm || null,
      }))
    );
};

Supply_model.prototype.listar = async function ({ busca, categoria, soFaltando, unit } = {}) {
  const col = await this.collection();
  const filtro = {};

  const termo = normalizar(busca);
  if (termo) {
    const esc = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filtro.nameSort = { $regex: esc };
  }
  if (categoria) filtro.categoria = String(categoria);

  // A LENTE: só os insumos que tiveram movimento naquela unidade.
  const porUnidade = await this.saldosDaUnidade(unit);
  if (porUnidade) filtro._id = { $in: [...porUnidade.keys()].map((id) => new ObjectId(id)) };

  const linhas = await col.aggregate([{ $match: filtro }]).toArray();

  // ── SALDO E "FALTANDO" SAEM DO MESMO LUGAR ─────────────────────────────
  //
  // Isto morava no pipeline e passou para cá quando a lente entrou. O motivo
  // não é preferência: com a lente, o saldo é a SOMA DOS MOVIMENTOS daquela
  // unidade, e o `$lte` do pipeline continuaria comparando o saldo da casa
  // com o mínimo. Seriam duas regras de "abaixo do mínimo" — a da tela e a do
  // alerta — e elas divergiriam no primeiro ajuste.
  //
  // A lista é de dezenas de itens (o catálogo de uma academia), então
  // calcular aqui não custa nada e cabe numa leitura só.
  const calculadas = linhas.map((s) => {
    const daUnidade = porUnidade?.get(String(s._id));

    const saldo = porUnidade ? daUnidade?.saldo || 0 : s.saldo || 0;
    const ultimoEm = porUnidade ? daUnidade?.ultimoEm || null : s.ultimoEm || null;

    // `faltando` é saldo no ou abaixo do mínimo, com mínimo definido. Sem
    // mínimo não existe "faltando": zero de uma coisa que ninguém repõe não é
    // um alerta, é o estado normal.
    const faltando = (s.minimo || 0) > 0 && saldo <= s.minimo;

    return { ...s, saldo, ultimoEm, faltando };
  });

  const visiveis = soFaltando ? calculadas.filter((s) => s.faltando) : calculadas;

  // O que está faltando primeiro: é por isso que alguém abriu a tela.
  visiveis.sort(
    (a, b) =>
      Number(b.faltando) - Number(a.faltando) ||
      String(a.nameSort || "").localeCompare(String(b.nameSort || ""))
  );

  return visiveis.map(paraTela);
};

function paraTela(s) {
  return {
    id: String(s._id),
    name: s.name,
    categoria: s.categoria,
    medida: s.medida,
    saldo: s.saldo || 0,
    minimo: s.minimo || 0,
    note: s.note || "",
    active: s.active !== false,
    faltando: !!s.faltando,
    ultimoEm: s.ultimoEm || null,
  };
}

Supply_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc ? paraTela(doc) : undefined;
};

Supply_model.prototype.contagem = async function () {
  const col = await this.collection();
  return col.countDocuments({});
};

Supply_model.prototype.insert = async function (obj) {
  const doc = limpar(obj);
  if (!doc.name) return null;

  const col = await this.collection();
  const r = await col.insertOne({
    ...doc,
    // O saldo nasce em zero e só anda por movimento. Aceitar um saldo inicial
    // no cadastro criaria uma quantidade sem linha no livro que a explique.
    saldo: 0,
    nameSort: normalizar(doc.name),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Supply_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const set = limparParcial(obj);
  if (set.name !== undefined) {
    if (!set.name) return false;
    set.nameSort = normalizar(set.name);
  }

  // O saldo NUNCA entra por aqui: ele é consequência do livro, e deixá-lo
  // editável abriria o caminho que `movimentar` existe para fechar.
  delete set.saldo;

  const col = await this.collection();
  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: { ...set, updatedAt: new Date() } });
  return r.matchedCount > 0;
};

Supply_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  if (!r.deletedCount) return false;

  const mov = await this.movimentos();
  await mov.deleteMany({ supply: new ObjectId(id) });
  return true;
};

// ── O ÚNICO CAMINHO DE ESCRITA DO SALDO ───────────────────────────────────
//
// Entrada soma, saída subtrai, ajuste DEFINE. O ajuste é diferente de propósito:
// ele é a contagem física — "o livro diz cinco, a prateleira tem três" — e o
// que se digita é o que passa a valer, não a diferença. Pedir a diferença
// obrigaria quem contou a fazer a subtração de cabeça.
Supply_model.prototype.movimentar = async function (id, obj, quem) {
  if (!ObjectId.isValid(id)) return null;

  const insumo = await this.data(id);
  if (!insumo) return null;

  const tipo = cat.ehMovimento(obj.tipo) ? String(obj.tipo) : "saida";
  const qtd = Math.abs(quantidade(obj.quantidade));
  if (!qtd && tipo !== "ajuste") return null;

  const antes = insumo.saldo;
  const depois =
    tipo === "entrada" ? antes + qtd : tipo === "saida" ? antes - qtd : quantidade(obj.quantidade);

  const mov = await this.movimentos();
  const col = await this.collection();
  const agora = new Date();

  const doc = {
    supply: new ObjectId(id),
    tipo,
    // A quantidade GRAVADA é sempre o efeito no saldo, com sinal. É o que
    // permite somar a coluna do livro e chegar no saldo sem reinterpretar tipo.
    quantidade: Math.round((depois - antes) * 1000) / 1000,
    // E o saldo depois, para o extrato mostrar a linha do tempo sem recalcular.
    saldoDepois: depois,
    // O custo só existe na ENTRADA: é o que se pagou pelo lote. Na saída, o
    // que sai é consumo — e atribuir preço a ele seria inventar um custo médio
    // que este módulo não se propõe a calcular.
    custo: tipo === "entrada" ? centavos(obj.custo) : 0,
    motivo: texto(240)(obj.motivo),
    unit: ObjectId.isValid(obj.unit) ? new ObjectId(String(obj.unit)) : null,
    por: quem?._id ? new ObjectId(String(quem._id)) : null,
    porNome: String(quem?.name || "").slice(0, 120),
    em: agora,
  };

  await mov.insertOne(doc);
  await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { saldo: depois, ultimoEm: agora, updatedAt: agora } }
  );

  return { ...doc, id: String(doc._id || ""), antes, depois };
};

Supply_model.prototype.extrato = async function (id, { limite } = {}) {
  if (!ObjectId.isValid(id)) return [];

  const mov = await this.movimentos();
  const docs = await mov
    .find({ supply: new ObjectId(id) })
    .sort({ em: -1 })
    .limit(Math.min(Math.max(Number(limite) || 100, 1), 500))
    .toArray();

  return docs.map((m) => ({
    id: String(m._id),
    tipo: m.tipo,
    quantidade: m.quantidade,
    saldoDepois: m.saldoDepois,
    custo: m.custo || 0,
    motivo: m.motivo || "",
    porNome: m.porNome || "",
    em: m.em,
  }));
};

// ── TUDO O QUE SAIU E ENTROU NA JANELA ────────────────────────────────────
//
// O extrato de UM insumo responde "como este desinfetante chegou a três"; este
// responde "o que a casa consumiu em maio". São a mesma tabela lida por eixos
// diferentes — por insumo e por data —, e a segunda é a que fecha o mês.
Supply_model.prototype.movimentosNoPeriodo = async function ({ de, ate, limite, unit } = {}) {
  const mov = await this.movimentos();
  const filtro = {};
  if (de || ate) {
    filtro.em = {};
    if (de) filtro.em.$gte = new Date(de);
    if (ate) filtro.em.$lte = new Date(ate);
  }

  // ── A LENTE DA UNIDADE ────────────────────────────────────────────────
  //
  // *"estrutura também não respeita unidades"*. O INSUMO é do estoque da casa
  // e não tem unidade; o MOVIMENTO tem — é ele que diz qual unidade consumiu
  // o galão. Então o histórico e o gasto filtram, e o catálogo não.
  //
  // Sem isto, a lente em Paraty mostrava a lista de aparelhos de Paraty com o
  // gasto de limpeza da casa inteira embaixo — dois números na mesma tela
  // respondendo a perguntas diferentes.
  if (ObjectId.isValid(String(unit || ""))) filtro.unit = new ObjectId(String(unit));

  const docs = await mov
    .aggregate([
      { $match: filtro },
      { $sort: { em: -1 } },
      { $limit: Math.min(Math.max(Number(limite) || 200, 1), 500) },
      { $lookup: { from: "supplies", localField: "supply", foreignField: "_id", as: "i" } },
    ])
    .toArray();

  return docs.map((m) => ({
    id: String(m._id),
    supply: String(m.supply),
    supplyName: m.i?.[0]?.name || "",
    medida: m.i?.[0]?.medida || "un",
    tipo: m.tipo,
    quantidade: m.quantidade,
    saldoDepois: m.saldoDepois,
    custo: m.custo || 0,
    motivo: m.motivo || "",
    // Quem CONSUMIU. Diferente da manutenção, o movimento tem unidade
    // PRÓPRIA — ele nasce com ela. *"quando eu pôr todas as unidades, sempre
    // exiba em qual unidade pertence"*.
    unit: m.unit || null,
    porNome: m.porNome || "",
    em: m.em,
  }));
};

// Quanto ENTROU de dinheiro em insumo numa janela — "quanto gastei com limpeza
// este mês". Só entradas: saída é consumo, não compra.
Supply_model.prototype.gastoNoPeriodo = async function ({ de, ate, unit } = {}) {
  const mov = await this.movimentos();
  const filtro = { tipo: "entrada" };
  if (de || ate) {
    filtro.em = {};
    if (de) filtro.em.$gte = new Date(de);
    if (ate) filtro.em.$lte = new Date(ate);
  }

  // A mesma lente do histórico — ver o comentário acima.
  if (ObjectId.isValid(String(unit || ""))) filtro.unit = new ObjectId(String(unit));

  const linhas = await mov
    .aggregate([
      { $match: filtro },
      {
        $lookup: {
          from: "supplies",
          localField: "supply",
          foreignField: "_id",
          pipeline: [{ $project: { categoria: 1 } }],
          as: "i",
        },
      },
      {
        $group: {
          _id: { $ifNull: [{ $arrayElemAt: ["$i.categoria", 0] }, "outro"] },
          total: { $sum: "$custo" },
        },
      },
      { $sort: { total: -1 } },
    ])
    .toArray();

  return {
    porCategoria: linhas.map((l) => ({ categoria: l._id, total: l.total })),
    total: linhas.reduce((n, l) => n + l.total, 0),
  };
};

module.exports = Supply_model;
module.exports.paraTela = paraTela;
