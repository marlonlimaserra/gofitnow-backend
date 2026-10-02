const { ObjectId } = require("mongodb");
const { porPagina: tetoPorPagina } = require("../lib/tetoDaLista.js");
const { recorteDeIds } = require("../lib/recorteDeIds.js");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");
const funil = require("../lib/funilDeLeads.js");
const nomeDaPessoa = require("../lib/nomeDaPessoa.js");

// OS LEADS — quem procurou e ainda não é aluno.
//
// *"crie uma nova rota chamada 'lead'. Esses leads vão ser os dados de pessoas
// que não pagam nada e nem são alunos"* (01/10/2026).
//
// ── ELES MORAM EM `users`, COM `type: "lead"` ───────────────────────────
//
// Eu os pus numa coleção própria primeiro, e estava errado. Ele desenhou o
// motivo em uma frase: *"agente só muda uma chave false ou true, e pronto,
// todos os dados já aparecem em aluno sem ter que copiar nada de um lugar para
// o outro"*.
//
// Converter é o ponto inteiro desta tela, e com duas coleções converter é
// COPIAR: ler lá, escrever cá, e torcer para os dois lados não divergirem. Pior,
// o lead ganharia um `_id` novo ao virar aluno — e todo histórico que apontava
// para o antigo viraria ponteiro quebrado.
//
// Com `type`, converter é `type: "lead" → "student"` mais o vínculo. **O
// documento não se move e o `_id` não muda.** Quem foi lead continua sendo a
// mesma linha do banco depois de virar aluno.
//
// ── AS QUATRO OBJEÇÕES, MEDIDAS NO CÓDIGO (01/10/2026) ──────────────────
//
// Eu tinha medo de vazamento, e fui contar em vez de supor:
//
//   1. A LISTA DE PESSOAS não filtra por tipo — ela parte dos VÍNCULOS
//      (`User_model.pageStudents` → `link.personIdsOf`). Lead não tem vínculo,
//      então não aparece lá nem por acidente. Era o meu maior receio, e o
//      código já o tinha resolvido antes de eu chegar.
//
//   2. O TETO DO PLANO conta `{ type: "student" }` (ver `controllers/Student.js`).
//      `type: "lead"` não entra na conta — e é por isso que o tipo é um valor
//      próprio, e não uma flag ao lado de `student`.
//
//   3. LEAD NÃO ENTRA NO SISTEMA: `User_model.podeEntrar` exige senha E sal, e
//      um lead não tem nenhum dos dois. Não é regra nova a manter; é a mesma que
//      já segura a ficha de aluno sem acesso liberado.
//
//   4. O E-MAIL É ÚNICO na instância (índice parcial, só onde é string). Dois
//      leads SEM e-mail não colidem — `normalizeEmail` grava `null`, não `""`.
//      Um lead com o e-mail de alguém que já existe é recusado, e isso é o
//      desejável: a pessoa já está no sistema, e o lugar dela é a ficha.
//
// O único lugar do backend que conta `users` sem olhar o tipo é o aviso antes
// de apagar uma UNIDADE (`Unit_model.quantasPessoas`). Fica contando os leads
// de propósito: apagar a unidade deles os deixaria órfãos, e avisar é o certo.
//
// ── POR QUE OS CAMPOS DO FUNIL FICAM ANINHADOS EM `lead` ───────────────
//
// `{ lead: { origem, etapa, ... } }` e não soltos no documento, por duas razões:
//
//   • não disputam nome com campo de pessoa (o `note` do aluno mora no VÍNCULO,
//     o do lead mora aqui);
//   • SOBREVIVEM à conversão. O aluno que veio do Instagram continua dizendo
//     isso para sempre — e aí "quantos alunos o anúncio me trouxe?" passa a ter
//     resposta, que é a pergunta que paga o anúncio.
const TIPO = "lead";

function Lead_model(app) {
  this.app = app;
}

Lead_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("users");
};

