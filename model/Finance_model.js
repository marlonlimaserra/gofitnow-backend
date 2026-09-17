const { ObjectId } = require("mongodb");
const { centavos } = require("./Service_model.js");
const tempo = require("../lib/tempo.js");
const statusDeCobranca = require("../lib/statusDeCobranca.js");
const instanceContext = require("../lib/instance.js");
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
    // O AULÃO, quando a cobrança nasceu de uma inscrição. Terceira origem, e
    // ela precisa estar AQUI e não passar pelo `limparCobranca`: aquele fecha o
    // documento numa lista de campos, e um `aulao` mandado por fora seria
    // descartado em silêncio — a cobrança existiria sem vínculo, e uma segunda
    // inscrição na mesma aula viraria uma segunda cobrança sem ninguém notar.
    aulao: ObjectId.isValid(obj.aulao) ? new ObjectId(obj.aulao) : null,
    // A RECORRÊNCIA e o PERÍODO, quarta origem. Pelo mesmo motivo do `aulao`
    // logo acima: `limparCobranca` fecha o documento numa lista de campos, e um
    // vínculo mandado por fora sairia descartado em silêncio — aqui isso
    // desligaria o índice único e a mensalidade de setembro nasceria de novo a
    // cada abertura da tela.
    recurrence: ObjectId.isValid(obj.recurrence) ? new ObjectId(obj.recurrence) : null,
    periodo: obj.periodo ? String(obj.periodo).slice(0, 10) : null,
    ...limparCobranca(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// ── EDITAR É MUDAR O QUE VEIO, NÃO REESCREVER TUDO ────────────────────────
//
// `limparCobranca` monta o documento INTEIRO a partir do que recebe, com padrão
// para o que falta — que é o certo ao CRIAR e destrutivo ao editar. Um PUT com
// `{ status: "canceled" }` gravava `amount: 0`, `description: ""`, `note: ""` e
// o vencimento de HOJE.
//
// Passou despercebido porque o único chamador era o formulário, que manda todos
// os campos sempre. Na primeira chamada parcial — as ações em lote de
// 17/09/2026 — cinco cobranças de verdade perderam valor, descrição e
// vencimento. O relato foi uma pergunta: *"quando eu coloco reabrir, o que
// acontece?"*.
//
// Agora só entra no `$set` o campo que veio no corpo. O que a chamada não
// menciona, ela não toca.
const CAMPOS_DA_COBRANCA = {
  amount: (v) => centavos(v),
  dueDate: (v) => dataOuHoje(v),
  description: (v) => String(v || "").trim().slice(0, 200),
  status: (v) => (STATUS.includes(v) ? v : "open"),
  note: (v) => String(v || "").trim().slice(0, 2000),
};

Finance_model.prototype.updateCharge = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.charges();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS_DA_COBRANCA)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }
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

// A cobrança de um AULÃO para uma pessoa.
//
// Mesmo papel da de compromisso: é o que impede a mesma inscrição de virar duas
// cobranças quando alguém sai e entra de novo. Por PESSOA e por aulão, porque o
// aulão tem muitos inscritos e cada um tem a sua.
Finance_model.prototype.chargeOfAulao = async function (aulaoId, studentId) {
  if (!ObjectId.isValid(aulaoId) || !ObjectId.isValid(studentId)) return undefined;
  const col = await this.charges();
  return (
    (await col.findOne({ aulao: new ObjectId(aulaoId), student: new ObjectId(studentId) })) || undefined
  );
};

// ── Pagamentos ────────────────────────────────────────────────────────────

