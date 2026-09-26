const { ObjectId } = require("mongodb");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");

// As avaliações físicas de uma pessoa.
//
//   assessments → uma coleta: data, peso, dobras, circunferências, bioimpedância
//
// Cada documento é uma FOTOGRAFIA de um dia. Nada aqui é atualizado com o tempo:
// a avaliação de janeiro continua dizendo o que dizia em janeiro, e é a
// sequência delas que conta a história.
//
// Os grupos de medida são objetos separados — `skinfolds`, `circumferences`,
// `bioimpedance`, `tests` — e não campos soltos no documento. São quarenta e
// poucos números, e agrupá-los é o que permite a tela ligar e desligar uma seção
// inteira sem saber o nome de cada um.
//
// O que NÃO é guardado: IMC, percentual de gordura, RCQ, massa magra. Todos são
// derivados do que está aqui, e um valor calculado gravado é um valor que pode
// discordar dos dados logo ao lado — basta corrigir uma dobra depois. Quem
// calcula é a tela, com as fórmulas em views/student/assessments/calculos.js.
//
// A exceção é a BIOIMPEDÂNCIA: aqueles números não são calculados por ninguém,
// são lidos de um aparelho e digitados. Por isso ela é dado, não derivação.
function Assessment_model(app) {
  this.app = app;
}

Assessment_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("assessments");
};

// Número que pode faltar, e faltar é o normal: quase nenhuma avaliação preenche
// os quarenta campos. Zero mentiria — "0 cm de cintura" não é uma medida, é a
// ausência dela.
function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function alturaEmMetros(valor) {
  const n = numeroOuNulo(valor);
  if (n === null) return null;

  return n > 3 ? Math.round((n / 100) * 100) / 100 : n;
}

// Os campos aceitos em cada grupo.
//
// Lista fechada de propósito: o corpo do pedido vem do navegador, e sem
// whitelist qualquer chave entraria no documento. Acrescentar uma medida nova é
// acrescentar uma linha aqui.
const DOBRAS = [
  "biceps",
  "subscapular",
  "triceps",
  "chest",
  "midaxillary",
  "suprailiac",
  "abdominal",
  "thigh",
  "calf",
];

// Weltman mede o abdômen em DOIS pontos e usa a média dos dois. Ficam fora de
// `circumferences` de propósito: lá o abdômen é uma medida de acompanhamento,
// aqui são os dois sítios anatômicos de um protocolo — misturá-los faria a
// tela de circunferências pedir uma medida que só o Weltman usa.
const WELTMAN = ["abdomen1", "abdomen2"];

// Como o percentual de gordura desta coleta foi obtido. Um só, nunca dois: os
// três métodos discordam entre si o bastante para que combiná-los produza um
// número que nenhum deles sustenta.
const METODOS = ["skinfolds", "bioimpedance", "weltman"];

// Qual equação de dobras. Guardada junto da coleta, e não escolhida na leitura,
// porque trocar o protocolo depois mudaria um resultado já entregue à pessoa.
const PROTOCOLOS = [
  "pollock3",
  "guedes3",
  "durnin4",
  "faulkner4",
  "petroski4",
  "pollock7",
];

const CIRCUNFERENCIAS = [
  "neck",
  "chest",
  "waist",
  "abdomen",
  "hip",
  "shoulder",
  "forearmRight",
  "forearmLeft",
  "armRightRelaxed",
  "armLeftRelaxed",
  "armRightFlexed",
  "armLeftFlexed",
  "thighRight",
  "thighLeft",
  "calfRight",
  "calfLeft",
];

const BIOIMPEDANCIA = [
  "muscleMass",
  "musclePercent",
  "skeletalMusclePercent",
  "boneMass",
  "fatMass",
  "fatPercent",
  "waterMass",
  "waterPercent",
  "leanMass",
  // Peso residual: o que sobra tirando gordura, músculo, osso e água — vísceras
  // e tecido conjuntivo. Alguns aparelhos mostram, e sem campo aqui esse número
  // seria digitado em "observação", onde nenhuma conta o alcança.
  "residualMass",
  "protein",
  "minerals",
  "bmi",
  "visceralFatMass",
  "visceralFatPercent",
  "bmr",
  "bodyAge",
];

const TESTES = ["situps", "pushups", "cooper", "tugt", "sitStand", "flexibility"];

function grupo(campos, origem) {
  const saida = {};
  for (const campo of campos) saida[campo] = numeroOuNulo(origem?.[campo]);
  return saida;
}

