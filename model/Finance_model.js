const { ObjectId } = require("mongodb");
const { centavos } = require("./Service_model.js");
const { parseDataUri } = require("../lib/imageDataUri.js");

// O financeiro de cada pessoa.
//
//   charges         → o que ela DEVE: valor, vencimento, do que se trata
//   payments        → o que ela PAGOU: valor, data, forma, comprovante
//   payment_files   → os bytes do comprovante
//
// São duas coisas separadas de propósito, e essa é a decisão central do módulo.
// Um lançamento único de "pagou 120" não sabe responder duas perguntas que todo
// profissional faz: quem está devendo, e quanto entrou este mês. A cobrança
// responde a primeira e o pagamento a segunda.
//
// Isso também é o que permite o pagamento PARCIAL — quem paga 60 de 120 não
// quitou e não deixou de pagar — e o pagamento avulso, sem cobrança nenhuma:
// alguém que paga adiantado, ou uma venda que nunca virou cobrança.
//
// POR QUE NÃO um array de pagamentos dentro da cobrança, que leria melhor
// (15/08/2026 — a pergunta foi feita, e a resposta é esta):
//
//   • o pagamento AVULSO não teria onde morar, e precisaria de uma segunda
//     collection assim mesmo — pagamento em duas formas é pior que duas
//     collections;
//   • um pagamento que quita VÁRIAS cobranças ("paguei os três meses, R$ 750
//     no Pix") viraria três pedaços, e o comprovante, que é um arquivo só,
//     ficaria preso em um deles;
//   • "quanto entrou no mês" — o relatório mais pedido — é hoje uma consulta
//     direta em `payments`; com o array, viraria desmontar o array de todas as
//     cobranças e ainda somar com os avulsos.
//
// O preço de manter separado é UMA consulta a mais por pessoa (`paidByCharge`)
// para saber o que está quitado. Não cresce com o número de cobranças, e é o
// que garante que o "Quitada" da tela nunca discorde dos lançamentos: não há
// campo para discordar.
//
// TUDO em CENTAVOS, inteiro. `1.1 + 2.2` em ponto flutuante dá
// 3.3000000000000003, e dinheiro somado assim erra o centavo — que é
// exatamente o que ninguém perdoa num relatório financeiro.
function Finance_model(app) {
  this.app = app;
}

// Como o dinheiro entrou.
//
// A lista deixou de ser fixa: cada conta manda no próprio catálogo
// (PaymentMethod_model) — renomeia, desativa o que não usa, cria "Cheque". O que
// NÃO mudou é o motivo de existir um catálogo: `method` vira coluna de
// relatório, e com texto livre "pix", "PIX" e "Pix" seriam três formas
// diferentes.
//
// O que se guarda aqui é a CHAVE, e o formato dela é o que este arquivo cobra:
// minúsculas, números e hífen. Quem decide quais chaves existem é o catálogo; o
// que este teste de formato impede é uma frase inteira virar forma de pagamento
// por um pedido malformado.
const FORMATO_DA_FORMA = /^[a-z0-9][a-z0-9-]{0,29}$/;

// As sete originais, que toda conta ganha ao abrir o catálogo pela primeira vez.
const FORMAS = ["pix", "cash", "credit", "debit", "transfer", "billet", "other"];

// A cobrança está aberta, foi paga, ou foi cancelada.
//
// `paid` NÃO é gravado à mão: ele é consequência de os pagamentos cobrirem o
// valor. Um estado que se pode marcar sozinho acabaria discordando dos
// lançamentos logo ao lado.
const STATUS = ["open", "paid", "canceled"];

// O status do PAGAMENTO, que é outra coisa.
//
// O da cobrança é consequência (pagaram ou não); este é declarado, porque só
// quem registrou sabe. `paid` é o caso normal e o padrão. `pending` é o
// combinado que ainda não caiu — o Pix prometido para amanhã, o cheque
// pré-datado. `refunded` é o dinheiro que entrou e VOLTOU: o lançamento fica
// como histórico, mas parou de ser receita.
const STATUS_PAGAMENTO = ["paid", "pending", "refunded"];

// Lançamento antigo não tem o campo, e ausente é `paid`.
//
// Era o único significado possível antes deste campo existir. Ler ausência como
// "pendente" reescreveria o passado: o saldo de todo mundo que já usava o
// sistema mudaria sozinho, sem ninguém ter tocado em nada.
function statusDoPagamento(pagamento) {
  return STATUS_PAGAMENTO.includes(pagamento?.status) ? pagamento.status : "paid";
}

// O dinheiro entrou mesmo? É esta pergunta que o saldo faz.
function entrou(pagamento) {
  return statusDoPagamento(pagamento) === "paid";
}

const MAX_COMPROVANTE = 10 * 1024 * 1024;
const TIPOS_COMPROVANTE = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

Finance_model.prototype.charges = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("charges");
};

Finance_model.prototype.payments = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payments");
};

Finance_model.prototype.files = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payment_files");
};

