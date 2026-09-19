const { ObjectId } = require("mongodb");
const cep = require("../lib/cep.js");
const vinculos = require("../lib/vinculosDeTrabalho.js");

// A EQUIPE DA CASA — quem trabalha aqui.
//
// *"crie mais um item no menu, chamado funcionários, para a gente cadastrar o
// funcionário, ver folha de ponto, salário, advertências, anotações e outras
// coisas que funcionário pode ter que eu não sei"*.
//
// ── POR QUE NÃO É `users` COM UM CAMPO A MAIS ───────────────────────────
//
// Foi a primeira ideia, e ela quebra nos dois sentidos.
//
// A FAXINEIRA não tem login. Ela não abre o sistema, não tem senha, não tem
// permissão nenhuma — e precisa de ficha, de ponto e de salário. Metê-la em
// `users` significaria criar uma conta que nunca entra, que aparece no seletor
// de profissional, e que alguém um dia vai tentar "ativar".
//
// O ALUNO tem login e não é funcionário. `users` é a tabela de quem ACESSA; se
// ela virasse também a de quem TRABALHA, todo lugar que lista pessoas passaria
// a ter de perguntar qual dos dois.
//
// Então são duas coisas, ligadas por um campo opcional: `employees.user`. O
// personal que dá aula e bate ponto tem os dois; a faxineira tem só a ficha; o
// aluno tem só a conta.
//
// ── ISTO É UM CADASTRO, NÃO UMA FOLHA DE PAGAMENTO ──────────────────────
//
// Nada aqui calcula INSS, FGTS, 13º ou rescisão. Quem faz isso é a
// contabilidade, com o software e a responsabilidade dela — e um cálculo
// errado nosso viraria passivo trabalhista do cliente.
//
// O que este módulo guarda é o que a academia precisa ter à mão: quem trabalha
// aqui, desde quando, ganhando quanto, e o que aconteceu no caminho.
function Employee_model(app) {
  this.app = app;
}

Employee_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("employees");
};

function texto(max) {
  return (v) => String(v || "").trim().slice(0, max);
}

// Dinheiro em CENTAVOS, como no resto do produto. Vírgula e ponto já chegam
// resolvidos da tela; aqui só entra inteiro.
function centavos(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 100000000);
}

function data(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const CAMPOS = {
  // ── QUEM É ────────────────────────────────────────────────────────────
  name: texto(120),
  // Como a equipe chama. Vai na lista de presença e no ponto — "Zé da limpeza"
  // é o que está escrito no quadro da parede, e procurar por "José Aparecido"
  // não acha.
  nickname: texto(60),
  cpf: texto(20),
  rg: texto(30),
  birthDate: data,
  phone: texto(30),
  whatsapp: texto(30),
  email: (v) => String(v || "").trim().slice(0, 140).toLowerCase(),

  // ── O ENDEREÇO, nas partes ────────────────────────────────────────────
  //
  // Mesmas chaves da unidade, de propósito: o mesmo componente de CEP da tela
  // de unidades preenche este formulário sem uma linha nova.
  cep: texto(20),
  logradouro: texto(160),
  numero: texto(20),
  complemento: texto(80),
  bairro: texto(80),
  cidade: texto(80),
  uf: texto(40),

  // ── QUEM AVISAR ───────────────────────────────────────────────────────
  //
  // O campo que ninguém pede e que é o mais importante da ficha no dia em que
  // faz falta. Academia é o lugar onde gente passa mal, e o funcionário é quem
  // está lá às seis da manhã, sozinho, abrindo a porta.
  emergencyName: texto(120),
  emergencyPhone: texto(30),
  emergencyRelation: texto(60),

  // ── O VÍNCULO ─────────────────────────────────────────────────────────
  role: texto(80),
  bond: (v) => (vinculos.existe(v) ? String(v) : "clt"),
  unit: (v) => (ObjectId.isValid(v) ? new ObjectId(String(v)) : null),
  admittedAt: data,
  dismissedAt: data,
  dismissalReason: texto(240),
  // A jornada semanal em HORAS. É o número que o ponto usa para dizer se o dia
  // fechou com saldo — sem ele, a folha soma horas e não compara com nada.
  weeklyHours: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n * 100) / 100, 84);
  },
  scheduleNote: texto(240),
  ctps: texto(40),
  pis: texto(30),

  // ── O QUE SE PAGA ─────────────────────────────────────────────────────
  salary: centavos,
  // Mensal ou por hora. O personal horista e a recepcionista mensalista moram
  // na mesma lista, e mostrar "R$ 45,00" sem dizer "por hora" ao lado de
  // "R$ 2.200,00" faria a lista parecer errada.
  salaryKind: (v) => (String(v) === "hourly" ? "hourly" : "monthly"),
  // ── OS BENEFÍCIOS SÃO UMA LISTA LIVRE ─────────────────────────────────
  //
  // Vale-transporte, vale-refeição, plano de saúde, gympass, bolsa de estudo,
  // ajuda de custo, comissão. Campos fixos para os quatro mais comuns
  // obrigariam o quinto a virar observação — e observação não soma.
  benefits: (v) =>
    (Array.isArray(v) ? v : [])
      .map((b) => ({ label: texto(60)(b?.label), amount: centavos(b?.amount) }))
      .filter((b) => b.label)
      .slice(0, 12),
  // Comissão em pontos percentuais (5 = 5%). Numa academia o professor que
  // vende plano ganha por isso, e o número vive na ficha dele.
  commission: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n * 100) / 100, 100);
  },

  // ── PARA ONDE VAI O DINHEIRO ──────────────────────────────────────────
  //
  // Só o suficiente para fazer o pagamento: a chave Pix resolve quase todos os
  // casos hoje, e banco/agência/conta ficam para quem ainda paga por TED.
  pix: texto(140),
  bank: texto(80),
  bankAgency: texto(20),
  bankAccount: texto(30),

  // ── O ELO COM A CONTA DE SISTEMA ──────────────────────────────────────
  //
  // Opcional, e é o que permite a faxineira existir aqui sem login. Quando
  // existe, é o mesmo profissional que aparece na agenda.
  user: (v) => (ObjectId.isValid(v) ? new ObjectId(String(v)) : null),

  photo: (v) => {
    const id = String(v || "").split("/").pop();
    return ObjectId.isValid(id) ? new ObjectId(id) : null;
  },

  note: texto(4000),
  active: (v) => v !== false,
};

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);
  return saida;
}