// Um grupo inteiro vazio vira `null` em vez de um objeto com dezesseis nulos.
//
// É a diferença entre "mediu e não achou nada" e "não mediu". A tela usa isso
// para não desenhar a seção de bioimpedância de quem nunca usou balança.
function grupoOuNulo(campos, origem) {
  const valores = grupo(campos, origem);
  return Object.values(valores).some((v) => v !== null) ? valores : null;
}

// O que uma coleta grava a partir do corpo do pedido.
//
// As FOTOS não estão aqui, e é de propósito: elas têm rotas próprias e vivem em
// `assessment_photos`. Se entrassem, o salvamento automático — que manda o
// formulário inteiro a cada campo digitado, e o formulário não carrega imagem —
// apagaria as quatro fotos a cada tecla.
function limpar(obj) {
  return {
    // A data da COLETA, escolhida por quem mede — não a de gravação. Uma
    // avaliação pode ser lançada dias depois de feita, e o gráfico tem de
    // mostrá-la onde ela aconteceu.
    date: obj.date ? new Date(obj.date) : new Date(),
    // Por quantos dias o resultado vale, se o profissional definir. É o que
    // permite avisar que está na hora de reavaliar.
    validityDays: numeroOuNulo(obj.validityDays),

    weight: numeroOuNulo(obj.weight),
    // Em METROS, como o resto do sistema — mesmo quando chega em centímetros.
    //
    // O campo mostra "m" e mesmo assim se digita 175: é o número que a pessoa
    // sabe de cor. Converter aqui, na entrada, evita a dúvida de "1,75 ou 175?"
    // espalhada por cada conta que usa altura. Não há ambiguidade: gente mede
    // entre 0,5 e 2,5 m, ou entre 50 e 250 cm, e as faixas não se encostam.
    height: alturaEmMetros(obj.height),

    method: METODOS.includes(obj.method) ? obj.method : "skinfolds",
    protocol: PROTOCOLOS.includes(obj.protocol) ? obj.protocol : "pollock3",

    skinfolds: grupoOuNulo(DOBRAS, obj.skinfolds),
    weltman: grupoOuNulo(WELTMAN, obj.weltman),
    circumferences: grupoOuNulo(CIRCUNFERENCIAS, obj.circumferences),
    bioimpedance: grupoOuNulo(BIOIMPEDANCIA, obj.bioimpedance),
    tests: grupoOuNulo(TESTES, obj.tests),

    // Rascunho: a coleta existe no banco desde o primeiro clique, e vai sendo
    // gravada campo a campo enquanto se digita.
    //
    // São quarenta e tantos números medidos com a pessoa na frente, e perder
    // isso por uma queda de luz significa medir tudo de novo. O preço é este
    // campo: enquanto for rascunho, a coleta não entra nos cartões nem no
    // comparativo — meia avaliação distorceria a comparação em vez de informá-la.
    draft: obj.draft !== false,

    note: obj.note ? String(obj.note).trim() : "",
  };
}

// Da mais NOVA para a mais antiga: a pergunta usual é "como ele está agora", e a
// resposta é a primeira linha.
Assessment_model.prototype.list = async function (trainerId, studentId) {
  const col = await this.collection();

  return await col
    .find({ trainer: new ObjectId(trainerId), student: new ObjectId(studentId) })
    .sort({ date: -1 })
    .toArray();
};

// ── TODAS AS COLETAS DO PROFISSIONAL, de todas as pessoas ──────────────────
//
// A tela "Avaliações" (`/avaliacoes`), irmã de "Treinos": ela não responde "como
// esta pessoa está", responde "quem eu avaliei ultimamente". São perguntas
// diferentes, e por isso são telas diferentes — dentro da ficha não há como ver
// que faz seis meses que ninguém é medido.
//
// ── O NOME DA PESSOA VEM JUNTO ─────────────────────────────────────────────
//
// Fora da ficha, uma linha com "82,4 kg" não identifica ninguém. Junto do nome
// vão `sex` e `birthDate`, porque quem calcula gordura e IMC é a TELA (as
// fórmulas de dobras dependem de idade e sexo, e elas moram no front, onde o
// formulário as usa ao vivo). Sem os dois, a coluna de gordura viria vazia sem
// explicar por quê.
//
// ── RASCUNHO NÃO ENTRA ─────────────────────────────────────────────────────
//
// A mesma regra do resto do produto: até o "salvar medida" a coleta é um
// formulário aberto, não uma avaliação. Ela já aparece com destaque na ficha da
// pessoa, que é onde alguém pode terminá-la.
//
// ── A BUSCA NÃO ARRASTA A JUNÇÃO PARA ANTES DO CORTE ───────────────────────
//
// O único texto que se busca aqui é o NOME da pessoa, que mora em outra
// collection. Juntar para depois filtrar faria a junção rodar sobre todas as
// coletas da conta para jogar vinte fora — o mesmo erro que a tela de treinos
// já pagou e corrigiu. Então o termo vira uma lista de ids ANTES, e o
// `$match` continua sendo o do índice.