// Todo filtro daqui carrega o tipo. Numa coleção compartilhada, esquecer isto
// uma vez é devolver aluno na lista de leads — então ele não é escrito à mão em
// lugar nenhum: passa por aqui.
function soLeads(filtro = {}) {
  return { ...filtro, type: TIPO };
}

// ── O RECORTE DA LISTA, QUE NÃO É SÓ `type: "lead"` ──────────────────────
//
// Converter troca o tipo, então quem virou aluno SOME do funil — e a etapa
// "convertido" viraria um filtro que nunca devolve nada. Filtro morto na tela é
// pior que filtro ausente: a pessoa clica, vê vazio e conclui que o sistema
// perdeu os dados dela.
//
// Então a lista alcança duas coisas: quem ainda é lead, e quem FOI lead e já
// converteu (`lead.convertedAt` gravado). O segundo caso só entra quando a
// etapa "convertido" está sendo pedida — na fila de trabalho do dia a dia ele
// não aparece, que é o certo: quem converteu não é trabalho pendente.
function recorteDaLista(etapasPedidas) {
  const querConvertidos = etapasPedidas.includes("convertido");
  if (!querConvertidos) return { type: TIPO };

  return {
    $or: [{ type: TIPO }, { type: "student", "lead.convertedAt": { $exists: true } }],
  };
}

// ── O QUE É DA PESSOA E O QUE É DO FUNIL ─────────────────────────────────
//
// Em cima, os campos que o documento de pessoa JÁ tem: é o que faz a conversão
// não copiar nada. Embaixo, o que só o funil usa.
// ── OS MESMOS CAMPOS DA FICHA, COM OS MESMOS NOMES ──────────────────────
//
// *"faltou o sobrenome lá, e todos os campos que já tem em alunos"*
// (01/10/2026).
//
// Não é capricho de paridade: é o que faz a conversão não ter trabalho. Um
// campo que existisse aqui com OUTRO nome (ou que não existisse) teria de ser
// copiado ou pedido de novo no dia em que o lead virasse aluno — e "pedir de
// novo" é pedir à recepção que redigite o que a pessoa já respondeu.
//
// A normalização é a MESMA de `User_model.insertStudent`, de propósito: dois
// jeitos de guardar "feminino" ou dois jeitos de arredondar o peso seriam duas
// fichas diferentes para a mesma pessoa, dependendo de por onde ela entrou.
const SEXOS = ["female", "male"];

const CAMPOS_DA_PESSOA = {
  // `name` NÃO está aqui: ele é derivado de nome + sobrenome, e quem monta as
  // três chaves é `lib/nomeDaPessoa.js`. O lead carrega as três pelo mesmo
  // motivo que a pessoa — e porque converter não pode ter de montar nada.
  phone: (v) => String(v || "").trim().slice(0, 30),
  unit: (v) => (ObjectId.isValid(v) ? new ObjectId(String(v)) : null),
  birthDate: (v) => String(v || "").trim().slice(0, 10),
  sex: (v) => (SEXOS.includes(String(v)) ? String(v) : ""),
  goal: (v) => String(v || "").trim().slice(0, 240),
  // Vazio é `null` e não `0`: zero é um peso, e um lead sem peso informado
  // apareceria pesando nada no dia em que virasse ficha.
  weight: (v) => (v === undefined || v === "" || v === null ? null : Number(v)),
  height: (v) => (v === undefined || v === "" || v === null ? null : Number(v)),
};

const CAMPOS_DO_FUNIL = {
  // O WhatsApp é com frequência outro número — o comercial da recepção, o
  // pessoal de quem respondeu o anúncio. A ficha de pessoa não tem este campo,
  // então ele é do funil.
  whatsapp: (v) => String(v || "").trim().slice(0, 30),
  origem: (v) => funil.normalizarOrigem(v),
  etapa: (v) => funil.normalizarEtapa(v),
  // O QUE A PESSOA QUER, na linguagem dela: "emagrecer", "voltar a treinar",
  // "preço do trimestral". É o que faz a segunda conversa começar de onde a
  // primeira parou.
  interesse: (v) => String(v || "").trim().slice(0, 240),
  note: (v) => String(v || "").trim().slice(0, 2000),
  // QUANDO FALAR DE NOVO — o campo que transforma a lista em fila de trabalho.
  // Data pura: ninguém marca de ligar às 14h32.
  nextContactAt: (v) => dataOuNada(v),
};

