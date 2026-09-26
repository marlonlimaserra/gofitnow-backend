const { ObjectId } = require("mongodb");
const tetos = require("../lib/tetosEstruturais.js");
const { weekdaysOf } = require("../lib/weekdays.js");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");

// Os planos alimentares, com as refeições dentro.
//
//   diets → um plano: nome, período, e as refeições do dia
//
// Mesma forma dos treinos, e de propósito: quem já entendeu "um treino tem
// exercícios dentro do documento" entende este sem aprender nada novo. As
// refeições nunca são lidas sem o plano, são poucas (cinco, seis por dia) e
// separá-las numa collection só acrescentaria um join em toda abertura de tela.
//
// A diferença para o treino é o TEMPO: um treino tem dias da semana, um plano
// alimentar tem horários. As refeições ficam ordenadas por horário — é assim que
// o dia acontece, e é assim que a pessoa lê.
//
// Cada alimento guarda uma CÓPIA do nome e dos valores nutricionais, não só o id
// do catálogo. É a mesma decisão dos exercícios dentro do treino: se o alimento
// sair do catálogo, ou se a tabela for corrigida amanhã, o plano que já foi
// entregue continua dizendo o que dizia no dia em que foi montado.
function Diet_model(app) {
  this.app = app;
}

Diet_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("diets");
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function statusOf(d) {
  const hoje = today();
  if (d.endDate && d.endDate < hoje) return "past";
  if (d.startDate && d.startDate > hoje) return "future";
  return "current";
}

Diet_model.prototype.statusOf = statusOf;

function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// O que um alimento dentro de uma refeição carrega.
//
// `quantity` é sempre na unidade de `unit`. Os valores nutricionais chegam JÁ
// CALCULADOS para essa quantidade — quem faz a regra de três é a tela, no
// momento em que a pessoa escolhe, porque é lá que ela vê o número mudar. O
// servidor guarda o que foi combinado, não recalcula: recalcular amanhã, com uma
// tabela corrigida, mudaria um plano que já foi impresso e entregue.
// `group` junta alimentos ALTERNATIVOS: "pão de forma OU tapioca". Os que
// compartilham o número são opções da mesma escolha; números diferentes somam.
//
// Um número e não uma lista aninhada porque isto é acrescentado a um formato que
// já existe: refeição gravada antes desta ideia tem `group` ausente, e cada
// alimento dela continua valendo por si — nenhuma migração, nenhum plano
// reinterpretado.
function limparAlimento(a, i) {
  return {
    foodId: ObjectId.isValid(a.foodId) ? new ObjectId(a.foodId) : null,
    name: String(a.name || "").trim(),
    quantity: numeroOuNulo(a.quantity),
    unit: String(a.unit || "g").trim().slice(0, 12),
    // A CHAVE DA FOTO, copiada do catálogo no momento em que o alimento entrou.
    //
    // Copiada, e não buscada na hora de mostrar: a lista de uma refeição tem
    // dez linhas e a dieta tem seis refeições — sessenta consultas ao catálogo
    // para desenhar uma tela que já tem tudo o que precisa.
    //
    // Ela também não se deduz do nome. "Abacate cru" usa a foto de chave
    // `abacate`, herdada pelo casamento automático; derivar o slug daria
    // `abacate-cru`, que não existe.
    //
    // Só o slug: é o que vai numa URL pública, e o que vier fora do formato não
    // aponta para foto nenhuma.
    imageKey: String(a.imageKey || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 80),
    kcal: numeroOuNulo(a.kcal),
    protein: numeroOuNulo(a.protein),
    carbs: numeroOuNulo(a.carbs),
    fat: numeroOuNulo(a.fat),
    group: Number.isInteger(Number(a.group)) && Number(a.group) >= 0 ? Number(a.group) : null,
    order: i,
  };
}