// Só o que VEIO. A tela manda o formulário inteiro; uma integração manda um
// campo — e sobrescrever o resto com vazio apagaria a ficha de alguém.
function limparParcial(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

// Sem acento e em minúsculas, para a busca achar "joão" digitando "joao" e a
// ordem alfabética não jogar "Ângela" para o fim da lista.
function normalizar(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// ── O DESLIGAMENTO DESATIVA, SEMPRE ───────────────────────────────────────
//
// Um funcionário com data de saída e `active: true` é uma contradição que a
// tela mostraria como "trabalhando aqui". O contrário não vale: desativar sem
// data de saída é legítimo — é o afastado longo, o que sumiu, o que ainda não
// teve a rescisão assinada.
function coerente(doc) {
  if (doc.dismissedAt) doc.active = false;
  return doc;
}

const ORDEM = {
  nome: "nameSort",
  cargo: "role",
  vinculo: "bond",
  admissao: "admittedAt",
  salario: "salary",
};

const LIMITE_PADRAO = 25;
const LIMITE_MAXIMO = 200;

// ── A LISTA ───────────────────────────────────────────────────────────────
//
// `situacao` é CALCULADA, e é o que a tela mostra no lugar de um "ativo/
// inativo" que não diz nada: quem está de férias hoje aparece de férias, e não
// some da lista nem finge que está no balcão.
//
// Ela sai de um `$lookup` na linha do tempo, procurando uma ocorrência de
// afastamento que cubra hoje. É uma consulta a mais por página — e é a resposta
// da pergunta que se faz olhando a lista de manhã: "quem eu tenho hoje?".
Employee_model.prototype.listar = async function ({
  busca,
  situacao,
  bond,
  unit,
  semUnidade,
  ordem,
  direcao,
  pagina,
  limite,
} = {}) {
  const col = await this.collection();

  const recorte = [];

  const termo = normalizar(busca);
  if (termo) {
    const esc = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    recorte.push({
      $match: {
        $or: [
          { nameSort: { $regex: esc } },
          { cpf: { $regex: esc } },
          { role: { $regex: esc, $options: "i" } },
        ],
      },
    });
  }

  if (bond) recorte.push({ $match: { bond: String(bond) } });

  // "Da casa toda" é um recorte de verdade, e não a ausência de filtro: o
  // contador e o faxineiro que atende as duas unidades não pertencem a nenhuma.
  if (semUnidade) recorte.push({ $match: { unit: null } });
  else if (unit && ObjectId.isValid(unit)) recorte.push({ $match: { unit: new ObjectId(unit) } });

  const hoje = new Date();

  const afastamento = [
    {
      $lookup: {
        from: "employee_records",
        let: { dono: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$employee", "$$dono"] },
                  { $in: ["$tipo", ["ferias", "atestado", "licenca"]] },
                  { $lte: ["$data", hoje] },
                  { $gte: [{ $ifNull: ["$ate", "$data"] }, hoje] },
                ],
              },
            },
          },
          { $project: { tipo: 1, ate: 1 } },
          { $limit: 1 },
        ],
        as: "afastado",
      },
    },
    {
      $addFields: {
        // A ordem importa: desligado ganha de afastado, e afastado ganha de
        // ativo. Um desligado com férias marcadas em março não pode voltar a
        // aparecer como "de férias" em abril.
        situacao: {
          $switch: {
            branches: [
              { case: { $ne: ["$dismissedAt", null] }, then: "desligado" },
              { case: { $eq: ["$active", false] }, then: "inativo" },
              {
                case: { $gt: [{ $size: "$afastado" }, 0] },
                then: { $arrayElemAt: ["$afastado.tipo", 0] },
              },
            ],
            default: "ativo",
          },
        },
        afastadoAte: { $arrayElemAt: ["$afastado.ate", 0] },
      },
    },
    { $project: { afastado: 0 } },
  ];

  // O filtro de situação vem DEPOIS do cálculo — ele pergunta pelo derivado.
  const porSituacao = [];
  if (situacao === "ativos") porSituacao.push({ $match: { situacao: { $ne: "desligado" } } });
  else if (situacao === "desligados") porSituacao.push({ $match: { situacao: "desligado" } });
  else if (situacao === "afastados") {
    porSituacao.push({ $match: { situacao: { $in: ["ferias", "atestado", "licenca"] } } });
  }

  const campo = ORDEM[ordem] || ORDEM.nome;
  const sinal = String(direcao) === "desc" ? -1 : 1;
  // O nome desempata toda ordenação: sem ele, duas páginas de "ordenar por
  // cargo" podem repetir uma linha e esconder outra.
  const sort = campo === "nameSort" ? { nameSort: sinal } : { [campo]: sinal, nameSort: 1 };

  const porPagina = Math.min(Math.max(Number(limite) || LIMITE_PADRAO, 1), LIMITE_MAXIMO);
  const pular = Math.max((Number(pagina) || 1) - 1, 0) * porPagina;

  const base = [...recorte, ...afastamento, ...porSituacao];

  const [saida] = await col
    .aggregate([
      ...base,
      {
        $facet: {
          rows: [{ $sort: sort }, { $skip: pular }, { $limit: porPagina }, projecao()],
          total: [{ $count: "n" }],
          // O RESUMO é do recorte inteiro, não da página: "18 na equipe, 2 de
          // férias" não pode mudar quando alguém vira a página.
          resumo: [
            {
              $group: {
                _id: null,
                equipe: { $sum: { $cond: [{ $eq: ["$situacao", "desligado"] }, 0, 1] } },
                afastados: {
                  $sum: {
                    $cond: [{ $in: ["$situacao", ["ferias", "atestado", "licenca"]] }, 1, 0],
                  },
                },
                desligados: { $sum: { $cond: [{ $eq: ["$situacao", "desligado"] }, 1, 0] } },
                // A FOLHA do mês: só quem está na casa e é mensalista. Somar o
                // horista aqui daria um número que não é nada — o dele depende
                // das horas do mês, que o ponto conta.
                folha: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$situacao", "desligado"] },
                          { $eq: ["$salaryKind", "monthly"] },
                        ],
                      },
                      "$salary",
                      0,
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const resumo = saida?.resumo?.[0] || {};

  return {
    rows: saida?.rows || [],
    total: saida?.total?.[0]?.n || 0,
    pagina: Math.floor(pular / porPagina) + 1,
    porPagina,
    paginas: Math.max(Math.ceil((saida?.total?.[0]?.n || 0) / porPagina), 1),
    resumo: {
      equipe: resumo.equipe || 0,
      afastados: resumo.afastados || 0,
      desligados: resumo.desligados || 0,
      folha: resumo.folha || 0,
    },
  };
};

// O que a LISTA leva. A ficha inteira vai em `data`, uma por vez — mandar
// endereço, PIS e conta bancária de trinta pessoas para desenhar uma tabela
// seria despejar dado sensível na rede sem ninguém pedir.
function projecao() {
  return {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      name: 1,
      nickname: 1,
      role: 1,
      bond: 1,
      photo: { $cond: [{ $ifNull: ["$photo", false] }, { $toString: "$photo" }, null] },
      unit: { $cond: [{ $ifNull: ["$unit", false] }, { $toString: "$unit" }, null] },
      admittedAt: 1,
      dismissedAt: 1,
      salary: 1,
      salaryKind: 1,
      weeklyHours: 1,
      phone: 1,
      situacao: 1,
      afastadoAte: 1,
      active: 1,
    },
  };
}

Employee_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

// A lista enxuta para seletores — quem está na casa, em ordem.
Employee_model.prototype.listActive = async function () {
  const col = await this.collection();
  return col
    .find({ dismissedAt: null, active: { $ne: false } }, { projection: { name: 1, nickname: 1, role: 1, photo: 1, unit: 1 } })
    .sort({ nameSort: 1 })
    .toArray();
};

Employee_model.prototype.contagem = async function () {
  const col = await this.collection();
  return col.countDocuments({});
};

Employee_model.prototype.insert = async function (obj) {
  const doc = coerente(limpar(obj));
  // Sem nome não há funcionário: a linha do ponto não diria de quem é.
  if (!doc.name) return null;

  doc.endereco = cep.umaLinha(doc);
  doc.nameSort = normalizar(doc.name);

  const col = await this.collection();
  const r = await col.insertOne({ ...doc, createdAt: new Date(), updatedAt: new Date() });

  await this.recolherFotos(r.insertedId, doc.photo);
  return r.insertedId;
};

Employee_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const mudanca = limparParcial(obj);
  if (mudanca.name !== undefined) {
    if (!mudanca.name) return false;
    // `nameSort` anda junto do nome: separados dariam uma lista que ordena por
    // um e mostra outro.
    mudanca.nameSort = normalizar(mudanca.name);
  }

  const col = await this.collection();
  const antes = await col.findOne({ _id: new ObjectId(id) });
  if (!antes) return false;

  // O endereço derivado é remontado a partir do que fica DEPOIS da mudança:
  // trocar só o número não pode apagar a rua da linha.
  mudanca.endereco = cep.umaLinha({ ...antes, ...mudanca });

  if (mudanca.dismissedAt) mudanca.active = false;

  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...mudanca, updatedAt: new Date() } }
  );

  const depois = await col.findOne({ _id: new ObjectId(id) }, { projection: { photo: 1 } });
  await this.recolherFotos(id, depois?.photo);

  return r.matchedCount > 0;
};