function dataOuHoje(valor) {
  const d = valor ? new Date(valor) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function limparCobranca(obj) {
  return {
    amount: centavos(obj.amount),
    dueDate: dataOuHoje(obj.dueDate),
    description: String(obj.description || "").trim().slice(0, 200),
    status: STATUS.includes(obj.status) ? obj.status : "open",
    note: String(obj.note || "").trim().slice(0, 2000),
  };
}

function limparPagamento(obj) {
  return {
    amount: centavos(obj.amount),
    date: dataOuHoje(obj.date),
    method: FORMATO_DA_FORMA.test(String(obj.method || "")) ? String(obj.method) : "other",
    // Status desconhecido vira `paid` em vez de recusar o lançamento: o valor
    // vem de uma lista fechada na tela, e um erro aqui é mais provável ser
    // versão velha do navegador que má-fé.
    status: STATUS_PAGAMENTO.includes(obj.status) ? obj.status : "paid",
    note: String(obj.note || "").trim().slice(0, 2000),
  };
}

// ── Cobranças ─────────────────────────────────────────────────────────────

Finance_model.prototype.listCharges = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.charges();

  // Por vencimento, do mais recente para o mais antigo: a pergunta usual é
  // "como está agora", e o que venceu ontem importa mais que o de março.
  return await col
    .find({ student: new ObjectId(studentId) })
    .sort({ dueDate: -1 })
    .toArray();
};

Finance_model.prototype.chargeData = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.charges();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// A MOEDA fica gravada em cada lançamento, e não só na conta.
//
// Sem isso, trocar a moeda da conta reescreveria o passado: uma cobrança de
// R$ 120 de agosto passaria a ser lida como US$ 120 em setembro, sem nada ter
// mudado no banco. O valor é um número — quem lhe dá sentido é a moeda em que
// ele foi combinado, e essa não muda depois.
Finance_model.prototype.insertCharge = async function (studentId, obj, createdBy, currency) {
  const col = await this.charges();

  const r = await col.insertOne({
    student: new ObjectId(studentId),
    currency: currency || null,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    // De onde ela nasceu: um compromisso, ou a mão de alguém. É o que impede
    // a mesma aula de virar duas cobranças.
    appointment: ObjectId.isValid(obj.appointment) ? new ObjectId(obj.appointment) : null,
    service: ObjectId.isValid(obj.service) ? new ObjectId(obj.service) : null,
    ...limparCobranca(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Finance_model.prototype.updateCharge = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.charges();

  const mudanca = { ...limparCobranca(obj), updatedAt: new Date() };
  // A moeda só muda quando vem explícita e já validada pela rota: um corpo sem
  // ela não pode zerar a moeda de um lançamento antigo.
  if (obj.currency) mudanca.currency = obj.currency;

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });

  return r.matchedCount > 0;
};

Finance_model.prototype.deleteCharge = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.charges();

  // Os pagamentos ligados a ela viram avulsos em vez de sumirem: o dinheiro
  // entrou de verdade, e apagar a cobrança não desfaz isso.
  const pagamentos = await this.payments();
  await pagamentos.updateMany({ charge: new ObjectId(id) }, { $set: { charge: null } });

  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

// A cobrança de um compromisso, se já existir.
//
// É o que torna a geração automática segura de repetir: remarcar ou salvar o
// mesmo compromisso de novo não cria uma segunda cobrança.
Finance_model.prototype.chargeOfAppointment = async function (appointmentId) {
  if (!ObjectId.isValid(appointmentId)) return undefined;
  const col = await this.charges();

  const doc = await col.findOne({ appointment: new ObjectId(appointmentId) });
  return doc || undefined;
};

// ── Pagamentos ────────────────────────────────────────────────────────────

Finance_model.prototype.listPayments = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.payments();

  return await col
    .find({ student: new ObjectId(studentId) })
    .sort({ date: -1 })
    .toArray();
};

Finance_model.prototype.paymentData = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.payments();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

Finance_model.prototype.insertPayment = async function (studentId, obj, createdBy, currency) {
  const col = await this.payments();

  const r = await col.insertOne({
    student: new ObjectId(studentId),
    currency: currency || null,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    // A qual cobrança se refere, se a alguma: pagamento avulso é legítimo —
    // alguém que paga adiantado, ou uma venda que nunca virou cobrança.
    charge: ObjectId.isValid(obj.charge) ? new ObjectId(obj.charge) : null,
    ...limparPagamento(obj),
    receipt: obj.receipt || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Finance_model.prototype.updatePayment = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.payments();

  const mudanca = { ...limparPagamento(obj), updatedAt: new Date() };
  if (ObjectId.isValid(obj.charge)) mudanca.charge = new ObjectId(obj.charge);
  else if (obj.charge === null || obj.charge === "") mudanca.charge = null;

  if (obj.currency) mudanca.currency = obj.currency;

  // Tirar o comprovante no formulário tem de tirá-lo de verdade. Sem esta
  // linha, a tela mostrava o anexo removido e o servidor continuava com ele —
  // e os bytes ficavam no banco sem nada apontando para eles.
  if (obj.receipt === null) {
    await this.removeReceipt(id);
    mudanca.receipt = null;
  }

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  return r.matchedCount > 0;
};

Finance_model.prototype.deletePayment = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ payment: new ObjectId(id) });

  const col = await this.payments();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