// ── O FINANCEIRO DE TODO MUNDO ────────────────────────────────────────────
//
// Tudo que existia aqui era POR PESSOA: `listCharges(studentId)`,
// `balanceOf(studentId)`. Funciona para a ficha de um aluno, e não responde a
// pergunta que se faz no fim do mês — "quanto tenho a receber?", "quem está
// atrasado?".
//
// Sem esta leitura a resposta exigia abrir as fichas uma por uma, e com 217
// pessoas ninguém faz isso: o dado existia e era inalcançável.
//
// ── POR QUE O ATRASO É CALCULADO, e não gravado ──────────────────────────
//
// "Atrasada" não é um status — é uma cobrança ABERTA cuja data já passou. Um
// status `late` gravado precisaria de alguém para virá-lo à meia-noite, e no
// dia em que esse alguém falhasse o relatório mentiria com confiança.
//
// A conta é feita na leitura, contra o instante de agora. Nunca envelhece.
const DIA_MS = 86400000;

// ── A JANELA É SOBRE O DIA, NÃO SOBRE O INSTANTE ──────────────────────────
//
// `de` e `ate` chegam como "AAAA-MM-DD" da tela. `new Date("2026-09-30")` é
// MEIA-NOITE UTC daquele dia — então `dueDate <= ate` excluía tudo que vencia
// naquele dia com qualquer hora.
//
// O defeito apareceu assim: três cobranças de um aulão do dia 30/09 às 09:00
// (12:00 UTC) não apareciam no Financeiro de setembro. O Marlon marcou duas como
// pagas e a tela continuou dizendo "recebido no mês R$ 0,00".
//
// E não era só do aulão: TODA cobrança com hora que vencesse no último dia da
// janela caía fora — as de compromisso inclusive, que herdam a hora do
// atendimento. Um relatório que perde o último dia de cada mês.
//
// ── O FUSO É O DA CONTA ───────────────────────────────────────────────────
//
// O fim do dia 30 em São Paulo é 01/10 às 03:00 UTC. Usar 23:59 UTC deixaria de
// fora a cobrança das 22h — de novo o mesmo tipo de erro, três horas menor.
//
// Quem resolve o fuso é o controlador, que tem acesso à conta; aqui só se aceita
// o instante pronto. `fim` é opcional para não quebrar quem já chamava com
// datas.
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
  // 23:59 do dia, no fuso da conta. O `+ 59999` fecha o minuto: sem ele, uma
  // cobrança às 23:59:30 ficaria de fora.
  const d = tempo.instante({ ano: +m[1], mes: +m[2], dia: +m[3], hora: 23, minuto: 59 }, fuso);
  return new Date(d.getTime() + 59999);
}

// ── O QUE SE PODE ORDENAR, e por qual campo ─────────────────────────────
//
// A tela ordenava sozinha, no navegador, sobre a lista inteira. Com a página
// vindo do banco isso deixa de funcionar: ordenar quinze linhas dá a ordem das
// quinze, e não as quinze primeiras de trezentas. Ordenação e paginação são a
// mesma decisão, e as duas passaram para cá.
//
// `situacao` é um POSTO calculado, não um campo: a ordem é a da urgência de quem
// olha — o que venceu primeiro, o que ainda vai vencer depois, e o que já morreu
// (pago, cancelado) no fim. É a mesma ordem que a tela usava.
const ORDEM_DA_CARTEIRA = {
  person: "studentName",
  description: "description",
  dueDate: "dueDate",
  createdAt: "createdAt",
  amount: "amount",
  status: "situacao",
};

// Teto de página. 200 pelo mesmo motivo da lista de pessoas: acima disso a
// resposta cresce sem que ninguém leia, e um `limit=100000` na barra de endereço
// vira uma varredura da collection inteira.
const LIMITE_MAXIMO = 200;
const LIMITE_PADRAO = 25;