// A refeição: horário, nome, alimentos e a observação que a pessoa lê no app.
function limparRefeicao(r, i) {
  return {
    // Um id próprio para a tela poder editar e reordenar sem depender da
    // posição no array — posição muda, id não.
    _id: ObjectId.isValid(r._id) ? new ObjectId(r._id) : new ObjectId(),
    // "HH:MM". Guardado como texto porque é hora do DIA, não um instante: as
    // 07:00 da segunda e as 07:00 da terça são a mesma refeição.
    time: /^\d{2}:\d{2}$/.test(String(r.time || "")) ? String(r.time) : "",
    name: String(r.name || "").trim(),
    note: r.note ? String(r.note).trim() : "",
    // O TETO ABSOLUTO DE ALIMENTOS, aplicado onde toda refeição passa.
    //
    // A rota já recusa com 409 antes de chegar aqui (ver controllers/Diet.js), e
    // esta linha é a rede embaixo: `limparRefeicao` é o funil ÚNICO das dietas e
    // dos modelos de dieta, e uma rota nova amanhã pode esquecer de checar.
    //
    // Corta em silêncio porque esta é uma função pura, sem `res` para responder
    // — e cortar é melhor que estourar, que derrubaria a gravação inteira de
    // quem trouxe 101 alimentos numa importação.
    foods: tetos.cortar(r.foods || [], "foodsPerMeal").map(limparAlimento),
    order: i,
  };
}