// As colunas por onde a tela ordena → o campo do banco.
//
// GORDURA NÃO ESTÁ AQUI, e é a ausência mais importante: o percentual depende do
// protocolo escolhido na coleta (sete deles), da idade e do sexo, e essas
// fórmulas moram no front, onde o formulário as usa ao vivo. Reescrevê-las em
// `$expr` seria manter duas versões da mesma matemática — e o dia em que
// divergissem, a lista ordenaria por um número que a ficha não mostra.
//
// IMC está, porque IMC é uma divisão: peso sobre altura ao quadrado, com os dois
// campos no documento.
const ORDEM_COLETAS = {
  person: "personName",
  date: "date",
  weight: "weight",
  bmi: "imc",
  photos: "fotos",
};

Assessment_model.prototype.pageAll = async function (trainerId, filtros = {}) {
  const col = await this.collection();

  const limite = Math.min(Math.max(Number(filtros.limit) || 20, 1), 100);
  const pagina = Math.max(Number(filtros.page) || 1, 1);
  const campo = ORDEM_COLETAS[filtros.sort] || "date";
  const direcao = filtros.dir === "asc" ? 1 : -1;

  const consulta = { trainer: new ObjectId(trainerId), draft: { $ne: true } };

  if (filtros.studentId && ObjectId.isValid(filtros.studentId)) {
    consulta.student = new ObjectId(filtros.studentId);
  }

  // ── A LENTE DA UNIDADE ──────────────────────────────────────────────────
  //
  // A coleta não tem unidade: quem tem é a PESSOA dela. A tradução é para IDS
  // DE PESSOA, e não um `$lookup`, porque o `total` logo abaixo é um
  // `countDocuments` — que não junta coleção. Filtrar só no pipeline daria
  // uma lista de uma unidade com o total da casa inteira, que foi exatamente
  // o que aconteceu na primeira tentativa: 3 avaliações em Paraty E em
  // Niterói, com uma pessoa em cada.
  //
  // Sem teto, ao contrário da busca por nome: lá o teto existe porque "a" não
  // é uma busca; aqui a unidade inteira é o que foi pedido.
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

  const termo = String(filtros.search || "").trim();
  if (termo) {
    const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await this.app.api.user.collection();

    // O teto de 500 é para o caso patológico ("a", numa conta com milhares): sem
    // ele o `$in` cresceria sem limite. Uma busca por uma letra não é uma busca.
    const pessoas = await users
      .find({ name: { $regex: escapado, $options: "i" } }, { projection: { _id: 1 }, limit: 500 })
      .toArray();

    if (!pessoas.length) return { rows: [], total: 0 };

    // ── CRUZAR COM O QUE JÁ FILTRAVA ──────────────────────────────────
    //
    // `consulta.student` pode já ser UMA pessoa (veio `personId`) ou UM
    // CONJUNTO delas (veio a lente da unidade). A versão anterior só sabia da
    // primeira forma: com a lente ligada, `String({ $in: [...] })` virava
    // "[object Object]" e a busca não casava com ninguém.
    const ids = pessoas.map((p) => p._id);
    const jaFiltrava = consulta.student;

    const permitido = (id) => {
      if (!jaFiltrava) return true;
      if (jaFiltrava.$in) return jaFiltrava.$in.some((x) => String(x) === String(id));
      return String(jaFiltrava) === String(id);
    };

    consulta.student = { $in: ids.filter(permitido) };
  }

  const total = await col.countDocuments(consulta);

  // ── O que é calculado ANTES do corte, e o que é calculado depois ──────────
  //
  // A mesma lição da tela de treinos: antes do `$limit` fica só o que decide
  // QUAIS vinte linhas são — os campos por onde se ordena. O nome da pessoa vem
  // depois, numa junção sobre vinte documentos, e não sobre as trezentas coletas
  // da conta.
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
        personSex: { $ifNull: [{ $arrayElemAt: ["$pessoa.sex", 0] }, ""] },
        personBirthDate: { $ifNull: [{ $arrayElemAt: ["$pessoa.birthDate", 0] }, ""] },
        personAvatarAt: { $arrayElemAt: ["$pessoa.avatarAt", 0] },
        // A UNIDADE da pessoa — o ID, não o nome: a tela já tem a lista de
        // unidades (é a mesma da lente) e resolve o nome sem uma segunda
        // junção aqui. *"quando tiver todos, mostre ali de qual unidade
        // pertence"*.
        personUnit: { $arrayElemAt: ["$pessoa.unit", 0] },
      },
    },
  ];

  const etapas = [{ $match: consulta }];

  etapas.push({
    $addFields: {
      // A altura da coleta é gravada em METROS (`alturaEmMetros`, na entrada),
      // mesmo quando a pessoa digita 175. Mas o `$gt: 3` continua aqui, e não é
      // desconfiança do próprio código: é o mesmo tolerante que `calculos.js`
      // faz na tela, e existe para documento ANTIGO, gravado antes da conversão.
      // Sem ele, uma conta com as duas gerações ordenaria por IMC misturando
      // números que diferem por um fator de dez mil.
      //
      // Sem os dois números o IMC é `null` — e `null` vai para o fim da lista
      // pelo `__vazio` abaixo, em vez de virar um zero que se ordena como se
      // fosse magreza.
      imc: {
        $let: {
          vars: {
            altura: {
              $cond: [{ $gt: ["$height", 3] }, { $divide: ["$height", 100] }, "$height"],
            },
          },
          in: {
            $cond: [
              { $and: [{ $gt: ["$weight", 0] }, { $gt: ["$$altura", 0] }] },
              { $divide: ["$weight", { $multiply: ["$$altura", "$$altura"] }] },
              null,
            ],
          },
        },
      },
      // Quantos ângulos daquela coleta têm foto. `photos` é um mapa
      // `{ front: <carimbo> }`, e apagar uma foto faz `$unset` da chave — então
      // contar as chaves é contar as fotos.
      fotos: { $size: { $objectToArray: { $ifNull: ["$photos", {}] } } },
    },
  });

  // Ordenar pelo NOME é o único caso em que a junção precisa vir antes: não dá
  // para escolher as vinte primeiras por um campo que ainda não existe.
  const ordenaPorPessoa = campo === "personName";
  if (ordenaPorPessoa) etapas.push(...juntarPessoa);

  // Linha sem o campo vai para o FIM, ordenando para qualquer lado. Uma coleta
  // sem peso encabeçando a lista de "menor peso" seria a tela dizendo que
  // ninguém pesa menos do que quem não foi pesado.
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
    rows: docs.map(
      ({ personName, personSex, personBirthDate, personAvatarAt, personUnit, ...row }) => ({
        ...row,
        student: {
          _id: row.student,
          name: personName || "",
          sex: personSex || "",
          birthDate: personBirthDate || "",
          avatarAt: personAvatarAt || null,
          unit: personUnit || null,
        },
      })
    ),
  };
};

