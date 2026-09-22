const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const EmployeeTime = require("../../model/EmployeeTime_model.js");
const EmployeeRecord = require("../../model/EmployeeRecord_model.js");
const Employee = require("../../model/Employee_model.js");
const tipos = require("../../lib/tiposDeOcorrencia.js");
const vinculos = require("../../lib/vinculosDeTrabalho.js");

// A EQUIPE DA CASA.
//
// *"crie mais um item no menu, chamado funcionários, para a gente cadastrar o
// funcionário, ver folha de ponto, salário, advertências, anotações e outras
// coisas que funcionário pode ter que eu não sei"*.

// ── A HORA ────────────────────────────────────────────────────────────────

test("a hora é normalizada, e o impossível vira vazio", () => {
  // "8:00" e "08:00" na mesma coluna são dois formatos do mesmo horário, e é
  // assim que uma folha começa a parecer preenchida por duas pessoas.
  assert.equal(EmployeeTime.hora("8:5"), "08:05");
  assert.equal(EmployeeTime.hora("0800"), "08:00");
  assert.equal(EmployeeTime.hora("23:59"), "23:59");

  for (const ruim of ["25:00", "8:60", "abc", "", null, undefined]) {
    assert.equal(EmployeeTime.hora(ruim), "", JSON.stringify(ruim));
  }
});

test("o par que atravessa a meia-noite é PLANTÃO, e não erro de digitação", () => {
  // Academia 24h existe, e o vigia noturno também. 22:00 → 06:00 são oito
  // horas; a subtração ingênua daria menos dezesseis.
  assert.equal(EmployeeTime.duracao("22:00", "06:00"), 480);
  assert.equal(EmployeeTime.duracao("08:00", "12:00"), 240);
});

test("batida aberta conta ZERO, e não até agora", () => {
  // Contar até o relógio faria o total do mês mudar sozinho a cada vez que
  // alguém abrisse a tela — e dois prints da mesma folha divergiriam.
  const lista = [
    { entrada: "08:00", saida: "12:00" },
    { entrada: "13:00", saida: "" },
  ];
  assert.equal(EmployeeTime.totalDe(lista), 240);
});

test("o dia só aceita AAAA-MM-DD — e não vira hoje quando é inválido", () => {
  // Gravar o ponto no dia errado é pior que recusar.
  assert.equal(EmployeeTime.dia("2026-09-19"), "2026-09-19");
  assert.equal(EmployeeTime.dia("19/09/2026"), null);
  assert.equal(EmployeeTime.dia(""), null);
});

// ── O ESPELHO DO MÊS ──────────────────────────────────────────────────────

function fakePonto(gravados = []) {
  const escritas = [];
  const model = new EmployeeTime({});
  model.collection = async () => ({
    find: () => ({
      sort: () => ({ async toArray() { return gravados; } }),
    }),
    async updateOne(filtro, mudanca, opcoes) {
      escritas.push({ filtro, set: mudanca.$set, opcoes });
    },
    async deleteOne(filtro) {
      escritas.push({ apagou: filtro });
      return { deletedCount: 1 };
    },
  });
  return { model, escritas };
}

const DONO = new ObjectId().toString();

test("o espelho traz TODOS os dias do período, inclusive os vazios", async () => {
  // É o que faz a tela ser uma folha e não uma lista: o dia sem registro
  // precisa existir como linha, porque é ele que se vai preencher.
  const { model } = fakePonto([
    { dia: "2026-09-02", batidas: [{ entrada: "08:00", saida: "12:00" }], minutos: 240 },
  ]);

  const r = await model.espelho({ employee: DONO, de: "2026-09-01", ate: "2026-09-05" });

  assert.equal(r.dias.length, 5);
  assert.deepEqual(r.dias.map((d) => d.dia), [
    "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05",
  ]);
  assert.equal(r.dias[1].minutos, 240);
  assert.equal(r.dias[0].minutos, 0);
});

test("o dia da semana sai do SERVIDOR, e não de um new Date na tela", async () => {
  // `new Date("2026-09-19")` é meia-noite UTC, e no Brasil isso é o dia 18: a
  // coluna mostraria o nome do dia anterior a folha inteira.
  const { model } = fakePonto([]);
  const r = await model.espelho({ employee: DONO, de: "2026-09-19", ate: "2026-09-19" });

  // 19/09/2026 é um sábado.
  assert.equal(r.dias[0].semana, 6);
});

