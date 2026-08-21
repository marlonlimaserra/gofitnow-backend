const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const DietTemplateController = require("../../controllers/DietTemplate.js");
const DietTemplate_model = require("../../model/DietTemplate_model.js");

// TEMPLATES DE DIETA: planos alimentares prontos do profissional.
//
// A diferença que faz o recurso valer a tela é o template carregar as REFEIÇÕES —
// montar um plano é escrever seis refeições com dez alimentos cada, pesando cada um.
// Por isso a maior parte destes casos é sobre as refeições sobreviverem à ida e à
// volta sem perder nada e sem levar o que não devia.
const PROF = "64b2c0f7e1a2b3c4d5e6f7a8";
const ALUNO = "64b2c0f7e1a2b3c4d5e6f701";
const TEMPLATE = "64b2c0f7e1a2b3c4d5e6f702";

const REFEICAO = {
  _id: "64b2c0f7e1a2b3c4d5e6f7aa",
  time: "07:00",
  name: "Café da manhã",
  note: "Mastigar devagar",
  foods: [
    {
      foodId: "64b2c0f7e1a2b3c4d5e6f7ab",
      name: "Pão francês",
      quantity: 50,
      unit: "g",
      imageKey: "pao-frances",
      kcal: 150,
      protein: 4,
      carbs: 30,
      fat: 1,
      group: 0,
    },
    { name: "Tapioca", quantity: 60, unit: "g", kcal: 130, group: 0 },
  ],
};

function monta({ permite = true, templates = [], planos = [], aluno = { _id: ALUNO, name: "Maria" } } = {}) {
  const feito = { inseridos: [], atualizados: [], apagados: [], planos: [], refeicoes: [] };

  const app = fakeApp({
    api: {
      dietTemplate: {
        async list() {
          return templates;
        },
        async data(prof, id) {
          return templates.find((t) => String(t._id) === String(id));
        },
        async insert(prof, obj) {
          feito.inseridos.push({ prof: String(prof), obj });
          const novo = { _id: TEMPLATE, ...obj };
          templates.push(novo);
          return TEMPLATE;
        },
        async update(prof, id, obj) {
          feito.atualizados.push({ id, obj });
          return true;
        },
        async delete(prof, id) {
          feito.apagados.push(id);
          return true;
        },
      },
      diet: {
        async data(prof, id) {
          // O plano recém-criado também responde: a rota lê de volta o que acabou de
          // inserir para devolver à tela, e sem isto o dublê a faria estourar por
          // falta do dado — falha do dublê, não da rota.
          if (String(id) === "novo-plano") {
            return { _id: "novo-plano", ...(feito.planos.at(-1)?.obj || {}) };
          }
          return planos.find((p) => String(p._id) === String(id));
        },
        async insert(prof, aluno_, obj) {
          feito.planos.push({ aluno: String(aluno_), obj });
          return "novo-plano";
        },
        async saveMeals(prof, id, meals) {
          feito.refeicoes.push({ id, meals });
          return true;
        },
      },
      user: {
        async dataStudent(prof, id) {
          return id === "fantasma" ? undefined : aluno;
        },
      },
      actionHistory: { diff: () => ({}) },
    },
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          if (permite) return { _id: PROF, name: "Willian", permissao };
          res.status(403).send({ msg: "forbidden" });
          return false;
        },
      },
    },
  });

  app.insertUserActionHistory = (req, user, acao, dados) => {
    app.registrados.push({ acao, dados });
  };

  DietTemplateController(app);
  return { app, feito };
}

test("a lista não manda o conteúdo das refeições, só a contagem", async () => {
  // A tela de configuração mostra "5 refeições · 32 alimentos". Mandar o array
  // inteiro de doze templates para desenhar dois números seria trazer doze planos
  // alimentares para a tela de ajustes.
  const model = new DietTemplate_model({});
  model.collection = async () => ({
    find: () => ({
      sort: () => ({
        toArray: async () => [{ _id: "t1", name: "Cutting", meals: [REFEICAO, { ...REFEICAO, foods: [] }] }],
      }),
    }),
  });

  const linhas = await model.list(PROF);

  assert.equal(linhas[0].mealCount, 2);
  assert.equal(linhas[0].foodCount, 2);
  assert.equal(linhas[0].meals, undefined, "mandou as refeições na lista");
});