// A CARTEIRA — a lista do Financeiro geral, uma PÁGINA por vez.
//
// ── Por que agregação, e não `find().sort().skip().limit()` ─────────────
//
// Porque quase nada do que esta tela mostra é campo da cobrança. `pago` é a soma
// dos pagamentos dela, `falta` é a diferença, `atrasada` é o relógio comparado
// com o vencimento, e o NOME da pessoa mora em outra collection. Ordenar ou
// filtrar por qualquer um deles exige que eles existam antes do `$sort` — daí os
// dois `$lookup` e o `$addFields`.
//
// ── UMA IDA AO BANCO, três respostas ────────────────────────────────────
//
// `$facet` separa o que cada uma enxerga, e a separação É a regra de negócio:
//
//   resumo   a JANELA INTEIRA, sem recorte nenhum — "como está o mês"
//   rows     a página, depois do recorte e da busca
//   total    quantas linhas o recorte tem, para a tela saber quantas páginas
//
// O resumo ignorar o recorte não é descuido: *"cada vez que eu troco de aba, os
// valores ali em cima mudam"*. A pergunta dos cartões é sobre o mês, não sobre a
// parte da lista que alguém resolveu ver.
Finance_model.prototype.carteira = async function ({
  de,
  ate,
  status,
  busca,
  fuso,
  ordem,
  direcao,
  pagina,
  limite,
} = {}) {
  const charges = await this.charges();

  const janela = {};
  // A janela é sobre o VENCIMENTO, não sobre quando a cobrança foi criada: o
  // relatório do mês é o do que vence no mês.
  if (de || ate) {
    janela.dueDate = {};
    // O DIA inteiro, e no fuso da conta — ver o cabeçalho de `inicioDoDia`.
    if (de) janela.dueDate.$gte = inicioDoDia(de, fuso);
    if (ate) janela.dueDate.$lte = fimDoDia(ate, fuso);
  }

  const agora = new Date();

  // ── AS DUAS JUNÇÕES ────────────────────────────────────────────────────
  //
  // O `instance` DENTRO da sub-pipeline é desempenho, não correção: `lib/escopo.js`
  // não alcança o interior de um `$lookup`, e a correção já está garantida porque
  // as duas casam por ObjectId, que é único global. Sem ele, cada junção varreria
  // os pagamentos e as pessoas de todos os clientes para achar as de um.
  const instancia = instanceContext.current();

  const juntarPagamentos = {
    $lookup: {
      from: "payments",
      let: { cobranca: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$charge", "$$cobranca"] },
            ...(instancia ? { instance: instancia } : {}),
            // Só o que ENTROU conta: pendente é promessa e reembolsado é
            // dinheiro que voltou. Mesma regra de `balanceOf` e `paidByCharge`.
            status: "paid",
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ],
      as: "recebimentos",
    },
  };

  const juntarPessoa = {
    $lookup: {
      from: "users",
      let: { pessoa: "$student" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$_id", "$$pessoa"] },
            ...(instancia ? { instance: instancia } : {}),
          },
        },
        // O documento da pessoa NÃO sai daqui inteiro: ela tem senha, sal e
        // ficha. Três campos, e é o que a tela e a planilha usam.
        { $project: { name: 1, email: 1, phone: 1 } },
      ],
      as: "pessoa",
    },
  };

  const derivados = {
    $addFields: {
      pago: { $ifNull: [{ $arrayElemAt: ["$recebimentos.total", 0] }, 0] },
      studentName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
      studentEmail: { $ifNull: [{ $arrayElemAt: ["$pessoa.email", 0] }, ""] },
      studentPhone: { $ifNull: [{ $arrayElemAt: ["$pessoa.phone", 0] }, ""] },
    },
  };

  const contas = {
    $addFields: {
      falta: { $max: [0, { $subtract: [{ $ifNull: ["$amount", 0] }, "$pago"] }] },
      origem: {
        $switch: {
          branches: [
            { case: { $ifNull: ["$appointment", false] }, then: "appointment" },
            { case: { $ifNull: ["$aulao", false] }, then: "aulao" },
            { case: { $ifNull: ["$recurrence", false] }, then: "recurrence" },
          ],
          default: "manual",
        },
      },
    },
  };

  const atraso = {
    $addFields: {
      // ATRASADA é calculada, nunca gravada: é uma cobrança ABERTA cuja data
      // passou. Gravá-la exigiria alguém varrer o banco à meia-noite.
      atrasada: {
        $and: [
          { $eq: ["$status", "open"] },
          { $gt: ["$falta", 0] },
          { $ne: [{ $ifNull: ["$dueDate", null] }, null] },
          { $lt: ["$dueDate", agora] },
        ],
      },
      diasDeAtraso: {
        $cond: [
          {
            $and: [
              { $eq: ["$status", "open"] },
              { $ne: [{ $ifNull: ["$dueDate", null] }, null] },
              { $lt: ["$dueDate", agora] },
            ],
          },
          { $floor: { $divide: [{ $subtract: [agora, "$dueDate"] }, DIA_MS] } },
          0,
        ],
      },
    },
  };

  // O POSTO da situação, para ordenar por ela. Mesma escala que a tela usava.
  const posto = {
    $addFields: {
      situacao: {
        $switch: {
          branches: [
            { case: { $eq: ["$status", "canceled"] }, then: 4 },
            { case: { $eq: ["$falta", 0] }, then: 3 },
            { case: "$atrasada", then: 1 },
          ],
          default: 2,
        },
      },
    },
  };

  // ── O RECORTE: estados e busca ─────────────────────────────────────────
  //
  // Ele mora DENTRO do facet, e só nos ramos `rows` e `total`. O ramo do resumo
  // parte do mesmo ponto sem ele — é o que faz os três cartões continuarem
  // falando do mês inteiro.
  const recorte = [];

  const pedidos = statusDeCobranca.pedidos(status);
  if (pedidos.size) {
    const aceitos = [...pedidos].filter((x) => x !== "late");
    const ou = [];
    if (aceitos.length) ou.push({ status: { $in: aceitos } });
    // "late" não é status gravado: é o campo calculado acima.
    if (pedidos.has("late")) ou.push({ atrasada: true });
    recorte.push({ $match: { $or: ou } });
  }

  // A BUSCA passou para o banco, e tinha de passar.
  //
  // Ela era um `filter` em JavaScript sobre a lista inteira — o que só funciona
  // enquanto a lista inteira vem. Buscando na página, "Ana" acharia as Anas das
  // vinte e cinco linhas carregadas e diria que não existe mais nenhuma.
  const termo = String(busca || "").trim();
  if (termo) {
    const esc = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    recorte.push({
      $match: {
        $or: [
          { studentName: { $regex: esc, $options: "i" } },
          { description: { $regex: esc, $options: "i" } },
        ],
      },
    });
  }

  const campo = ORDEM_DA_CARTEIRA[ordem] || "dueDate";
  const sentido = direcao === "asc" ? 1 : -1;

  const limitePorPagina = Math.min(Math.max(Number(limite) || LIMITE_PADRAO, 1), LIMITE_MAXIMO);
  const paginaPedida = Math.max(Number(pagina) || 1, 1);

  const projecao = {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      student: { $toString: "$student" },
      description: { $ifNull: ["$description", ""] },
      amount: { $ifNull: ["$amount", 0] },
      pago: 1,
      falta: 1,
      dueDate: 1,
      // QUANDO A COBRANÇA NASCEU, que é outra pergunta que o vencimento não
      // responde: "lancei isso quando?" separa o que se combinou em janeiro do
      // que se combinou ontem, mesmo os dois vencendo no mesmo dia.
      createdAt: { $ifNull: ["$createdAt", null] },
      status: 1,
      currency: { $ifNull: ["$currency", null] },
      origem: 1,
      atrasada: 1,
      diasDeAtraso: 1,
      studentName: 1,
      studentEmail: 1,
      studentPhone: 1,
    },
  };

  const [saida] = await charges
    .aggregate(
      [
        { $match: janela },
        juntarPagamentos,
        juntarPessoa,
        derivados,
        contas,
        atraso,
        posto,
        {
          $facet: {
            // A JANELA INTEIRA — sem recorte, sem busca, sem página.
            resumo: [
              {
                $group: {
                  _id: null,
                  recebido: { $sum: "$pago" },
                  aReceber: { $sum: { $cond: [{ $eq: ["$status", "open"] }, "$falta", 0] } },
                  atrasado: { $sum: { $cond: ["$atrasada", "$falta", 0] } },
                  quantasAtrasadas: { $sum: { $cond: ["$atrasada", 1, 0] } },
                  quantasAbertas: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
                  total: { $sum: 1 },
                },
              },
            ],
            rows: [
              ...recorte,
              // Vazio sempre no fim, nas duas direções — a mesma regra da lista
              // de pessoas. Ordenar por descrição para achar uma fileira de
              // linhas sem descrição no topo não ajuda ninguém.
              { $addFields: { __vazio: { $cond: [{ $in: [`$${campo}`, [null, ""]] }, 1, 0] } } },
              // `_id` no fim desempata: sem um critério estável, duas cobranças
              // com o mesmo vencimento podem trocar de lugar entre uma página e
              // outra — e aí uma delas some e outra aparece duas vezes.
              { $sort: { __vazio: 1, [campo]: sentido, _id: 1 } },
              { $skip: (paginaPedida - 1) * limitePorPagina },
              { $limit: limitePorPagina },
              projecao,
            ],
            total: [...recorte, { $count: "n" }],
          },
        },
      ],
      // Collation do banco em vez de `localeCompare` no navegador: é ela que faz
      // "Ávila" cair perto de "Avila", e não depois de "Zanetti".
      { collation: { locale: "pt", strength: 1 } }
    )
    .toArray();

  const resumo = saida?.resumo?.[0] || {};

  return {
    rows: saida?.rows || [],
    total: saida?.total?.[0]?.n || 0,
    pagina: paginaPedida,
    limite: limitePorPagina,
    resumo: {
      recebido: resumo.recebido || 0,
      aReceber: resumo.aReceber || 0,
      atrasado: resumo.atrasado || 0,
      quantasAtrasadas: resumo.quantasAtrasadas || 0,
      quantasAbertas: resumo.quantasAbertas || 0,
      total: resumo.total || 0,
    },
  };
};