test("o previsto é regra de três sobre a jornada — e some sem jornada", async () => {
  const { model } = fakePonto([]);

  const com = await model.espelho({
    employee: DONO, de: "2026-09-01", ate: "2026-09-07", jornadaSemanal: 44,
  });
  // Sete dias, jornada de 44h: 44 × 60 × 7 / 7 = 2640 minutos.
  assert.equal(com.resumo.previsto, 2640);

  const sem = await model.espelho({ employee: DONO, de: "2026-09-01", ate: "2026-09-07" });
  assert.equal(sem.resumo.previsto, 0);
  assert.equal(sem.resumo.saldo, 0, "sem previsto não há saldo — e zero não é 'em dia'");
});

test("período invertido não vira laço infinito nem lista negativa", async () => {
  const { model } = fakePonto([]);
  const r = await model.espelho({ employee: DONO, de: "2026-09-10", ate: "2026-09-01" });
  assert.deepEqual(r.dias, []);
});

test("o dia limpo é APAGADO, e não gravado vazio", async () => {
  // Um documento sem batida, sem falta e sem observação contaria como "dia
  // registrado" no resumo sem dizer nada.
  const { model, escritas } = fakePonto([]);
  const r = await model.gravar(DONO, { dia: "2026-09-19", batidas: [] });

  assert.equal(r.apagado, true);
  assert.ok(escritas[0].apagou);
});

test("gravar o dia calcula os minutos no servidor", async () => {
  // A tela manda batidas; o total é derivado. Deixar a tela mandar o número
  // faria dois lugares decidirem a mesma coisa, e o errado é sempre o que some.
  const { model, escritas } = fakePonto([]);

  await model.gravar(
    DONO,
    { dia: "2026-09-19", batidas: [{ entrada: "08:00", saida: "12:00" }, { entrada: "13:00", saida: "17:00" }] },
    { _id: new ObjectId(), name: "Marlon" }
  );

  assert.equal(escritas[0].set.minutos, 480);
  assert.equal(escritas[0].set.lancadoPorNome, "Marlon");
  assert.ok(escritas[0].opcoes.upsert);
});

test("a falta zera os minutos, mesmo com batida digitada", async () => {
  const { model, escritas } = fakePonto([]);
  await model.gravar(DONO, {
    dia: "2026-09-19",
    falta: true,
    batidas: [{ entrada: "08:00", saida: "12:00" }],
  });

  assert.equal(escritas[0].set.minutos, 0);
});

// ── A LINHA DO TEMPO ──────────────────────────────────────────────────────

function fakeOcorrencias() {
  const escritas = [];
  let existente = null;

  const model = new EmployeeRecord({});
  model.collection = async () => ({
    async insertOne(doc) {
      escritas.push(doc);
      return { insertedId: new ObjectId() };
    },
    async findOne() {
      return existente;
    },
    async updateOne(filtro, mudanca) {
      escritas.push(mudanca.$set);
      return { matchedCount: 1 };
    },
  });

  return { model, escritas, semear: (d) => (existente = d) };
}

test("campo que o tipo NÃO usa não é gravado", async () => {
  // Uma anotação com `gravidade: "verbal"` guardada por acidente é uma linha
  // que um filtro de advertências um dia traz por engano.
  const { model, escritas } = fakeOcorrencias();

  await model.insert(DONO, { tipo: "anotacao", texto: "chegou cedo", gravidade: "escrita", amount: 5000, ate: "2026-12-01" }, {});

  assert.equal(escritas[0].gravidade, null);
  assert.equal(escritas[0].amount, 0);
  assert.equal(escritas[0].ate, null);
});

test("a advertência guarda gravidade e ciência; a anotação não", async () => {
  const { model, escritas } = fakeOcorrencias();

  await model.insert(DONO, { tipo: "advertencia", gravidade: "suspensao", ciente: true }, {});

  assert.equal(escritas[0].gravidade, "suspensao");
  assert.equal(escritas[0].ciente, true);
  // Marcar ciente sem dizer quando carimba agora: a data da ciência é o que
  // conta prazo, e nula tornaria o campo decorativo.
  assert.ok(escritas[0].cienteEm instanceof Date);
});

test("período que termina antes de começar vira um dia só", async () => {
  // Digitação trocada não pode virar um intervalo negativo que some de toda
  // consulta de "quem está de férias hoje".
  const { model, escritas } = fakeOcorrencias();

  await model.insert(DONO, { tipo: "ferias", data: "2026-09-20", ate: "2026-09-10" }, {});

  assert.equal(escritas[0].ate.toISOString(), escritas[0].data.toISOString());
});