test("criar a partir de um PLANO copia as refeições dele", async () => {
  // É o caminho principal: ninguém escreve seis refeições numa tela de
  // configuração. O que acontece é montar o plano de alguém e querer reusá-lo.
  const { app, feito } = monta({
    planos: [
      {
        _id: "d1",
        name: "Dieta da Maria",
        goal: "Cutting",
        note: "Beber água",
        weekdays: [1, 2, 3],
        targetKcal: 1800,
        meals: [REFEICAO],
      },
    ],
  });

  const r = await call(app, "post", "/diet-templates", {
    body: { name: "Cutting 1800", fromDiet: "d1" },
  });

  assert.equal(r.status, 201);
  const salvo = feito.inseridos[0].obj;
  assert.equal(salvo.meals.length, 1);
  assert.equal(salvo.meals[0].foods.length, 2);
  assert.equal(salvo.goal, "Cutting");
  assert.equal(salvo.targetKcal, 1800);
  // O NOME é o que a pessoa escreveu, não o do plano: "Dieta da Maria" não serve de
  // template.
  assert.equal(salvo.name, "Cutting 1800");
});

test("o plano é lido pelo ID, e não recebido pronto do navegador", async () => {
  // O corpo da requisição não é lugar de confiar para copiar refeições — e o `data`
  // do plano já confere que ele é deste profissional.
  const { app, feito } = monta({
    planos: [{ _id: "d1", name: "Dieta", meals: [REFEICAO] }],
  });

  await call(app, "post", "/diet-templates", {
    body: {
      name: "Cutting",
      fromDiet: "d1",
      // Refeição plantada no corpo: tem de ser ignorada.
      meals: [{ name: "Refeição falsa", foods: [{ name: "Bolo", quantity: 999 }] }],
    },
  });

  const salvo = feito.inseridos[0].obj;
  assert.equal(salvo.meals.length, 1);
  assert.equal(salvo.meals[0].name, "Café da manhã");
});

test("plano de outro profissional é 404 — e nada é criado", async () => {
  const { app, feito } = monta({ planos: [] });

  const r = await call(app, "post", "/diet-templates", {
    body: { name: "Cutting", fromDiet: "d-de-outro" },
  });

  assert.equal(r.status, 404);
  assert.equal(feito.inseridos.length, 0);
});

test("template sem nome é recusado", async () => {
  const { app, feito } = monta();
  const r = await call(app, "post", "/diet-templates", { body: { name: "a" } });

  assert.equal(r.status, 400);
  assert.equal(feito.inseridos.length, 0);
});

test("editar só o nome NÃO apaga as refeições", async () => {
  // `update` regrava o documento inteiro. Sem mesclar com o que já estava, o campo
  // ausente no corpo viraria lista vazia — e o template perderia o conteúdo numa
  // renomeação.
  const { app, feito } = monta({
    templates: [{ _id: TEMPLATE, name: "Cutting", meals: [REFEICAO], targetKcal: 1800 }],
  });

  const r = await call(app, "put", `/diet-templates/${TEMPLATE}`, {
    body: { name: "Cutting 1800" },
    params: { id: TEMPLATE },
  });

  assert.equal(r.status, 200);
  const enviado = feito.atualizados[0].obj;
  assert.equal(enviado.name, "Cutting 1800");
  assert.equal(enviado.meals.length, 1, "as refeições foram embora na renomeação");
  assert.equal(enviado.targetKcal, 1800);
});