// A foto que não é mais a dela vira lixo. Mesma faxina dos fornecedores.
Employee_model.prototype.recolherFotos = async function (id, photo) {
  try {
    await this.app.api.employeeImage.pruneUnused(id, photo ? [String(photo)] : []);
  } catch (erro) {
    console.error("[funcionarios] faxina de foto:", erro.message);
  }
};

// ── APAGAR LEVA A HISTÓRIA JUNTO, e por isso quase nunca é o certo ────────
//
// O caminho normal é DESLIGAR: a pessoa sai da lista de quem trabalha aqui e o
// que aconteceu com ela continua existindo — advertência, atestado, o ponto do
// mês em que ela pediu conta. É isso que se pede num processo trabalhista.
//
// Apagar existe para o cadastro feito errado, e por isso ele avisa quantas
// ocorrências e quantos dias de ponto vão junto.
Employee_model.prototype.quantoTemJunto = async function (id) {
  if (!ObjectId.isValid(id)) return { ocorrencias: 0, pontos: 0 };
  const db = await this.app.mongodb.connectToServer();
  const dono = new ObjectId(id);

  const [ocorrencias, pontos] = await Promise.all([
    db.collection("employee_records").countDocuments({ employee: dono }),
    db.collection("employee_time").countDocuments({ employee: dono }),
  ]);

  return { ocorrencias, pontos };
};

Employee_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const dono = new ObjectId(id);

  const db = await this.app.mongodb.connectToServer();
  const col = await this.collection();

  const r = await col.deleteOne({ _id: dono });
  if (!r.deletedCount) return false;

  // A história vai junto — ela não tem dono para apontar, e ficaria no banco
  // para sempre sem nenhuma tela que a alcance.
  await db.collection("employee_records").deleteMany({ employee: dono });
  await db.collection("employee_time").deleteMany({ employee: dono });
  await this.app.api.employeeImage.removeAllOf(id).catch(() => {});

  return true;
};

module.exports = Employee_model;
module.exports.normalizar = normalizar;
module.exports.ORDEM = ORDEM;