// A SÉRIE de uma pessoa: as coletas em ordem de tempo, com o que os gráficos
// pedem e nada mais.
//
// Os gráficos de evolução (peso, % de gordura por protocolo, circunferências)
// precisam da linha inteira, não de duas pontas. E precisam dos campos CRUS, e
// não de um percentual pronto: quem calcula gordura é a tela, com as fórmulas que
// dependem de idade e sexo — mandar o número calculado daqui seria manter duas
// versões da mesma matemática.
//
// O que NÃO vem: fotos e observação. São o peso do documento e nenhum gráfico os
// usa; trazê-los seria carregar trinta coletas de bytes para desenhar linhas.
//
// Crescente, ao contrário de todo o resto do arquivo: um gráfico se lê da
// esquerda para a direita, e inverter no navegador é trabalho que o índice já
// fez.
const CAMPOS_DA_SERIE = {
  date: 1,
  weight: 1,
  height: 1,
  method: 1,
  protocol: 1,
  skinfolds: 1,
  circumferences: 1,
  bioimpedance: 1,
  weltman: 1,
};

Assessment_model.prototype.seriesOf = async function (trainerId, studentId, limite = 60) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.collection();

  // As MAIS RECENTES, e depois viradas: com sessenta de teto, quem tem cem
  // coletas quer as últimas sessenta, não as primeiras.
  const docs = await col
    .find(
      { trainer: new ObjectId(trainerId), student: new ObjectId(studentId), draft: { $ne: true } },
      { projection: CAMPOS_DA_SERIE }
    )
    .sort({ date: -1, _id: -1 })
    .limit(Math.min(Math.max(Number(limite) || 60, 1), 200))
    .toArray();

  return docs.reverse();
};