// ── O RESUMO ──────────────────────────────────────────────────────────────
//
// Sobre TODAS as linhas da janela, e não sobre as filtradas: filtrar por
// "atrasadas" e ver o total a receber cair para o valor dos atrasados faria o
// número parecer um total da seleção. É a mesma decisão da carteira de
// assinaturas no painel.
function resumoDe(linhas) {
  const abertas = linhas.filter((l) => l.status === "open");

  return {
    // O que ENTROU: a soma do que foi pago, independente do status da cobrança
    // (uma cobrança cancelada depois de paga não desfaz o dinheiro).
    recebido: linhas.reduce((t, l) => t + l.pago, 0),
    // O que falta entrar das abertas.
    aReceber: abertas.reduce((t, l) => t + l.falta, 0),
    atrasado: linhas.filter((l) => l.atrasada).reduce((t, l) => t + l.falta, 0),
    quantasAtrasadas: linhas.filter((l) => l.atrasada).length,
    quantasAbertas: abertas.length,
    total: linhas.length,
  };
}

Finance_model.prototype.listPayments = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.payments();

  return await col
    .find({ student: new ObjectId(studentId) })
    .sort({ date: -1 })
    .toArray();
};

// Os pagamentos de UMA cobrança.
//
// Existe porque o diálogo de editar mostra "Paga" e, sem a lista, isso é uma
// afirmação que a pessoa não tem como conferir: *"a cobrança tem pagamentos,
// certo? mais fácil exibir os pagamentos aqui nesse dialog"*.
//
// A ficha da pessoa já tinha os dados (ela carrega TODOS os pagamentos dela e
// separa por cobrança), mas a lista do financeiro é de gente diferente em cada
// linha — carregar o extrato inteiro de alguém para abrir uma cobrança seria
// pagar caro por três linhas.
Finance_model.prototype.paymentsOfCharge = async function (chargeId) {
  if (!ObjectId.isValid(chargeId)) return [];
  const col = await this.payments();

  return await col
    .find({ charge: new ObjectId(chargeId) })
    .sort({ date: -1 })
    .toArray();
};