// Só a PRIMEIRA opção de cada grupo entra na conta.
//
// "Pão de forma ou tapioca" é uma escolha, não duas refeições: somar as duas
// diria que a pessoa come as duas, e o total do dia ficaria inflado. A primeira
// é a referência porque é a que o profissional listou primeiro — e é o que ele
// vê no topo quando confere as calorias.
//
// Alimento sem grupo vale por si: é o caso de tudo que foi gravado antes de
// existir substituição, e do prato comum que não tem alternativa.
function principais(foods) {
  const vistos = new Set();

  return (foods || []).filter((f, i) => {
    const chave = f.group === null || f.group === undefined ? `solo-${i}` : `grupo-${f.group}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

// A soma de uma refeição e a do plano inteiro.
//
// Calculadas na LEITURA, e não guardadas: são derivadas dos alimentos, e um
// total gravado é um total que pode discordar da lista logo abaixo dele.
//
// `null` quando NENHUM alimento tem o valor, e não zero: um plano montado só com
// receitas caseiras sem rótulo mostraria "0 kcal", que é falso — o certo é a
// tela não mostrar número nenhum.
function somar(itens) {
  const total = { kcal: null, protein: null, carbs: null, fat: null };

  for (const item of itens) {
    for (const campo of Object.keys(total)) {
      if (typeof item[campo] === "number") {
        total[campo] = (total[campo] || 0) + item[campo];
      }
    }
  }

  // Arredondado na saída: somar 33,33 três vezes não pode virar 99,99000000001
  // na tela.
  for (const campo of Object.keys(total)) {
    if (total[campo] !== null) total[campo] = Math.round(total[campo] * 10) / 10;
  }

  return total;
}

function comTotais(doc) {
  const meals = (doc.meals || [])
    .map((m) => ({ ...m, totals: somar(principais(m.foods)) }))
    // Ordenadas pelo HORÁRIO, que é como o dia acontece. Refeição sem horário
    // vai para o fim: ela não sabe onde entrar no dia.
    .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));

  return {
    ...doc,
    meals,
    status: statusOf(doc),
    mealCount: meals.length,
    foodCount: meals.reduce((t, m) => t + (m.foods || []).length, 0),
    totals: somar(meals.flatMap((m) => principais(m.foods))),
  };
}

// ── AS ORDENS QUE O BANCO SABE FAZER ──────────────────────────────────────
//
// Caloria NÃO está aqui, e a ausência é decisão — a mesma que a lista de
// avaliações tomou com o percentual de gordura.
//
// O total de um plano depende da regra de substituição ("pão OU tapioca" conta
// uma vez só), e essa regra mora em `principais()`, logo abaixo em JavaScript.
// Reescrevê-la em `$reduce` para poder ordenar seria manter duas versões da
// mesma matemática, e um dia elas discordariam — em silêncio, num número que
// ninguém confere. Ordenar só a página seria pior ainda: a tela diria "os mais
// calóricos" quando são "os mais calóricos entre estes doze".
const ORDEM_DIETAS = {
  date: "createdAt",
  person: "personName",
  start: "startDate",
  meals: "mealCount",
  name: "name",
};

// ── VIGENTE, FUTURO, ENCERRADO ────────────────────────────────────────────
//
// A mesma conta do `statusOf` acima, escrita em consulta. As datas são texto
// "AAAA-MM-DD", e é por isso que comparar com `<` funciona: nesse formato a
// ordem alfabética É a ordem do tempo.
//
// O `$gt: ""` em `endDate` não é enfeite. Plano sem data de fim guarda string
// VAZIA, e "" é menor que qualquer data — sem esse teste, todo plano em aberto
// (que é o caso mais comum) apareceria como encerrado.
function filtroDeStatus(status, hoje) {
  const encerrado = { endDate: { $gt: "", $lt: hoje } };
  const futuro = { startDate: { $gt: hoje } };

  if (status === "past") return encerrado;
  if (status === "future") return futuro;
  if (status === "current") return { $nor: [encerrado, futuro] };
  return null;
}

// A tela "Dietas": os últimos planos deste profissional, de TODAS as pessoas.
//
// Irmã de "Treinos" e de "Avaliações", e existe pela mesma razão: dentro da
// ficha não há como ver que metade dos planos da casa venceu no mês passado. A
// da ficha responde "o que esta pessoa come"; esta responde "o que eu montei, e
// o que ainda está valendo".
//
// ── AS REFEIÇÕES NÃO VÊM ──────────────────────────────────────────────────
//
// Um plano carrega as refeições dentro, e cada alimento traz uma cópia do nome e
// da tabela nutricional. Doze planos completos são centenas de kilobytes para
// desenhar doze cartões que mostram quatro números cada.
//
// Então elas são lidas, viram TOTAIS aqui dentro, e são descartadas antes de
// sair. Quem quer a lista de alimentos abre o plano.
// A consulta, sozinha. Separada porque a listagem e a contagem por situação
// precisam EXATAMENTE dos mesmos filtros — e duas cópias divergiriam no dia em
// que um filtro novo entrasse só numa delas.
Diet_model.prototype.consultaDe = async function (trainerId, filtros = {}) {
  const consulta = { trainer: new ObjectId(trainerId) };

  const status = filtroDeStatus(filtros.status, today());
  if (status) Object.assign(consulta, status);

  if (filtros.studentId && ObjectId.isValid(String(filtros.studentId))) {
    consulta.student = new ObjectId(String(filtros.studentId));
  }

  // ── A LENTE DA UNIDADE ──────────────────────────────────────────────────
  //
  // *"treinos também: troquei de unidade e está igual"* — e vale para os
  // planos alimentares pelo mesmo motivo. O plano não tem unidade: quem tem é
  // a PESSOA dele.
  //
  // Aqui a tradução é para IDS DE PESSOA, e não um `$lookup` como no treino:
  // esta consulta serve a lista E as contagens das abas, e as contagens são
  // `countDocuments`, que não junta coleção. Um caminho só é o que garante que
  // a aba e a lista concordem — duas regras separadas divergiriam no primeiro
  // ajuste, e a aba passaria a contar a casa inteira.
  //
  // Sem teto, ao contrário da busca por nome: lá o teto existe porque "a" não
  // é uma busca; aqui a unidade inteira é exatamente o que foi pedido.
  // ── A LENTE, E A CERCA ────────────────────────────────────────────────
  //
  // `unit` é a lente escolhida no topo; `units` é a CERCA de quem só alcança
  // algumas (26/09/2026). As duas cortam pelas PESSOAS daquela unidade, e por
  // isso passam pela mesma consulta. Ver `lib/lenteDeUnidade.js`.
  const cerca = lenteDeUnidade.filtroDeUnidades(filtros.units);

  if (ObjectId.isValid(String(filtros.unit || "")) || cerca) {
    const users = await this.app.api.user.collection();
    const quais = cerca || { unit: new ObjectId(String(filtros.unit)) };
    const daUnidade = await users.find(quais, { projection: { _id: 1 } }).toArray();

    consulta.student = { $in: daUnidade.map((p) => p._id) };
  }

  // A busca é pelo nome da PESSOA e pelo nome do PLANO — as duas coisas que
  // alguém digita procurando um plano. Só por pessoa deixaria "Low carb" sem
  // resposta, e é assim que o profissional chama o que ele montou.
  const termo = String(filtros.search || "").trim();
  if (termo) {
    const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await this.app.api.user.collection();

    // Teto de 500 para o caso patológico ("a", numa conta com milhares). Uma
    // busca por uma letra não é uma busca.
    const pessoas = await users
      .find({ name: { $regex: escapado, $options: "i" } }, { projection: { _id: 1 }, limit: 500 })
      .toArray();

    const porPessoa = pessoas.length ? [{ student: { $in: pessoas.map((p) => p._id) } }] : [];
    consulta.$and = [{ $or: [...porPessoa, { name: { $regex: escapado, $options: "i" } }] }];
  }

  return consulta;
};

Diet_model.prototype.pageAll = async function (trainerId, filtros = {}) {
  const col = await this.collection();

  const limite = Math.min(Math.max(Number(filtros.limit) || 20, 1), 100);
  const pagina = Math.max(Number(filtros.page) || 1, 1);
  const campo = ORDEM_DIETAS[filtros.sort] || "createdAt";
  const direcao = filtros.dir === "asc" ? 1 : -1;

  const consulta = await this.consultaDe(trainerId, filtros);

  const total = await col.countDocuments(consulta);

  // Antes do corte fica só o que decide QUAIS doze linhas são; o nome da pessoa
  // vem depois, numa junção sobre doze documentos e não sobre os trezentos
  // planos da conta. Mesma lição das outras duas listas.
  const juntarPessoa = [
    // Sem sub-pipeline de propósito: `localField/foreignField` com `pipeline`
    // junto desliga a junção indexada do Mongo. O preço é o documento inteiro da
    // pessoa entrar em `pessoa` — inclusive senha e salt —, e por isso ele é
    // DESCARTADO no `$project` do fim. Tirar aquele `pessoa: 0` vaza hash de
    // senha para a tela.
    { $lookup: { from: "users", localField: "student", foreignField: "_id", as: "pessoa" } },
    {
      $addFields: {
        personName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
        personAvatarAt: { $arrayElemAt: ["$pessoa.avatarAt", 0] },
        // A UNIDADE da pessoa — o ID, não o nome: a tela já tem a lista de
        // unidades (é a mesma da lente) e resolve o nome sem uma segunda
        // junção aqui. *"quando tiver todos, mostre ali de qual unidade
        // pertence"*.
        personUnit: { $arrayElemAt: ["$pessoa.unit", 0] },
      },
    },
  ];

  const etapas = [
    { $match: consulta },
    { $addFields: { mealCount: { $size: { $ifNull: ["$meals", []] } } } },
  ];

  // Ordenar pelo NOME da pessoa é o único caso em que a junção precisa vir
  // antes: não dá para escolher as doze primeiras por um campo que ainda não
  // existe.
  const ordenaPorPessoa = campo === "personName";
  if (ordenaPorPessoa) etapas.push(...juntarPessoa);

  // Linha sem o campo vai para o FIM, ordenando para qualquer lado. Um plano sem
  // data de início encabeçando "os que começam antes" seria a tela dizendo que
  // ele começa primeiro que todos.
  etapas.push(
    { $addFields: { __vazio: { $cond: [{ $in: [`$${campo}`, [null, ""]] }, 1, 0] } } },
    { $sort: { __vazio: 1, [campo]: direcao, _id: -1 } },
    { $skip: (pagina - 1) * limite },
    { $limit: limite }
  );

  if (!ordenaPorPessoa) etapas.push(...juntarPessoa);

  etapas.push({ $project: { pessoa: 0, __vazio: 0 } });

  const docs = await col.aggregate(etapas).toArray();

  return {
    total,
    rows: docs.map(({ personName, personAvatarAt, personUnit, ...doc }) => {
      // `comTotais` é quem sabe somar respeitando as substituições. Chamado aqui
      // sobre doze documentos, e o resultado sai SEM as refeições.
      const { meals, ...resto } = comTotais(doc);

      return {
        ...resto,
        student: {
          _id: doc.student,
          name: personName || "",
          avatarAt: personAvatarAt || null,
          unit: personUnit || null,
        },
      };
    }),
  };
};

// QUANTOS EM CADA SITUAÇÃO — para os botões do filtro dizerem o número.
//
// Recebe os MESMOS filtros da listagem menos o status, porque é isso que os
// botões precisam significar: "dos que casam com a busca, quantos estão
// valendo". Contar sobre a base inteira faria o número mudar sozinho quando
// alguém digitasse na busca, e não bater com a lista logo abaixo.
Diet_model.prototype.contarPorStatus = async function (trainerId, filtros = {}) {
  const col = await this.collection();
  const hoje = today();

  const base = await this.consultaDe(trainerId, { ...filtros, status: "" });

  const [current, past, future, all] = await Promise.all([
    col.countDocuments({ ...base, ...filtroDeStatus("current", hoje) }),
    col.countDocuments({ ...base, ...filtroDeStatus("past", hoje) }),
    col.countDocuments({ ...base, ...filtroDeStatus("future", hoje) }),
    col.countDocuments(base),
  ]);

  return { current, past, future, all };
};

Diet_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.collection();

  const docs = await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .sort({ createdAt: -1 })
    .toArray();

  return docs.map(comTotais);
};

// A visão da própria pessoa: os planos DELA, de qualquer profissional. Ver o
// comentário em Workout_model.listOfStudent — é a mesma regra, pelo mesmo motivo.
Diet_model.prototype.listOfStudent = async function (studentId) {
  const col = await this.collection();

  const docs = await col
    .find({ student: new ObjectId(studentId) })
    .sort({ createdAt: -1 })
    .toArray();

  return docs.map(comTotais);
};

Diet_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc ? comTotais(doc) : undefined;
};

Diet_model.prototype.insert = async function (trainerId, studentId, obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    name: String(obj.name).trim(),
    goal: obj.goal ? String(obj.goal).trim() : "",
    startDate: obj.startDate ? String(obj.startDate) : "",
    endDate: obj.endDate ? String(obj.endDate) : "",
    note: obj.note ? String(obj.note).trim() : "",
    // Em que dias este plano vale. Serve para o caso mais comum de quem monta
    // dieta: um plano para dia de treino e outro para dia de descanso.
    weekdays: weekdaysOf(obj.weekdays),
    // A meta diária que o profissional definiu, se definiu. Fica no plano e não
    // na pessoa: quem está em cutting hoje pode estar em bulking em três meses,
    // e o plano antigo tem de continuar contando a história dele.
    targetKcal: numeroOuNulo(obj.targetKcal),
    targetProtein: numeroOuNulo(obj.targetProtein),
    targetCarbs: numeroOuNulo(obj.targetCarbs),
    targetFat: numeroOuNulo(obj.targetFat),
    // Nasce vazio em vez de sem o campo: a tela abre direto nas refeições, e
    // `undefined` obrigaria toda leitura a se defender.
    meals: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Diet_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };
  if (obj.name !== undefined) set.name = String(obj.name).trim();
  if (obj.goal !== undefined) set.goal = String(obj.goal).trim();
  if (obj.startDate !== undefined) set.startDate = String(obj.startDate);
  if (obj.endDate !== undefined) set.endDate = String(obj.endDate);
  if (obj.note !== undefined) set.note = String(obj.note).trim();
  if (obj.weekdays !== undefined) set.weekdays = weekdaysOf(obj.weekdays);
  for (const campo of ["targetKcal", "targetProtein", "targetCarbs", "targetFat"]) {
    if (obj[campo] !== undefined) set[campo] = numeroOuNulo(obj[campo]);
  }

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: set }
  );
  return r.matchedCount > 0;
};

Diet_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Salva a lista INTEIRA de refeições de uma vez.
//
// Mesma escolha do `saveExercises` do treino: a tela edita tudo junto e salva
// uma vez, e atualizar refeição a refeição exigiria uma rota por operação sem
// ganho nenhum.
Diet_model.prototype.saveMeals = async function (trainerId, id, meals) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  // O teto de REFEIÇÕES vem junto: 9.999 refeições de um alimento cada dão o
  // mesmo documento gigante que 9.999 alimentos numa refeição, e limitar uma
  // ponta deixando a outra aberta é não ter limitado. Este não tem chave no
  // plano — é teto duro (ver lib/tetosEstruturais.js).
  const limpas = tetos.cortar(meals || [], "mealsPerDiet").map(limparRefeicao);

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: { meals: limpas, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

// Todos os planos da pessoa, apagados junto com ela.
Diet_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;
  const col = await this.collection();

  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount || 0;
};

module.exports = Diet_model;

// Os saneadores das REFEIÇÕES, exportados para o template de dieta.
//
// Exportados, e não copiados: o template guarda refeições com a mesma forma do
// plano — é o ponto dele —, e duas versões de `limparRefeicao` divergiriam no
// primeiro campo novo. O que acontecesse no plano e não no template apareceria
// como alimento perdendo a foto, ou grupo de substituição virando alimento solto,
// só nos planos criados a partir de template.
module.exports.limparRefeicao = limparRefeicao;
module.exports.limparAlimento = limparAlimento;
module.exports.numeroOuNulo = numeroOuNulo;