// Data que o navegador manda como ISO ou `YYYY-MM-DD`. Lixo vira `null` em vez
// de `Invalid Date`: um `Invalid Date` gravado quebra toda leitura depois, e
// quem o gravou não vê erro nenhum na hora.
function dataOuNada(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// VAZIO VIRA `null`, e não `""` — é o que o índice único de e-mail exige. Ele é
// parcial (`$type: "string"`), então ausência não colide com ausência; `""`
// colidiria, e o segundo lead sem e-mail seria recusado pelo banco.
//
// A mesma função de `User_model`, e não um `require` dela: ela é privada lá.
function normalizarEmail(v) {
  const e = String(v == null ? "" : v).trim().toLowerCase();
  return e === "" ? null : e.slice(0, 140);
}

// Sem acento e em minúsculas: "ANA", "Ana" e "ana" são a mesma pessoa, e
// "jessica" tem de achar "Jéssica".
function chave(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Só dígitos: o telefone é digitado de seis jeitos — "(21) 98682-5831",
// "21986825831", "+55 21 98682 5831". Quem procura procura pelo número, não
// pela pontuação dele.
function digitos(v) {
  return String(v || "").replace(/\D+/g, "");
}

function montar(obj, { parcial = false, anterior = {} } = {}) {
  const set = {};

  for (const [campo, tratar] of Object.entries(CAMPOS_DA_PESSOA)) {
    if (parcial && obj[campo] === undefined) continue;
    set[campo] = tratar(obj[campo]);
  }

  // Nome, sobrenome e o `name` montado dos dois. `null` quer dizer "não veio
  // nome neste pedido", que num PATCH é diferente de "veio vazio".
  //
  // `anterior` é o que impede que editar só o sobrenome apague o nome — ver a
  // nota em `lib/nomeDaPessoa.js`, que nasceu de exatamente esse defeito.
  const nome = nomeDaPessoa.paraGravar(obj, anterior);
  if (nome) Object.assign(set, nome);

  if (!parcial || obj.email !== undefined) set.email = normalizarEmail(obj.email);

  for (const [campo, tratar] of Object.entries(CAMPOS_DO_FUNIL)) {
    if (parcial && obj[campo] === undefined) continue;
    // Caminho com ponto: num `$set` parcial isto muda UM campo do funil sem
    // apagar os outros. `{ lead: {...} }` inteiro substituiria o objeto.
    set["lead." + campo] = tratar(obj[campo]);
  }

  // Renomear sem reescrever `nameSort` deixaria a busca achando pelo nome
  // ANTIGO — e a lista ordenada por ele também.
  if (set.name !== undefined) set["lead.nameSort"] = chave(set.name);

  // O par de telefones vive num campo de busca só, então qualquer um dos dois
  // mudando obriga a reescrever o par inteiro — e para isso é preciso o valor
  // do OUTRO, que pode não ter vindo neste PATCH.
  if (set.phone !== undefined || set["lead.whatsapp"] !== undefined) {
    const phone = set.phone !== undefined ? set.phone : anterior.phone;
    const whatsapp =
      set["lead.whatsapp"] !== undefined ? set["lead.whatsapp"] : anterior.lead?.whatsapp;
    set["lead.phoneSort"] = digitos(phone) + " " + digitos(whatsapp);
  }

  return set;
}

// Do formato do banco para o da tela: o funil sobe um nível, e os ids viram
// texto. A tela não precisa saber onde cada campo mora.
Lead_model.prototype.paraTela = function (doc) {
  if (!doc) return doc;
  const { lead = {}, ...pessoa } = doc;

  return {
    _id: String(pessoa._id),
    name: pessoa.name,
    firstName: pessoa.firstName || "",
    lastName: pessoa.lastName || "",
    email: pessoa.email || "",
    phone: pessoa.phone || "",
    unit: pessoa.unit ? String(pessoa.unit) : null,
    birthDate: pessoa.birthDate || "",
    sex: pessoa.sex || "",
    goal: pessoa.goal || "",
    weight: pessoa.weight ?? "",
    height: pessoa.height ?? "",
    // `avatarAt` é o carimbo de quando a foto mudou — é ele que faz o navegador
    // buscar a imagem nova em vez de servir a do cache.
    avatarAt: pessoa.avatarAt || null,
    createdAt: pessoa.createdAt,
    whatsapp: lead.whatsapp || "",
    origem: lead.origem || funil.ORIGEM_PADRAO,
    etapa: lead.etapa || funil.ETAPA_PADRAO,
    interesse: lead.interesse || "",
    note: lead.note || "",
    nextContactAt: lead.nextContactAt || null,
  };
};

Lead_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne(soLeads({ _id: new ObjectId(String(id)) }))) || undefined;
};