Finance_model.prototype.paymentData = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.payments();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// ── A MOEDA DE UM PAGAMENTO QUE APONTA PARA UMA COBRANÇA É A DELA ─────────
//
// Quitar uma cobrança de R$ 25 com um pagamento de US$ 25 não dá erro em lugar
// nenhum: a conta FECHA. `paidByCharge`, `balanceOf` e a carteira somam
// `amount` e comparam com o da cobrança — 2500 quita 2500, e ninguém pergunta
// de que moeda são.
//
// Está aqui, e não nas rotas, porque são DOIS caminhos (criar e editar) e o
// segundo é o pior: o pagamento já estava certo, a conta já fechou uma vez, e a
// troca de moeda numa edição desfaz isso sem deixar rastro na tela.
//
// Pagamento AVULSO — sem cobrança — continua com a moeda que foi pedida.
// Adiantamento em outra moeda é combinado legítimo; o que não existe é combinado
// de quitar em uma moeda uma dívida em outra.
Finance_model.prototype.moedaDaCobranca = async function (chargeId) {
  if (!ObjectId.isValid(chargeId)) return null;
  const doc = await (await this.charges()).findOne(
    { _id: new ObjectId(chargeId) },
    { projection: { currency: 1 } }
  );
  return doc?.currency || null;
};