// A coleta ANTERIOR à de uma data, na mesma pessoa.
//
// Existe para a tela de UMA avaliação: um número sozinho não diz nada. "78 kg" é
// um fato; "78 kg, menos 2,4 desde março" é a informação. A aba da ficha já fazia
// isso com a lista inteira na mão; a tela de uma coleta não tem a lista, e pedir
// todas para usar uma seria trazer trezentos documentos para ler um.
//
// Rascunho fica fora: até o "salvar medida" não é avaliação, e comparar contra
// meia coleta distorce em vez de informar.
//
// O desempate por `_id` importa: duas coletas do MESMO dia (agora possível, desde
// que a coleta ganhou hora) precisam de uma ordem estável, senão "a anterior"
// muda de identidade entre duas aberturas da mesma tela.
Assessment_model.prototype.previousOf = async function (trainerId, studentId, quando, exceto) {
  if (!ObjectId.isValid(studentId)) return undefined;
  const col = await this.collection();

  const data = quando ? new Date(quando) : new Date();

  const doc = await col.findOne(
    {
      trainer: new ObjectId(trainerId),
      student: new ObjectId(studentId),
      draft: { $ne: true },
      ...(ObjectId.isValid(exceto) ? { _id: { $ne: new ObjectId(exceto) } } : {}),
      date: { $lte: data },
    },
    { sort: { date: -1, _id: -1 } }
  );

  return doc || undefined;
};

// O rascunho em aberto desta pessoa, se houver.
//
// Um por vez: sem isto, cada clique em "Nova medida" que fosse abandonado
// deixaria uma coleta vazia para trás, e em um mês a ficha teria mais rascunho
// que avaliação. Achando um, a tela continua dele em vez de criar outro.
Assessment_model.prototype.draftOf = async function (trainerId, studentId) {
  const col = await this.collection();

  const doc = await col.findOne(
    { trainer: new ObjectId(trainerId), student: new ObjectId(studentId), draft: true },
    { sort: { createdAt: -1 } }
  );

  return doc || undefined;
};

Assessment_model.prototype.data = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return doc || undefined;
};

Assessment_model.prototype.insert = async function (trainerId, studentId, obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    trainer: new ObjectId(trainerId),
    student: new ObjectId(studentId),
    ...limpar(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// EDITAR não pode inventar a data.
//
// `limpar` é a lista fechada de campos, e ela existe para o INSERT: lá, coleta
// sem data é coleta de hoje, e o padrão está certo. No update esse mesmo padrão
// é uma armadilha — um PUT que não manda `date` reescrevia a data para AGORA.
//
// Não é hipótese: o app de bolso faz exatamente isso. Ele cria o rascunho e
// grava peso, altura e circunferências sem repetir a data. Hoje sai de graça
// porque o rascunho nasceu no mesmo instante; no dia em que ele ganhar um "editar
// a observação", corrigir uma vírgula numa coleta de março a mudaria para hoje —
// e o gráfico de evolução mentiria sem ninguém ter tocado na data.
//
// Então o campo só entra no `$set` quando veio no corpo.
Assessment_model.prototype.update = async function (trainerId, id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const campos = limpar(obj);
  if (!(obj || {}).date) delete campos.date;

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: { ...campos, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

// O carimbo de data de um lado, gravado no documento da coleta.
//
// É o índice das fotos: a listagem já responde quais existem e de quando são,
// sem uma consulta a mais e sem trazer byte nenhum de imagem.
Assessment_model.prototype.setPhoto = async function (trainerId, id, side, at) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $set: { [`photos.${side}`]: at, updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

Assessment_model.prototype.clearPhoto = async function (trainerId, id, side) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { _id: new ObjectId(id), trainer: new ObjectId(trainerId) },
    { $unset: { [`photos.${side}`]: "" }, $set: { updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

// Os ids das coletas de uma pessoa. Serve à exclusão em cascata: as fotos são
// referenciadas pela avaliação, não pelo aluno.
Assessment_model.prototype.idsOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.collection();

  const docs = await col
    .find({ student: new ObjectId(studentId) }, { projection: { _id: 1 } })
    .toArray();

  return docs.map((d) => d._id);
};

Assessment_model.prototype.delete = async function (trainerId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id), trainer: new ObjectId(trainerId) });
  return r.deletedCount > 0;
};

// Apagadas junto com a pessoa, como treinos e planos alimentares.
Assessment_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;
  const col = await this.collection();

  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount || 0;
};

module.exports = Assessment_model;
module.exports.DOBRAS = DOBRAS;
module.exports.WELTMAN = WELTMAN;
module.exports.METODOS = METODOS;
module.exports.PROTOCOLOS = PROTOCOLOS;
module.exports.CIRCUNFERENCIAS = CIRCUNFERENCIAS;
module.exports.BIOIMPEDANCIA = BIOIMPEDANCIA;
module.exports.TESTES = TESTES;