Lead_model.prototype.insert = async function (obj) {
  const set = montar(obj);
  // Sem nome não há lead: a lista mostraria uma linha em branco, e ninguém
  // saberia para quem é o telefone.
  if (!set.name) return null;

  const doc = { type: TIPO, lead: {}, createdAt: new Date(), updatedAt: new Date() };
  for (const [caminho, valor] of Object.entries(set)) {
    if (caminho.startsWith("lead.")) doc.lead[caminho.slice(5)] = valor;
    else doc[caminho] = valor;
  }

  const col = await this.collection();
  const r = await col.insertOne(doc);
  return r.insertedId;
};

Lead_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const antes = await col.findOne(soLeads({ _id: new ObjectId(String(id)) }));
  if (!antes) return false;

  const set = montar(obj, { parcial: true, anterior: antes });
  if (set.name !== undefined && !set.name) return false;

  const r = await col.updateOne(soLeads({ _id: new ObjectId(String(id)) }), {
    $set: { ...set, updatedAt: new Date() },
  });

  return r.matchedCount > 0;
};

// ── CONVERTER: UMA CHAVE, E O DOCUMENTO NÃO SE MOVE ──────────────────────
//
// *"a ideia é converter o lead para aluno"* — e é aqui que a escolha da
// coleção se paga. Não há leitura de um lado e escrita do outro, não há `_id`
// novo, não há dois registros da mesma pessoa.
//
// O que muda:
//
//   `type`      lead → student        (a chave)
//   `role`      o papel de cliente    (quem entrar um dia precisa dele)
//   `active`    1                     (o campo não existe no lead)
//   `lead.convertedAt`                (quando virou, para o relatório)
//
// E o VÍNCULO é criado — é ele, e não o tipo, que põe a pessoa na lista de
// alguém. Sem ele a ficha existiria e não apareceria para ninguém.
//
// O resto do `lead` FICA. O aluno que veio do Instagram continua dizendo isso
// para sempre.
//
// ── QUEM CONFERE O TETO DO PLANO É O CONTROLLER ──────────────────────────
//
// Converter CRIA um aluno para efeito de cobrança, e por isso passa pelo mesmo
// teto de `POST /people`. A checagem não mora aqui porque ela responde HTTP
// (409 com a mensagem do plano) — ver `controllers/Lead.js`.
Lead_model.prototype.converter = async function (id, trainerId) {
  if (!ObjectId.isValid(id) || !ObjectId.isValid(trainerId)) return null;

  const col = await this.collection();
  const alvo = soLeads({ _id: new ObjectId(String(id)) });

  const lead = await col.findOne(alvo);
  if (!lead) return null;

  const papel = await this.app.api.role.dataByName(this.app.api.role.clientName);

  // ── A ÚNICA COISA QUE DE FATO SE COPIA ────────────────────────────────
  //
  // A ficha de pessoa tem UM telefone; o lead tem dois. Quem preencheu só o
  // WhatsApp — que no Brasil é a maioria — virava aluno sem telefone nenhum.
  // Descoberto convertendo de verdade em produção, não em teste.
  const telefone = lead.phone || lead.lead?.whatsapp || "";

  const r = await col.updateOne(alvo, {
    $set: {
      type: "student",
      phone: telefone,
      role: papel?._id ? new ObjectId(papel._id) : null,
      // Quem converteu também é quem cadastrou, para efeito de login futuro —
      // é o mesmo papel do `createdBy` de `insertStudent`.
      createdBy: new ObjectId(String(trainerId)),
      active: 1,
      password: lead.password || null,
      salt: lead.salt || null,
      "lead.etapa": "convertido",
      "lead.convertedAt": new Date(),
      updatedAt: new Date(),
    },
  });

  // Corrida: dois cliques no mesmo botão. O segundo não acha mais o documento
  // como lead e para aqui, sem criar um segundo vínculo.
  if (!r.matchedCount) return null;

  // É o VÍNCULO que põe a pessoa na lista — ver `User_model.pageStudents`.
  await this.app.api.link.link(trainerId, lead._id, "created");

  // ── A OBSERVAÇÃO MUDA DE LUGAR, PORQUE ELA MUDA DE DONO ────────────────
  //
  // No lead ela é do funil ("ligou duas vezes, quer treinar de manhã"); na
  // pessoa, "minhas observações" moram no VÍNCULO — são do profissional sobre
  // quem ele acompanha, e não da ficha. É a única coisa que a conversão
  // realmente move, e move porque a tela que a mostra depois lê de outro lugar.
  //
  // O original fica em `lead.note`: nada se perde, e o histórico do funil
  // continua inteiro.
  if (lead.lead?.note) {
    try {
      await this.app.api.link.setNotes(trainerId, String(lead._id), lead.lead.note);
    } catch (erro) {
      // Observação é acessório. Uma conversão que falha por causa dela deixaria
      // a pessoa com tipo trocado, vínculo criado e um erro na tela.
      console.error("[lead] observação no vínculo:", erro.message);
    }
  }

  return lead._id;
};