test("aplicar um template cria o plano COM as refeições, num passo", async () => {
  // Em dois passos, uma falha no segundo deixaria a pessoa com um plano vazio e com
  // cara de defeito.
  const { app, feito } = monta({
    templates: [
      {
        _id: TEMPLATE,
        name: "Cutting 1800",
        goal: "Cutting",
        weekdays: [1, 3, 5],
        targetKcal: 1800,
        meals: [REFEICAO],
      },
    ],
  });

  const r = await call(app, "post", `/people/${ALUNO}/diets/from-template/${TEMPLATE}`, {
    body: { startDate: "2026-08-01", endDate: "2026-08-31" },
    params: { personId: ALUNO, templateId: TEMPLATE },
  });

  assert.equal(r.status, 201);

  const plano = feito.planos[0].obj;
  assert.equal(plano.name, "Cutting 1800");
  assert.equal(plano.goal, "Cutting");
  assert.equal(plano.targetKcal, 1800);
  // As DATAS vêm do corpo: elas são do plano, não do template.
  assert.equal(plano.startDate, "2026-08-01");
  assert.equal(plano.endDate, "2026-08-31");
  // E o template não carrega data nenhuma.
  assert.equal(plano.meals, undefined, "as refeições entraram no insert em vez do saveMeals");

  assert.equal(feito.refeicoes.length, 1);
  assert.equal(feito.refeicoes[0].meals.length, 1);
});

test("aplicar aceita um nome próprio para o plano", async () => {
  // "Cutting 1800" serve de template; quem quiser "Plano da Maria — agosto" escreve.
  const { app, feito } = monta({
    templates: [{ _id: TEMPLATE, name: "Cutting 1800", meals: [] }],
  });

  await call(app, "post", `/people/${ALUNO}/diets/from-template/${TEMPLATE}`, {
    body: { name: "Plano da Maria — agosto" },
    params: { personId: ALUNO, templateId: TEMPLATE },
  });

  assert.equal(feito.planos[0].obj.name, "Plano da Maria — agosto");
});

test("template vazio não chama saveMeals", async () => {
  const { app, feito } = monta({ templates: [{ _id: TEMPLATE, name: "Só o cabeçalho", meals: [] }] });

  await call(app, "post", `/people/${ALUNO}/diets/from-template/${TEMPLATE}`, {
    body: {},
    params: { personId: ALUNO, templateId: TEMPLATE },
  });

  assert.equal(feito.planos.length, 1);
  assert.equal(feito.refeicoes.length, 0);
});

test("aplicar num aluno que não é deste profissional é 404", async () => {
  const { app, feito } = monta({ templates: [{ _id: TEMPLATE, name: "X", meals: [] }] });

  const r = await call(app, "post", `/people/fantasma/diets/from-template/${TEMPLATE}`, {
    body: {},
    params: { personId: "fantasma", templateId: TEMPLATE },
  });

  assert.equal(r.status, 404);
  assert.equal(feito.planos.length, 0);
});

test("fim antes do começo é recusado ao aplicar", async () => {
  const { app, feito } = monta({ templates: [{ _id: TEMPLATE, name: "X", meals: [] }] });

  const r = await call(app, "post", `/people/${ALUNO}/diets/from-template/${TEMPLATE}`, {
    body: { startDate: "2026-08-31", endDate: "2026-08-01" },
    params: { personId: ALUNO, templateId: TEMPLATE },
  });

  assert.equal(r.status, 400);
  assert.equal(feito.planos.length, 0);
});

test("tudo aqui exige diets.manage", async () => {
  const pedidas = [];
  const { app } = monta({ templates: [{ _id: TEMPLATE, name: "X", meals: [] }] });
  app.helpers.ReqProtected.can = async (req, res, permissao) => {
    pedidas.push(permissao);
    return { _id: PROF };
  };

  await call(app, "get", "/diet-templates");
  await call(app, "post", "/diet-templates", { body: { name: "Cutting" } });
  await call(app, "put", `/diet-templates/${TEMPLATE}`, { body: {}, params: { id: TEMPLATE } });
  await call(app, "delete", `/diet-templates/${TEMPLATE}`, { params: { id: TEMPLATE } });

  assert.deepEqual(pedidas, ["diets.manage", "diets.manage", "diets.manage", "diets.manage"]);
});

