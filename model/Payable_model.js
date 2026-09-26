const { ObjectId } = require("mongodb");
const instanceContext = require("../lib/instance.js");
const { parseDataUri } = require("../lib/imageDataUri.js");
const statusDeCobranca = require("../lib/statusDeCobranca.js");
const categorias = require("../lib/categoriasDeConta.js");
const tempo = require("../lib/tempo.js");
const { porPagina: tetoPorPagina } = require("../lib/tetoDaLista.js");
const { recorteDeIds } = require("../lib/recorteDeIds.js");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");

// CONTAS A PAGAR — a luz, o telefone, o aluguel, a folha.
//
// *"crie mais um módulo chamado de contas a pagar para lançar conta de luz,
// telefone etc… por unidade também"*.
//
// ── POR QUE NÃO É UMA COBRANÇA COM SINAL TROCADO ────────────────────────
//
// Seria tentador: as duas têm valor, vencimento e "pago ou não". Mas quase tudo
// em volta diverge, e o que diverge é o que importa:
//
//   cobrança   pertence a uma PESSOA da conta, aceita pagamento PARCIAL, nasce
//              de recorrência ou de um aulão, aparece no extrato do aluno e no
//              app dele.
//   conta      pertence a um FORNECEDOR que não tem cadastro aqui, é paga de
//              uma vez, tem categoria, e ninguém além da administração vê.
//
// Metê-las na mesma collection faria toda consulta de aluno carregar um `$ne` de
// tipo, e toda soma do financeiro precisar lembrar do sinal. O dia em que
// alguém esquecesse, a conta de luz entraria como receita.
//
// ── A UNIDADE É O PEDIDO, e ela é DA CONTA ──────────────────────────────
//
// Diferente da cobrança, cuja unidade é a da PESSOA: a conta de luz é da
// unidade, não de ninguém. Guardá-la aqui é o que permite responder "quanto
// custa Paraty por mês", que é a pergunta que uma rede faz.
//
// Vazia é "da casa toda" — contador, software, marketing. Não é dado faltando:
// é uma resposta, e por isso o filtro a distingue de "todas".
//
// ── O ESTADO É O MESMO DA COBRANÇA, e é de propósito ────────────────────
//
// `open`, `paid`, `canceled` gravados, e `late` calculado do vencimento. A
// máquina é literalmente a mesma, e duplicá-la criaria duas listas de estados
// para traduzir e manter iguais — o problema que este projeto já teve duas
// vezes. O que muda é só de que lado do caixa a linha está.
function Payable_model(app) {
  this.app = app;
}

Payable_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payables");
};