Lead_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  // `soLeads` também protege aqui, e é o filtro mais importante do arquivo:
  // sem ele, um id de ALUNO chegando nesta rota apagaria a ficha dele.
  const r = await col.deleteOne(soLeads({ _id: new ObjectId(String(id)) }));
  return r.deletedCount > 0;
};

const ORDEM_DOS_LEADS = {
  nome: "lead.nameSort",
  origem: "lead.origem",
  etapa: "etapaOrdem",
  retorno: "lead.nextContactAt",
  criado: "createdAt",
};

// ── A PÁGINA DA LISTA ─────────────────────────────────────────────────────
//
// Busca, ordem e corte no BANCO, como nas outras listas da casa: ordenar as
// quinze linhas que chegaram dá a ordem DAS QUINZE, e buscar dentro delas acha
// "Ana" entre as carregadas e diz que não existe mais nenhuma.
Lead_model.prototype.pagina = async function ({
  busca,
  etapas,
  origens,
  ordem,
  direcao,
  pagina,
  limite,
  ids,
  unit,
  units,
  semUnidade,
  exportando,
} = {}) {
  const col = await this.collection();

  const pedidas = funil.etapasPedidas(etapas);

  // O TIPO NA PRIMEIRA ETAPA, sempre. Ele é o que separa esta lista das fichas
  // de aluno na mesma coleção, e tem de cortar antes de qualquer outra coisa —
  // por correção e porque é o índice que o banco usa.
  const etapasPipeline = [{ $match: recorteDaLista(pedidas) }];

  const escolhidos = recorteDeIds(ids);
  if (escolhidos) etapasPipeline.push({ $match: { _id: { $in: escolhidos } } });

  const termo = String(busca || "").trim();
  if (termo) {
    const esc = chave(termo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const numero = digitos(termo);

    etapasPipeline.push({
      $match: {
        $or: [
          { "lead.nameSort": { $regex: esc } },
          { email: { $regex: esc, $options: "i" } },
          { "lead.interesse": { $regex: esc, $options: "i" } },
          // O telefone só entra quando o termo TEM dígito: sem esta guarda,
          // `digitos("ana")` é string vazia e o `$regex` vazio casa com tudo —
          // a busca devolveria a base inteira para qualquer palavra.
          ...(numero ? [{ "lead.phoneSort": { $regex: numero } }] : []),
        ],
      },
    });
  }

  if (pedidas.length) etapasPipeline.push({ $match: { "lead.etapa": { $in: pedidas } } });

  const origensPedidas = funil.origensPedidas(origens);
  if (origensPedidas.length) {
    etapasPipeline.push({ $match: { "lead.origem": { $in: origensPedidas } } });
  }

  // A UNIDADE: lente quando ela escolhe, cerca quando ela é restrita. O que não
  // tem unidade continua aparecendo — é da casa, não de outra unidade. Ver
  // `lib/lenteDeUnidade.js`.
  if (semUnidade) etapasPipeline.push({ $match: { unit: null } });
  else if (ObjectId.isValid(unit)) {
    etapasPipeline.push({ $match: { unit: new ObjectId(String(unit)) } });
  }

  const cerca = lenteDeUnidade.filtroDeUnidades(units);
  if (cerca) etapasPipeline.push({ $match: cerca });

  // A ORDEM DO FUNIL, e não a alfabética do id: ordenar por `etapa` como texto
  // poria "convertido" antes de "novo", que não é ordem nenhuma. O número vem
  // do catálogo (`lib/funilDeLeads.js`), que é quem sabe a sequência.
  etapasPipeline.push({
    $addFields: {
      etapaOrdem: {
        $switch: {
          branches: funil.ETAPAS.map((e) => ({
            case: { $eq: ["$lead.etapa", e.id] },
            then: e.ordem,
          })),
          default: 99,
        },
      },
    },
  });

  const campo = ORDEM_DOS_LEADS[ordem] || "createdAt";
  const sentido = String(direcao) === "desc" ? -1 : 1;
  // Sem ordem pedida, o mais NOVO primeiro: a lista existe para trabalhar quem
  // chegou, e quem chegou hoje é o que esfria mais rápido.
  const sort = ordem
    ? campo === "lead.nameSort"
      ? { "lead.nameSort": sentido }
      : { [campo]: sentido, "lead.nameSort": 1 }
    : { createdAt: -1 };

  const porPagina = tetoPorPagina(limite, { padrao: 15, maximo: 200, exportando });
  const pular = Math.max((Number(pagina) || 1) - 1, 0) * porPagina;

  const [saida] = await col
    .aggregate([
      ...etapasPipeline,
      {
        $facet: {
          rows: [{ $sort: sort }, { $skip: pular }, { $limit: porPagina }],
          total: [{ $count: "n" }],
          // QUANTOS EM CADA ETAPA, no mesmo recorte da busca — mas ANTES do
          // corte de página. É o que deixa a tela dizer "12 novos, 3 em
          // contato" sem uma segunda ida ao banco, e sem contar só os quinze
          // que couberam na página.
          porEtapa: [{ $group: { _id: "$lead.etapa", n: { $sum: 1 } } }],
        },
      },
    ])
    .toArray();

  const porEtapa = {};
  for (const linha of saida?.porEtapa || []) porEtapa[linha._id] = linha.n;

  return {
    rows: (saida?.rows || []).map((d) => this.paraTela(d)),
    total: saida?.total?.[0]?.n || 0,
    porEtapa,
    pagina: Math.floor(pular / porPagina) + 1,
    porPagina,
  };
};

module.exports = Lead_model;