// ── Comprovante ───────────────────────────────────────────────────────────

Finance_model.prototype.parseReceipt = function (arquivo) {
  if (!arquivo || !arquivo.dataUri) return undefined;

  const lido = parseDataUri(arquivo.dataUri, {
    maxBytes: MAX_COMPROVANTE,
    mimes: TIPOS_COMPROVANTE,
  });
  if (!lido) return undefined;

  // Só o nome, sem caminho, e sem caracteres de controle: ele volta para a
  // tela e vira o nome do download.
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
      // Imagem abre na tela; PDF baixa. É a mesma regra dos anexos da conversa.
      kind: lido.mime.startsWith("image/") ? "image" : "file",
    },
  };
};

Finance_model.prototype.saveReceipt = async function (paymentId, anexo) {
  const arquivos = await this.files();

  await arquivos.updateOne(
    { payment: new ObjectId(paymentId) },
    {
      $set: {
        payment: new ObjectId(paymentId),
        mime: anexo.mime,
        name: anexo.ficha.name,
        size: anexo.ficha.size,
        data: anexo.buffer,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  const col = await this.payments();
  await col.updateOne({ _id: new ObjectId(paymentId) }, { $set: { receipt: anexo.ficha } });
};

Finance_model.prototype.receiptOf = async function (paymentId) {
  if (!ObjectId.isValid(paymentId)) return undefined;
  const arquivos = await this.files();

  const doc = await arquivos.findOne({ payment: new ObjectId(paymentId) });
  return doc || undefined;
};

Finance_model.prototype.removeReceipt = async function (paymentId) {
  if (!ObjectId.isValid(paymentId)) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ payment: new ObjectId(paymentId) });

  const col = await this.payments();
  await col.updateOne({ _id: new ObjectId(paymentId) }, { $set: { receipt: null } });
  return true;
};

// ── O resumo ──────────────────────────────────────────────────────────────
//
// Quanto foi cobrado, quanto entrou, e o que falta — UM POR MOEDA.
//
// Não é um número só porque não pode ser: R$ 100 + US$ 100 não é 200 de coisa
// nenhuma, e um total somando os dois seria um número que não existe em lugar
// nenhum do mundo. O mapa também é o que um contador espera ver.
//
// Calculado na LEITURA e não guardado: um saldo gravado discorda dos
// lançamentos assim que alguém corrige um valor, e ninguém descobre qual dos
// dois está certo.
Finance_model.prototype.balanceOf = async function (studentId, moedaPadrao) {
  const cobrancas = await this.listCharges(studentId);
  const pagamentos = await this.listPayments(studentId);

  const porMoeda = {};
  const linha = (moeda) => {
    const chave = moeda || moedaPadrao || "BRL";
    if (!porMoeda[chave]) porMoeda[chave] = { charged: 0, paid: 0, balance: 0 };
    return porMoeda[chave];
  };

  for (const c of cobrancas) {
    // Cobrança cancelada não conta como dívida: ela existe só como registro.
    if (c.status === "canceled") continue;
    linha(c.currency).charged += c.amount || 0;
  }

  // Só o que ENTROU conta como pago. Um pagamento pendente é uma promessa, e um
  // reembolsado é dinheiro que voltou — somar os dois faria a tela dizer que a
  // pessoa está quite quando ela não está.
  for (const p of pagamentos) {
    if (!entrou(p)) continue;
    linha(p.currency).paid += p.amount || 0;
  }

  for (const chave of Object.keys(porMoeda)) {
    porMoeda[chave].balance = porMoeda[chave].charged - porMoeda[chave].paid;
  }

  return porMoeda;
};

// Quanto já foi pago de CADA cobrança. Um objeto id → centavos, para a tela
// marcar o que está quitado sem uma consulta por linha.
Finance_model.prototype.paidByCharge = async function (studentId) {
  const pagamentos = await this.listPayments(studentId);

  const soma = {};
  for (const p of pagamentos) {
    if (!p.charge) continue;
    // Mesma regra do saldo: promessa e reembolso não quitam cobrança. Sem isto,
    // um pagamento pendente marcaria a cobrança como paga e ela sumiria da lista
    // de quem ainda deve.
    if (!entrou(p)) continue;
    const chave = String(p.charge);
    soma[chave] = (soma[chave] || 0) + (p.amount || 0);
  }

  return soma;
};

// ── Cascata ───────────────────────────────────────────────────────────────

Finance_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;

  const pagamentos = await this.payments();
  const doAluno = await pagamentos
    .find({ student: new ObjectId(studentId) }, { projection: { _id: 1 } })
    .toArray();

  if (doAluno.length) {
    const arquivos = await this.files();
    await arquivos.deleteMany({ payment: { $in: doAluno.map((p) => p._id) } });
  }

  await pagamentos.deleteMany({ student: new ObjectId(studentId) });

  const cobrancas = await this.charges();
  const r = await cobrancas.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount || 0;
};

module.exports = Finance_model;
module.exports.FORMAS = FORMAS;
module.exports.STATUS = STATUS;