function centavos(v) {
  if (typeof v === "number") return Math.round(v * (Number.isInteger(v) ? 1 : 100));
  const limpo = String(v ?? "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(limpo);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// O DIA, como as outras datas de ficha deste sistema: meia-noite UTC do dia do
// calendário. Vencimento não é um instante — 05/10 é 05/10 em qualquer fuso, e
// guardar a hora local faria a conta "vencer" um dia antes para quem estivesse
// a oeste.
function dia(valor, padrao = null) {
  const m = String(valor || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    if (valor instanceof Date && !Number.isNaN(valor.getTime())) return valor;
    return padrao;
  }
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

const CAMPOS = {
  description: (v) => String(v || "").trim().slice(0, 200),
  // ── QUEM RECEBE, agora por REFERÊNCIA ─────────────────────────────────
  //
  // Era texto livre, com o argumento de que um cadastro seria uma tela a mais.
  // O argumento estava incompleto, e é o mesmo que fez a categoria ser lista
  // fechada: com campo livre, "Enel", "ENEL" e "Enel SP" viram três
  // fornecedores, e "quanto paguei para a Enel este ano" deixa de ter resposta.
  //
  // `null` é legítimo: a taxa do cartório que se paga uma vez não precisa de
  // cadastro, e obrigar um faria alguém cadastrar "Diversos".
  supplier: (v) => (ObjectId.isValid(v) ? new ObjectId(String(v)) : null),
  categoria: categorias.normalizar,
  amount: (v) => centavos(v),
  dueDate: (v) => dia(v, new Date()),
  // QUANDO FOI PAGA. `null` enquanto não foi — e é ele, junto do estado, que
  // responde "paguei atrasado?" meses depois.
  paidAt: (v) => dia(v),
  status: (v) => (statusDeCobranca.GRAVAVEIS.includes(String(v)) ? String(v) : "open"),
  unit: (v) => (ObjectId.isValid(v) ? new ObjectId(String(v)) : null),
  note: (v) => String(v || "").trim().slice(0, 2000),
};

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);
  return saida;
}

// Só o que VEIO. A tela manda o formulário inteiro; uma integração manda um
// campo — e sobrescrever o resto com vazio apagaria a conta de alguém.
function limparParcial(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

// ── O COMPROVANTE ─────────────────────────────────────────────────────────
//
// *"faltou poder anexar comprovante"*. O boleto, o print do Pix, a nota.
//
// Mesma forma do comprovante de um pagamento (`Finance_model`): os BYTES numa
// collection à parte e uma FICHA leve no documento. A ficha é o que a lista
// mostra — nome, tipo, tamanho — sem arrastar o arquivo inteiro em toda
// consulta do mês.
const TIPOS_COMPROVANTE = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_COMPROVANTE = 8 * 1024 * 1024;

Payable_model.prototype.files = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payable_files");
};

Payable_model.prototype.parseReceipt = function (arquivo) {
  if (!arquivo || !arquivo.dataUri) return undefined;

  const lido = parseDataUri(arquivo.dataUri, {
    maxBytes: MAX_COMPROVANTE,
    mimes: TIPOS_COMPROVANTE,
  });
  if (!lido) return undefined;

  const nome = String(arquivo.name || "")
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 120);

  return {
    mime: lido.mime,
    buffer: lido.buffer,
    ficha: {
      name: nome || "comprovante",
      mime: lido.mime,
      size: lido.buffer.length,
      // Imagem abre na tela; PDF baixa. A mesma regra do resto do produto.
      kind: lido.mime.startsWith("image/") ? "image" : "file",
    },
  };
};

Payable_model.prototype.saveReceipt = async function (id, anexo) {
  const arquivos = await this.files();

  await arquivos.updateOne(
    { payable: new ObjectId(id) },
    {
      $set: {
        payable: new ObjectId(id),
        mime: anexo.mime,
        name: anexo.ficha.name,
        size: anexo.ficha.size,
        data: anexo.buffer,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { receipt: anexo.ficha } });
};

Payable_model.prototype.receiptOf = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const arquivos = await this.files();
  return (await arquivos.findOne({ payable: new ObjectId(id) })) || undefined;
};

Payable_model.prototype.removeReceipt = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ payable: new ObjectId(id) });

  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { receipt: null } });
  return true;
};

Payable_model.prototype.insert = async function (obj, createdBy, currency) {
  const doc = limpar(obj);
  // Sem descrição não há conta: a linha não diria o que é, e o relatório por
  // categoria não salva uma lista de "—".
  if (!doc.description) return null;

  const col = await this.collection();
  const r = await col.insertOne({
    ...doc,
    // A MOEDA gravada na linha, como no lançamento do aluno: "1200" em real e
    // "1200" em dólar são despesas diferentes, e um relatório que as soma mente.
    currency: currency || null,
    numero: await this.app.api.counter.proximo("payables"),
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Payable_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

Payable_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const set = limparParcial(obj);
  // Descrição vazia numa EDIÇÃO é apagar o que identifica a linha. Recusar é
  // melhor que gravar: a tela mostra o erro e a conta continua inteira.
  if (set.description !== undefined && !set.description) return false;

  // ── PAGAR E DESPAGAR ANDAM JUNTOS COM A DATA ──────────────────────────
  //
  // Marcar paga sem data deixaria "paguei quando?" sem resposta; desmarcar sem
  // limpar a data deixaria uma data de pagamento numa conta em aberto. Os dois
  // são o tipo de inconsistência que só aparece no fechamento do mês.
  if (set.status === "paid" && !set.paidAt) set.paidAt = new Date();
  if (set.status && set.status !== "paid") set.paidAt = null;

  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...set, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

Payable_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });

  // O comprovante vai junto: sem a conta, nenhuma tela o alcança e nada o
  // apagaria — ele ficaria no banco para sempre.
  if (r.deletedCount) {
    const arquivos = await this.files();
    await arquivos.deleteMany({ payable: new ObjectId(id) });
  }

  return r.deletedCount > 0;
};