Finance_model.prototype.insertPayment = async function (studentId, obj, createdBy, currency) {
  const col = await this.payments();
  const moeda = (await this.moedaDaCobranca(obj.charge)) || currency;

  const r = await col.insertOne({
    student: new ObjectId(studentId),
    currency: moeda || null,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    // A qual cobrança se refere, se a alguma: pagamento avulso é legítimo —
    // alguém que paga adiantado, ou uma venda que nunca virou cobrança.
    charge: ObjectId.isValid(obj.charge) ? new ObjectId(obj.charge) : null,

    // ── FOI UM BOTÃO QUE LANÇOU ISTO? ───────────────────────────────────
    //
    // `true` quando veio de um atalho do sistema — hoje só o "marcar como
    // pago" da lista de inscritos do aulão.
    //
    // Existe por causa do DESFAZER. Sem a marca, "marcar como não pago"
    // precisaria apagar todos os pagamentos da cobrança — e apagaria também o
    // parcial que alguém digitou à mão no financeiro, que é dado de gente e
    // não subproduto de um clique.
    //
    // AQUI e não no `limparPagamento`: aquele fecha o documento numa lista de
    // campos, e o que for mandado por fora dele é descartado em silêncio — foi
    // exatamente o que aconteceu com o `aulao` da cobrança.
    automatico: obj.automatico === true,
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

  // A moeda segue a cobrança — ver `moedaDaCobranca`.
  //
  // Qual cobrança: a que a edição APONTA (`mudanca.charge`), ou, quando a edição
  // não fala de vínculo nenhum, a que o pagamento JÁ tem. Esse segundo caso é o
  // que uma chamada parcial — `{ currency: "USD" }` e nada mais — usaria para
  // passar por baixo da regra. `null` explícito é desvínculo pedido, e aí o
  // pagamento vira avulso e a moeda volta a ser escolha de quem lança.
  let alvo = mudanca.charge;
  if (alvo === undefined && obj.currency) {
    const atual = await col.findOne({ _id: new ObjectId(id) }, { projection: { charge: 1 } });
    alvo = atual?.charge;
  }

  const daCobranca = await this.moedaDaCobranca(alvo);
  if (daCobranca) mudanca.currency = daCobranca;

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

// ── AS COBRANÇAS DE UM AULÃO, POR PESSOA ──────────────────────────────────
//
// Para a lista de inscritos: quem já pagou, quem falta, e quanto.
//
// ── "Pago" é uma SOMA, e não o campo `status` ─────────────────────────────
//
// É a mesma regra do `carteira`, e ela não pode ser reinventada aqui: pagamento
// PARCIAL existe — alguém paga metade hoje e metade no dia da aula —, e só
// pagamento com `status: "paid"` quita. Promessa e reembolso não.
//
// Duas consultas para a lista inteira, e não duas por pessoa: trinta inscritos
// dariam sessenta idas ao banco para desenhar uma tela.
Finance_model.prototype.cobrancasDeAulao = async function (aulaoId) {
  if (!ObjectId.isValid(aulaoId)) return {};

  const col = await this.charges();
  const cobrancas = await col.find({ aulao: new ObjectId(aulaoId) }).toArray();
  if (!cobrancas.length) return {};

  const pagamentos = await this.payments();
  const somas = await pagamentos
    .aggregate([
      { $match: { charge: { $in: cobrancas.map((c) => c._id) }, status: "paid" } },
      { $group: { _id: "$charge", total: { $sum: "$amount" } } },
    ])
    .toArray();

  const pagoPor = Object.fromEntries(somas.map((x) => [String(x._id), x.total]));

  const porPessoa = {};
  for (const c of cobrancas) {
    const pago = pagoPor[String(c._id)] || 0;
    porPessoa[String(c.student)] = {
      id: String(c._id),
      amount: c.amount || 0,
      pago,
      falta: Math.max(0, (c.amount || 0) - pago),
      status: c.status,
      currency: c.currency || null,
    };
  }

  return porPessoa;
};

// ── QUITAR uma cobrança de uma vez ────────────────────────────────────────
//
// "marcar como pago" na lista de inscritos. No app isto sempre foram DOIS
// passos — lançar o pagamento e depois fechar a cobrança —, e ninguém faz os
// dois trinta vezes depois de um aulão.
//
// ── Os dois passos, e por que os dois ─────────────────────────────────────
//
// O PAGAMENTO é o dinheiro: sem ele o relatório diria que entrou zero.
// O STATUS é a cobrança: sem ele ela continua "aberta" com nada faltando, e
// aparece na lista de quem deve com R$ 0,00 — pior que errado, é confuso.
//
// ── IDEMPOTENTE ──────────────────────────────────────────────────────────
//
// Clicar duas vezes não lança dois pagamentos. `falta <= 0` devolve `ja_pago`
// sem escrever nada — e isso não é zelo abstrato: dois cliques num botão de
// "pago" é o gesto mais natural que existe quando a rede demora.
Finance_model.prototype.quitarCobranca = async function (chargeId, { method, createdBy } = {}) {
  if (!ObjectId.isValid(chargeId)) return { ok: false, erro: "nao_achei" };

  const col = await this.charges();
  const cobranca = await col.findOne({ _id: new ObjectId(chargeId) });
  if (!cobranca) return { ok: false, erro: "nao_achei" };

  const pagos = await this.paidByCharge(cobranca.student);
  const falta = Math.max(0, (cobranca.amount || 0) - (pagos[String(cobranca._id)] || 0));

  if (falta <= 0) {
    // Já estava quitada no dinheiro. O status é fechado de todo jeito: pode ter
    // ficado "aberto" por um pagamento lançado à mão na tela do financeiro.
    if (cobranca.status === "open") {
      await col.updateOne({ _id: cobranca._id }, { $set: { status: "paid", updatedAt: new Date() } });
    }
    return { ok: true, erro: "ja_pago", falta: 0 };
  }

  const pagamento = await this.insertPayment(
    cobranca.student,
    {
      // O que FALTA, e não o valor cheio: quem pagou metade antes não pode
      // aparecer tendo pago uma vez e meia.
      amount: falta,
      date: new Date(),
      method,
      status: "paid",
      charge: String(cobranca._id),
      // A marca do desfazer — ver `insertPayment`.
      automatico: true,
    },
    createdBy,
    cobranca.currency
  );

  await col.updateOne({ _id: cobranca._id }, { $set: { status: "paid", updatedAt: new Date() } });

  return { ok: true, pagamento: String(pagamento), valor: falta };
};

// ── DESFAZER O "MARCAR COMO PAGO" ─────────────────────────────────────────
//
// O mesmo botão, apertado de novo. E o cuidado inteiro está em O QUE ele apaga.
//
// ── A primeira versão dizia que desfez e não desfazia ────────────────────
//
// Ela apagava só os pagamentos com `automatico: true` — a marca que o botão
// põe. Correto no papel, e errado na mão do Marlon: os pagamentos lançados
// ANTES de a marca existir (algumas horas, no mesmo dia) não a têm, então o
// botão anunciava "marcar como não pago", apagava zero, e a linha continuava
// paga. *"ele fala marco como não pago, mas continua pago."*
//
// Botão que promete e não cumpre é defeito, não sutileza.
//
// ── A regra, em duas camadas ─────────────────────────────────────────────
//
//   1. apaga os `automatico` — o que este botão criou, sem dúvida nenhuma;
//   2. se não havia nenhum E a cobrança está quitada por UM pagamento só que
//      a cobre inteira, apaga esse também.
//
// A segunda camada é o que resolve o caso do Marlon e o da instância de
// demonstração. Ela é segura porque "um pagamento só, do valor exato" não tem
// ambiguidade: desfazê-lo é exatamente o que se pediu, e ele é um lançamento
// visível que se refaz com um clique.
//
// ── O QUE ELA NUNCA APAGA ────────────────────────────────────────────────
//
// PARCIAIS. Dois ou mais pagamentos na mesma cobrança são história que alguém
// digitou — metade em dinheiro no dia da aula, metade no Pix depois — e
// escolher qual apagar seria adivinhar. Nesse caso devolve `manual: true` e
// não toca em nada; a tela diz para desfazer no financeiro da pessoa, onde a
// escolha é de quem olha os lançamentos.
//
// ── E o status é RECALCULADO, não chutado ────────────────────────────────
//
// Depois de apagar, a conta é feita de novo: se ainda falta, a cobrança volta
// a "open"; se o que sobrou já a cobre, continua "paid".
Finance_model.prototype.reabrirCobranca = async function (chargeId) {
  if (!ObjectId.isValid(chargeId)) return { ok: false, erro: "nao_achei" };

  const col = await this.charges();
  const cobranca = await col.findOne({ _id: new ObjectId(chargeId) });
  if (!cobranca) return { ok: false, erro: "nao_achei" };

  const pagamentos = await this.payments();

  // Camada 1: o que este botão criou.
  let apagados = (await pagamentos.deleteMany({ charge: cobranca._id, automatico: true }))
    .deletedCount;

  // Camada 2: um pagamento só, cobrindo a cobrança inteira.
  if (apagados === 0) {
    const doCharge = await pagamentos.find({ charge: cobranca._id, status: "paid" }).toArray();

    if (doCharge.length === 1 && (doCharge[0].amount || 0) >= (cobranca.amount || 0)) {
      await pagamentos.deleteOne({ _id: doCharge[0]._id });
      apagados = 1;
    } else if (doCharge.length > 1) {
      // Parciais: não escolho por ninguém. A tela explica onde desfazer.
      return { ok: true, apagados: 0, manual: true, falta: 0 };
    }
  }

  // A conta depois da remoção, pela mesma regra do resto: só pagamento com
  // `status: "paid"` quita.
  const somas = await pagamentos
    .aggregate([
      { $match: { charge: cobranca._id, status: "paid" } },
      { $group: { _id: "$charge", total: { $sum: "$amount" } } },
    ])
    .toArray();

  const pago = somas[0]?.total || 0;
  const falta = Math.max(0, (cobranca.amount || 0) - pago);

  await col.updateOne(
    { _id: cobranca._id },
    { $set: { status: falta > 0 ? "open" : "paid", updatedAt: new Date() } }
  );

  return { ok: true, apagados, falta };
};