test("sem permissão, nada é lido nem criado", async () => {
  const { app, feito } = monta({ permite: false });

  assert.equal((await call(app, "get", "/diet-templates")).status, 403);
  assert.equal((await call(app, "post", "/diet-templates", { body: { name: "X" } })).status, 403);
  assert.equal(feito.inseridos.length, 0);
});

test("o dono vem da SESSÃO, nunca do corpo", async () => {
  // Sem isto, mandar `professional` no corpo criaria template na conta de outro.
  const { app, feito } = monta();

  await call(app, "post", "/diet-templates", {
    body: { name: "Cutting", professional: "64b2c0f7e1a2b3c4d5e6f999" },
  });

  assert.equal(feito.inseridos[0].prof, PROF);
});

test("o saneador PRESERVA o id da refeição — é o que permite editá-la", async () => {
  // Ele descartava, e isso quebrava a edição de refeição dentro do template: cada
  // salvamento gerava ids novos, a tela ficava com os velhos em mão, e a edição
  // seguinte criava uma refeição em vez de alterar a existente.
  const model = new DietTemplate_model({});
  const gravados = [];
  model.collection = async () => ({
    async insertOne(doc) {
      gravados.push(doc);
      return { insertedId: "t1" };
    },
  });

  await model.insert(PROF, { name: "Cutting", meals: [REFEICAO] });

  assert.equal(String(gravados[0].meals[0]._id), REFEICAO._id);
});

test("refeição SEM id ganha um", async () => {
  // É o caso da refeição criada na tela do template, que nasce sem id.
  const model = new DietTemplate_model({});
  const gravados = [];
  model.collection = async () => ({
    async insertOne(doc) {
      gravados.push(doc);
      return { insertedId: "t1" };
    },
  });

  await model.insert(PROF, { name: "Cutting", meals: [{ ...REFEICAO, _id: undefined }] });

  assert.match(String(gravados[0].meals[0]._id), /^[0-9a-f]{24}$/);
});

test("copiar de um plano NÃO herda os ids das refeições dele", async () => {
  // Herdar faria o template apontar para as refeições da dieta de origem. Quem
  // descarta é o controller, porque é lá que existe a cópia.
  const { app, feito } = monta({
    planos: [{ _id: "d1", name: "Dieta", meals: [REFEICAO] }],
  });

  await call(app, "post", "/diet-templates", { body: { name: "Cutting", fromDiet: "d1" } });

  assert.equal(feito.inseridos[0].obj.meals[0]._id, undefined);
});

test("aplicar num plano também não repassa os ids do template", async () => {
  // Dois planos criados do mesmo template ficariam com refeições de id igual.
  const { app, feito } = monta({
    templates: [{ _id: TEMPLATE, name: "Cutting", meals: [REFEICAO] }],
  });

  await call(app, "post", `/people/${ALUNO}/diets/from-template/${TEMPLATE}`, {
    body: {},
    params: { personId: ALUNO, templateId: TEMPLATE },
  });

  assert.equal(feito.refeicoes[0].meals[0]._id, undefined);
});

test("o template não guarda data nenhuma", async () => {
  // Um período só faz sentido no plano de uma pessoa: "20/08 a 20/09" num template
  // estaria errado no dia seguinte ao que foi criado.
  const model = new DietTemplate_model({});
  const gravados = [];
  model.collection = async () => ({
    async insertOne(doc) {
      gravados.push(doc);
      return { insertedId: "t1" };
    },
  });

  await model.insert(PROF, {
    name: "Cutting",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    meals: [],
  });

  assert.equal(gravados[0].startDate, undefined);
  assert.equal(gravados[0].endDate, undefined);
});
