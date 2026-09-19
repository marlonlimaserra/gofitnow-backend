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