test("quem lançou fica gravado pelo NOME, e não só pelo id", async () => {
  // Uma advertência de 2024 tem de continuar dizendo quem a aplicou depois que
  // aquela conta for excluída.
  const { model, escritas } = fakeOcorrencias();
  const quem = { _id: new ObjectId(), name: "Bruna" };

  await model.insert(DONO, { tipo: "advertencia" }, quem);

  assert.equal(escritas[0].createdByName, "Bruna");
  assert.ok(escritas[0].createdBy);
});

test("trocar o tipo LIMPA o que ficou para trás", async () => {
  // Editar uma advertência para virar anotação tem de tirar a gravidade: senão
  // a linha fica anotação com degrau de advertência dentro.
  const { model, escritas, semear } = fakeOcorrencias();
  semear({
    _id: new ObjectId(),
    employee: new ObjectId(),
    tipo: "advertencia",
    gravidade: "escrita",
    ciente: true,
    cienteEm: new Date(),
    data: new Date(),
  });

  await model.update(new ObjectId().toString(), { tipo: "anotacao" });

  const set = escritas[escritas.length - 1];
  assert.equal(set.tipo, "anotacao");
  assert.equal(set.gravidade, null);
  assert.equal(set.ciente, false);
});

// ── OS CATÁLOGOS ──────────────────────────────────────────────────────────

test("os vínculos com carteira são os que mostram CTPS e PIS", () => {
  // O aprendiz tem carteira: o contrato de aprendizagem é registrado, e
  // esquecer isso faria a ficha dele nascer incompleta.
  const mapa = Object.fromEntries(vinculos.paraTela().map((v) => [v.id, v.carteira]));

  assert.equal(mapa.clt, true);
  assert.equal(mapa.aprendiz, true);
  assert.equal(mapa.temporario, true);
  assert.equal(mapa.pj, false);
  assert.equal(mapa.socio, false);
});

test("um vínculo inventado cai no padrão, e não grava lixo", () => {
  assert.equal(vinculos.existe("clt"), true);
  assert.equal(vinculos.existe("escravo"), false);
});

test("o catálogo de ocorrências diz de que campos cada tipo precisa", () => {
  // É ele que desenha o formulário. Um tipo que não declarasse nada nasceria
  // com texto só, que é o certo.
  const mapa = Object.fromEntries(tiposDeOcorrencia().map((t) => [t.id, t]));

  assert.equal(mapa.ferias.periodo, true);
  assert.equal(mapa.reajuste.valor, true);
  assert.equal(mapa.advertencia.gravidade, true);
  assert.equal(mapa.advertencia.ciente, true);
  assert.equal(mapa.anotacao.periodo, false);
  assert.equal(mapa.anotacao.valor, false);
});

function tiposDeOcorrencia() {
  return tipos.paraTela();
}

test("a escada da advertência está na ordem", () => {
  // Verbal → escrita → suspensão. A ordem importa porque a justa causa se
  // sustenta quando existe a escada documentada.
  assert.deepEqual(tipos.GRAVIDADES.map((g) => g.id), ["verbal", "escrita", "suspensao"]);
});

// ── A FICHA ───────────────────────────────────────────────────────────────

function fakeFicha() {
  const escritas = [];
  let atual = null;

  const model = new Employee({ api: { employeeImage: { async pruneUnused() {} } } });
  model.collection = async () => ({
    async insertOne(doc) {
      escritas.push(doc);
      atual = { ...doc, _id: new ObjectId() };
      return { insertedId: atual._id };
    },
    async findOne() {
      return atual;
    },
    async updateOne(filtro, mudanca) {
      escritas.push(mudanca.$set);
      return { matchedCount: 1 };
    },
  });

  return { model, escritas, semear: (d) => (atual = d) };
}

test("desligar DESATIVA, sempre", async () => {
  // Um funcionário com data de saída e `active: true` é uma contradição que a
  // tela mostraria como "trabalhando aqui".
  const { model, escritas } = fakeFicha();

  await model.insert({ name: "João", dismissedAt: "2026-08-31", active: true });
  assert.equal(escritas[0].active, false);
});

test("o endereço de uma linha é DERIVADO das partes", async () => {
  // Duas fontes para o mesmo endereço divergem na primeira edição, e a errada é
  // sempre a que aparece.
  const { model, escritas } = fakeFicha();

  await model.insert({
    name: "João", logradouro: "Rua X", numero: "100", bairro: "Centro", cidade: "Paraty", uf: "RJ",
  });

  assert.equal(escritas[0].endereco, "Rua X, 100 — Centro, Paraty/RJ");
});