// Quantas contas apontam para uma unidade. É o que a exclusão da unidade
// pergunta antes de deixar apagar.
Payable_model.prototype.quantasNaUnidade = async function (unitId) {
  if (!ObjectId.isValid(unitId)) return 0;
  const col = await this.collection();
  return col.countDocuments({ unit: new ObjectId(String(unitId)) });
};

const ORDEM = {
  numero: "numero",
  description: "description",
  supplier: "supplierName",
  categoria: "categoria",
  dueDate: "dueDate",
  amount: "amount",
  status: "situacao",
};

const LIMITE_MAXIMO = 200;
const LIMITE_PADRAO = 25;

function inicioDoDia(valor, fuso) {
  if (valor instanceof Date) return valor;
  const m = String(valor || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(valor);
  return tempo.instante({ ano: +m[1], mes: +m[2], dia: +m[3], hora: 0, minuto: 0 }, fuso);
}

function fimDoDia(valor, fuso) {
  if (valor instanceof Date) return valor;
  const m = String(valor || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(valor);
  const d = tempo.instante({ ano: +m[1], mes: +m[2], dia: +m[3], hora: 23, minuto: 59 }, fuso);
  return new Date(d.getTime() + 59999);
}

// ── A LISTA, UMA PÁGINA POR VEZ ───────────────────────────────────────────
//
// Mesma forma da carteira: um `$facet` com a página, a contagem e o resumo. Os
// três saem da MESMA varredura — três consultas seriam três passagens pela
// mesma janela para desenhar uma tela.
//
// E o resumo ignora o recorte (busca, categoria, estado) de propósito: os
// cartões falam do PERÍODO, e não da parte da lista que alguém resolveu ver. É
// a mesma decisão da carteira, e pela mesma razão — *"cada vez que eu troco de
// aba, os valores ali em cima mudam"*.
Payable_model.prototype.listar = async function ({
  units,
  de,
  ate,
  status,
  categoria,
  busca,
  unit,
  // `semUnidade` é o recorte "da casa toda": as contas que não pertencem a
  // unidade nenhuma. Ele é diferente de não filtrar, e a tela precisa dos dois.
  semUnidade,
  fuso,
  ordem,
  direcao,
  pagina,
  limite,
  // As contas marcadas na tela, para a planilha e a folha delas. E o teto
  // maior da exportação — ver `lib/tetoDaLista.js`.
  ids,
  exportando,
} = {}) {
  const col = await this.collection();

  const janela = {};
  if (de || ate) {
    janela.dueDate = {};
    if (de) janela.dueDate.$gte = inicioDoDia(de, fuso);
    if (ate) janela.dueDate.$lte = fimDoDia(ate, fuso);
  }

  // ── VENCE HOJE NÃO É VENCIDA ──────────────────────────────────────────
  //
  // *"se vence hoje, não está atrasado"* (24/09/2026), com o print de uma conta
  // de 24/09 marcada "Atrasada" — e "0 dia" escrito ao lado dela.
  //
  // O erro era comparar com o INSTANTE: `dueDate` é meia-noite UTC do dia do
  // calendário (ver `dia()` acima — vencimento não é um instante), e qualquer
  // hora de hoje já é maior que a meia-noite de hoje. A conta nascia vencida no
  // primeiro segundo do próprio dia de vencimento.
  //
  // A comparação certa é de CALENDÁRIO: vencida é a que venceu ANTES de hoje. E
  // "hoje" é o dia no fuso da CASA — o servidor roda em UTC, e às 21h de
  // Brasília ele já virou amanhã.
  const agora = new Date();
  const hoje = dia(tempo.paredeDe(agora, fuso).data) || agora;
  const DIA_MS = 24 * 60 * 60 * 1000;

  const derivados = {
    $addFields: {
      supplierName: { $ifNull: [{ $arrayElemAt: ["$fornecedor.name", 0] }, ""] },
      supplierPhoto: {
        $cond: [
          { $ifNull: [{ $arrayElemAt: ["$fornecedor.photo", 0] }, false] },
          { $toString: { $arrayElemAt: ["$fornecedor.photo", 0] } },
          null,
        ],
      },
      // VENCIDA é conta de vencimento, e não estado gravado: gravá-la exigiria
      // alguém passar todo dia meia-noite mudando linhas. Calculada, ela está
      // certa no instante em que se olha.
      atrasada: {
        $and: [
          { $eq: [{ $ifNull: ["$status", "open"] }, "open"] },
          { $lt: ["$dueDate", hoje] },
        ],
      },
      // Do mesmo marco: uma conta que vence hoje tem ZERO dia de atraso, e uma
      // que venceu ontem tem um — e não "zero e pouco", que era o que a divisão
      // pelo instante dava.
      diasDeAtraso: {
        $max: [0, { $floor: { $divide: [{ $subtract: [hoje, "$dueDate"] }, DIA_MS] } }],
      },
      // O POSTO da urgência, para ordenar por situação: o que venceu primeiro,
      // depois o que ainda vai vencer, e por último o que já morreu.
      situacao: {
        $switch: {
          branches: [
            { case: { $eq: ["$status", "canceled"] }, then: 3 },
            { case: { $eq: ["$status", "paid"] }, then: 2 },
            { case: { $lt: ["$dueDate", hoje] }, then: 0 },
          ],
          default: 1,
        },
      },
    },
  };

  const recorte = [];

  // OS MARCADOS. Primeiro, porque é o corte mais estreito que existe — e
  // "nenhum id válido" é nenhuma linha, nunca a lista inteira.
  const escolhidos = recorteDeIds(ids);
  if (escolhidos) recorte.push({ $match: { _id: { $in: escolhidos } } });

  const pedidos = statusDeCobranca.pedidos(status);
  if (pedidos.size) {
    const gravados = [...pedidos].filter((x) => x !== "late");
    const ou = [];
    if (gravados.length) ou.push({ status: { $in: gravados } });
    if (pedidos.has("late")) ou.push({ atrasada: true });
    recorte.push({ $match: { $or: ou } });
  }

  const cats = categorias.pedidos(categoria);
  if (cats.length) recorte.push({ $match: { categoria: { $in: cats } } });

  if (semUnidade) recorte.push({ $match: { unit: null } });
  else if (ObjectId.isValid(unit)) recorte.push({ $match: { unit: new ObjectId(String(unit)) } });
  // A CERCA: quem só alcança algumas unidades não passa disto, peça o que
  // pedir (26/09/2026). O que NÃO tem unidade continua aparecendo — é da casa,
  // não de outra unidade. Ver `lib/lenteDeUnidade.js`.
  else {
    const cerca = lenteDeUnidade.filtroDeUnidades(units);
    if (cerca) recorte.push({ $match: cerca });
  }

  const termo = String(busca || "").trim();
  if (termo) {
    const esc = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    recorte.push({
      $match: {
        $or: [
          { description: { $regex: esc, $options: "i" } },
          { supplierName: { $regex: esc, $options: "i" } },
        ],
      },
    });
  }

  const campo = ORDEM[ordem] || "dueDate";
  const sentido = direcao === "asc" ? 1 : -1;

  const limitePorPagina = tetoPorPagina(limite, {
    padrao: LIMITE_PADRAO,
    maximo: LIMITE_MAXIMO,
    exportando,
  });
  const paginaPedida = Math.max(Number(pagina) || 1, 1);

  const projecao = {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      numero: { $ifNull: ["$numero", null] },
      description: { $ifNull: ["$description", ""] },
      supplier: { $cond: [{ $ifNull: ["$supplier", false] }, { $toString: "$supplier" }, null] },
      supplierName: 1,
      supplierPhoto: 1,
      // A FICHA do comprovante, e não os bytes: a lista do mês não pode
      // arrastar trinta PDFs para dizer que eles existem.
      receipt: { $ifNull: ["$receipt", null] },
      categoria: { $ifNull: ["$categoria", categorias.PADRAO] },
      amount: { $ifNull: ["$amount", 0] },
      currency: { $ifNull: ["$currency", null] },
      dueDate: 1,
      paidAt: 1,
      status: { $ifNull: ["$status", "open"] },
      unit: { $cond: [{ $ifNull: ["$unit", false] }, { $toString: "$unit" }, null] },
      note: { $ifNull: ["$note", ""] },
      atrasada: 1,
      diasDeAtraso: 1,
    },
  };

  // O NOME e a FOTO de quem recebe, resolvidos aqui: a lista mostra "Enel" e
  // não um ObjectId, e uma segunda chamada para traduzir ids em nomes faria a
  // tabela piscar em dois tempos.
  const instancia = instanceContext.current();
  const juntarFornecedor = {
    $lookup: {
      from: "suppliers",
      let: { forn: "$supplier" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$_id", "$$forn"] },
            // `instance` à mão: o escopo do cliente não entra em sub-pipeline
            // de `$lookup`. Aqui é desempenho — a junção casa por ObjectId,
            // que é único global —, e sem ele ela varreria os fornecedores de
            // todos os clientes.
            ...(instancia ? { instance: instancia } : {}),
          },
        },
        { $project: { name: 1, photo: 1 } },
      ],
      as: "fornecedor",
    },
  };

  const [saida] = await col
    .aggregate([
      { $match: janela },
      juntarFornecedor,
      derivados,
      {
        $facet: {
          resumo: [
            {
              $group: {
                _id: null,
                // O QUE SAIU: só o que foi pago de verdade. Cancelada não é
                // despesa, e em aberto ainda não saiu da conta.
                pago: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
                aPagar: { $sum: { $cond: [{ $eq: ["$status", "open"] }, "$amount", 0] } },
                atrasado: { $sum: { $cond: ["$atrasada", "$amount", 0] } },
                quantasAbertas: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
                quantasAtrasadas: { $sum: { $cond: ["$atrasada", 1, 0] } },
                total: { $sum: 1 },
              },
            },
          ],
          // ── POR CATEGORIA ──────────────────────────────────────────────
          //
          // É o relatório que a tela existe para dar: "para onde vai o meu
          // dinheiro". Sai do mesmo `$facet` porque é a mesma janela — pedi-lo
          // à parte seria varrer o mês duas vezes.
          porCategoria: [
            { $match: { status: { $ne: "canceled" } } },
            { $group: { _id: "$categoria", total: { $sum: "$amount" }, quantas: { $sum: 1 } } },
            { $sort: { total: -1 } },
          ],
          rows: [
            ...recorte,
            { $sort: { [campo]: sentido, _id: 1 } },
            { $skip: (paginaPedida - 1) * limitePorPagina },
            { $limit: limitePorPagina },
            projecao,
          ],
          total: [...recorte, { $count: "n" }],
        },
      },
    ])
    .toArray();

  const resumo = saida?.resumo?.[0] || {};

  return {
    rows: saida?.rows || [],
    total: saida?.total?.[0]?.n || 0,
    pagina: paginaPedida,
    limite: limitePorPagina,
    resumo: {
      pago: resumo.pago || 0,
      aPagar: resumo.aPagar || 0,
      atrasado: resumo.atrasado || 0,
      quantasAbertas: resumo.quantasAbertas || 0,
      quantasAtrasadas: resumo.quantasAtrasadas || 0,
      total: resumo.total || 0,
    },
    porCategoria: (saida?.porCategoria || []).map((c) => ({
      categoria: c._id || categorias.PADRAO,
      total: c.total,
      quantas: c.quantas,
    })),
  };
};

module.exports = Payable_model;