test("sem nome não há ficha", async () => {
  const { model } = fakeFicha();
  assert.equal(await model.insert({ name: "   " }), null);
});

test("o nome de ordenação anda junto do nome", async () => {
  // Separados dariam uma lista que ordena por um e mostra outro.
  const { model, escritas } = fakeFicha();
  await model.insert({ name: "Ângela Souza" });
  assert.equal(escritas[0].nameSort, "angela souza");
});

test("salário é guardado em CENTAVOS, e negativo vira zero", async () => {
  const { model, escritas } = fakeFicha();
  await model.insert({ name: "João", salary: 250000 });
  assert.equal(escritas[0].salary, 250000);

  const outro = fakeFicha();
  await outro.model.insert({ name: "João", salary: -5 });
  assert.equal(outro.escritas[0].salary, 0);
});

test("a jornada semanal tem teto — 84h é o limite físico da semana útil", async () => {
  const { model, escritas } = fakeFicha();
  await model.insert({ name: "João", weeklyHours: 500 });
  assert.equal(escritas[0].weeklyHours, 84);
});

test("os benefícios são lista livre, e o sem rótulo cai fora", async () => {
  // Vale-transporte, vale-refeição, plano, gympass, bolsa. Campos fixos para os
  // quatro mais comuns fariam o quinto virar observação — e observação não soma.
  const { model, escritas } = fakeFicha();

  await model.insert({
    name: "João",
    benefits: [
      { label: "Vale-transporte", amount: 22000 },
      { label: "", amount: 9900 },
      { label: "Gympass", amount: 0 },
    ],
  });

  assert.deepEqual(escritas[0].benefits, [
    { label: "Vale-transporte", amount: 22000 },
    { label: "Gympass", amount: 0 },
  ]);
});

// ── OS ANEXOS SÃO VÁRIOS ──────────────────────────────────────────────────
//
// *"ué, está deixando só colocar 1 arquivo; deixe colocar vários, no máximo
// 10"*. Uma advertência tem o papel assinado E a foto do que aconteceu; um
// atestado vem com duas páginas.
function fakeAnexos(jaGravados = 0) {
  const inseridos = [];
  const atualizacoes = [];
  let docs = [];

  const model = new EmployeeRecord({});
  const arquivos = {
    async countDocuments() {
      return jaGravados;
    },
    async insertMany(lista) {
      inseridos.push(...lista);
      docs = [
        ...docs,
        ...lista.map((l, i) => ({
          _id: new ObjectId(String(i + 1).padStart(24, "0")),
          name: l.name,
          mime: l.mime,
          size: l.size,
          createdAt: new Date(),
        })),
      ];
    },
    find: () => ({ sort: () => ({ async toArray() { return docs; } }) }),
    async findOne(filtro) {
      return { _id: filtro._id, record: filtro.record, mime: "image/png", data: Buffer.from("x") };
    },
    async deleteOne() {
      return { deletedCount: docs.length ? 1 : 0 };
    },
  };

  model.files = async () => arquivos;
  model.collection = async () => ({
    async updateOne(filtro, mudanca) {
      atualizacoes.push(mudanca.$set);
      return { matchedCount: 1 };
    },
  });

  return { model, inseridos, atualizacoes };
}

function anexoFalso(nome) {
  return {
    mime: "image/png",
    buffer: Buffer.from("x"),
    ficha: { name: nome, mime: "image/png", size: 1, kind: "image" },
  };
}

test("grava vários anexos de uma vez", async () => {
  const { model, inseridos } = fakeAnexos();

  await model.saveAnexos(DONO, [anexoFalso("a.png"), anexoFalso("b.png"), anexoFalso("c.png")]);

  assert.equal(inseridos.length, 3);
  assert.deepEqual(inseridos.map((i) => i.name), ["a.png", "b.png", "c.png"]);
});

test("o teto é DEZ, e ele conta o que já está lá", async () => {
  // Oito gravados e cinco chegando: entram dois, e não cinco. Contar só os que
  // chegam deixaria o teto ser furado em duas idas.
  const { model, inseridos } = fakeAnexos(8);

  await model.saveAnexos(DONO, [1, 2, 3, 4, 5].map((n) => anexoFalso(`${n}.png`)));

  assert.equal(inseridos.length, 2);
});

test("com dez já gravados, nada entra — e não estoura", async () => {
  const { model, inseridos } = fakeAnexos(10);
  const fichas = await model.saveAnexos(DONO, [anexoFalso("tarde.png")]);

  assert.deepEqual(inseridos, []);
  assert.ok(Array.isArray(fichas));
});

test("as FICHAS voltam para o documento, sem os bytes", async () => {
  // Trazer os arquivos junto faria uma lista de cem ocorrências arrastar
  // megabytes para desenhar nomes.
  const { model, atualizacoes } = fakeAnexos();

  await model.saveAnexos(DONO, [anexoFalso("atestado.pdf")]);

  const fichas = atualizacoes[atualizacoes.length - 1].anexos;
  assert.equal(fichas.length, 1);
  assert.equal(fichas[0].name, "atestado.pdf");
  assert.ok(fichas[0].id, "sem id não há como pedir nem apagar um anexo específico");
  assert.equal("data" in fichas[0], false);
});

test("ler um anexo exige o id da OCORRÊNCIA junto", async () => {
  // Sem ele, um id de arquivo adivinhado leria o anexo de outra ficha — e o
  // escopo de cliente, que é automático, não separa uma ficha da outra.
  const { model } = fakeAnexos();
  const anexoId = new ObjectId().toString();

  const achado = await model.anexoDe(DONO, anexoId);
  assert.equal(String(achado.record), DONO);
  assert.equal(String(achado._id), anexoId);

  assert.equal(await model.anexoDe("lixo", anexoId), undefined);
  assert.equal(await model.anexoDe(DONO, "lixo"), undefined);
});

test("apagar UM anexo reescreve a lista do documento", async () => {
  const { model, atualizacoes } = fakeAnexos();
  const ok = await model.removeAnexo(DONO, new ObjectId().toString());

  assert.equal(ok, false, "sem arquivo gravado não há o que apagar");
  assert.deepEqual(atualizacoes, []);
});

test("a ocorrência sem anexo devolve lista VAZIA, e não nulo", async () => {
  // A tela percorre sempre; um `null` no meio viraria um `.map` de nada.
  const { paraTela } = EmployeeRecord;
  assert.deepEqual(paraTela({ _id: new ObjectId(), employee: new ObjectId() }).anexos, []);
});

test("o teto de dez é o que o modelo publica", () => {
  assert.equal(EmployeeRecord.MAX_ANEXOS, 10);
});

// ── A FICHA TRAZ A SITUAÇÃO, COMO A LISTA ─────────────────────────────────
//
// `data()` era um `findOne` cru: devolvia o documento como está no banco, sem
// a `situacao` — que é CALCULADA a partir da linha do tempo (férias, atestado,
// licença que cubram hoje) e de `dismissedAt`/`active`.
//
// O buraco não aparecia no servidor: a tela é que mostrava
// `employees.status.undefined`, a chave de tradução de um valor que não
// existe. Um caso que só olhasse `name` passaria por cima dele.
test("a ficha calcula a situação com as MESMAS etapas da lista", async () => {
  const pedidos = [];

  const col = {
    aggregate(etapas) {
      pedidos.push(etapas);
      return { toArray: async () => [{ _id: "e1", name: "Bruna", situacao: "ferias" }] };
    },
    findOne: async () => ({ _id: "e1", name: "Bruna" }),
  };

  const model = new Employee({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
  });

  const ficha = await model.data("6a80de570056d24c09f5da61");

  assert.equal(ficha.situacao, "ferias");

  // Pelo AGREGADO, e não pelo findOne: é o que garante que a conta é a mesma.
  // Um `findOne` aqui devolveria o documento sem a situação, calado.
  assert.equal(pedidos.length, 1);
  const etapas = pedidos[0];
  assert.ok(etapas.some((e) => e.$lookup?.from === "employee_records"));
  assert.ok(etapas.some((e) => e.$addFields?.situacao));
});

test("`hoje` é o instante da consulta, e não o da subida do processo", async () => {
  // Num processo que fica semanas de pé, um `new Date()` no escopo do módulo
  // congelaria a data — e todo mundo continuaria de férias para sempre.
  const janelas = [];

  const col = {
    aggregate(etapas) {
      const lookup = etapas.find((e) => e.$lookup?.from === "employee_records");
      const condicoes = lookup.$lookup.pipeline[0].$match.$expr.$and;
      janelas.push(condicoes.find((c) => c.$lte)?.$lte?.[1]);
      return { toArray: async () => [{ _id: "e1" }] };
    },
  };

  const model = new Employee({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
  });

  await model.data("6a80de570056d24c09f5da61");
  await new Promise((r) => setTimeout(r, 5));
  await model.data("6a80de570056d24c09f5da61");

  assert.ok(janelas[1] > janelas[0], "a data deveria avançar entre duas consultas");
});
