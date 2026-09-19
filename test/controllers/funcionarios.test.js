const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const EmployeeController = require("../../controllers/Employee.js");

// FUNCIONÁRIOS — e o que este arquivo existe para provar é UMA coisa:
//
// ── O SALÁRIO NÃO VIAJA PARA QUEM NÃO PODE VÊ-LO ─────────────────────────
//
// Esconder o número na tela seria deixá-lo no JSON, a um F12 de distância. A
// recepcionista que preenche o ponto de todo mundo abriria o inspetor e leria
// quanto o gerente ganha — e ninguém saberia que ela leu.
//
// São quatro rotas que devolvem ficha (lista, uma, criar, editar) e uma que
// devolve reajuste. A que esquecesse do corte vazaria tudo, e é por isso que
// cada uma tem um caso aqui.
const FICHA = {
  _id: "f1",
  name: "Bruna",
  role: "Recepção",
  bond: "clt",
  salary: 250000,
  salaryKind: "monthly",
  benefits: [{ label: "Vale-transporte", amount: 22000 }],
  commission: 5,
  pix: "bruna@email.com",
  bank: "Itaú",
  bankAgency: "1234",
  bankAccount: "56789-0",
  weeklyHours: 44,
};

const CAMPOS_SENSIVEIS = [
  "salary", "salaryKind", "benefits", "commission", "pix", "bank", "bankAgency", "bankAccount",
];

function monta({ permissoes = ["employees.view", "employees.manage"], api = {} } = {}) {
  const gravado = { criados: [], mudancas: [], ocorrencias: [], pontos: [] };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, chave) {
          if (!permissoes.includes(chave)) {
            res.status(403).send({ msg: "sem permissão" });
            return false;
          }
          return { _id: "u1", name: "Marlon", permissions: permissoes };
        },
      },
    },
    api: {
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL"] };
        },
      },
      employee: {
        async listar() {
          return {
            rows: [{ id: "f1", name: "Bruna", salary: 250000, salaryKind: "monthly" }],
            total: 1,
            pagina: 1,
            porPagina: 25,
            paginas: 1,
            resumo: { equipe: 3, afastados: 1, desligados: 0, folha: 750000 },
          };
        },
        async data() {
          return { ...FICHA };
        },
        async contagem() {
          return 3;
        },
        async insert(corpo) {
          gravado.criados.push(corpo);
          return "novo";
        },
        async update(id, corpo) {
          gravado.mudancas.push({ id, corpo });
          return true;
        },
        async quantoTemJunto() {
          return { ocorrencias: 0, pontos: 0 };
        },
        async remove() {
          return true;
        },
      },
      employeeRecord: {
        async listar() {
          return {
            rows: [
              { id: "r1", tipo: "reajuste", amount: 280000, texto: "anual" },
              { id: "r2", tipo: "advertencia", amount: 0, gravidade: "escrita" },
            ],
            porTipo: [],
          };
        },
        async insert(dono, corpo) {
          gravado.ocorrencias.push({ dono, corpo });
          return "r9";
        },
        async data() {
          return { id: "r9" };
        },
        parseAnexo: () => undefined,
        async saveAnexo() {},
      },
      employeeTime: {
        async espelho() {
          return { dias: [], resumo: {} };
        },
        async gravar(id, corpo) {
          gravado.pontos.push({ id, corpo });
          return { dia: corpo.dia, minutos: 480 };
        },
      },
      ...api,
    },
  });

  EmployeeController(app);
  return { app, gravado };
}

const SEM_FOLHA = ["employees.view", "employees.manage"];
const COM_FOLHA = ["employees.view", "employees.manage", "employees.payroll"];

test("a LISTA não manda salário para quem não tem a chave da folha", async () => {
  const { app } = monta({ permissoes: SEM_FOLHA });
  const r = await call(app, "get", "/employees");

  assert.equal(r.status, 200);
  assert.equal(r.body.rows[0].name, "Bruna", "a pessoa continua aparecendo");
  assert.equal("salary" in r.body.rows[0], false);
  assert.equal(r.body.podeVerFolha, false);
});

test("o TOTAL da folha some junto — um total sem as partes ainda é o total", async () => {
  const { app } = monta({ permissoes: SEM_FOLHA });
  const r = await call(app, "get", "/employees");

  assert.equal(r.body.resumo.folha, undefined);
  // O resto do resumo FICA: quantos somos e quantos estão afastados não é
  // segredo de ninguém, e é a pergunta que a tela abre para responder.
  assert.equal(r.body.resumo.equipe, 3);
  assert.equal(r.body.resumo.afastados, 1);
});

test("com a chave, o salário viaja", async () => {
  const { app } = monta({ permissoes: COM_FOLHA });
  const r = await call(app, "get", "/employees");

  assert.equal(r.body.rows[0].salary, 250000);
  assert.equal(r.body.resumo.folha, 750000);
  assert.equal(r.body.podeVerFolha, true);
});

test("a FICHA corta todos os oito campos de dinheiro, e não só o salário", async () => {
  // Chave Pix e conta bancária são tão folha quanto o valor: com elas dá para
  // descobrir quanto alguém ganha olhando o extrato, e elas são o caminho para
  // desviar um pagamento.
  const { app } = monta({ permissoes: SEM_FOLHA });
  const r = await call(app, "get", "/employees/f1");

  for (const campo of CAMPOS_SENSIVEIS) {
    assert.equal(campo in r.body, false, `${campo} vazou na ficha`);
  }
  assert.equal(r.body.name, "Bruna");
});

test("CRIAR sem a chave ignora o salário mandado no corpo", async () => {
  // Ignorar e não recusar: quem cadastra sem poder ver salário cadastra a
  // pessoa, e quem tem a chave preenche o valor depois. Recusar obrigaria as
  // duas coisas a acontecerem na mesma mão.
  const { app, gravado } = monta({ permissoes: SEM_FOLHA });
  const r = await call(app, "post", "/employees", {
    body: { name: "Novo", salary: 999999, pix: "chave@pirata" },
  });

  assert.equal(r.status, 201);
  assert.equal(gravado.criados[0].name, "Novo");
  assert.equal("salary" in gravado.criados[0], false);
  assert.equal("pix" in gravado.criados[0], false);
});

test("EDITAR sem a chave não apaga nem muda o salário que já existe", async () => {
  const { app, gravado } = monta({ permissoes: SEM_FOLHA });
  await call(app, "put", "/employees/f1", { body: { name: "Bruna S.", salary: 1 } });

  assert.equal(gravado.mudancas[0].corpo.name, "Bruna S.");
  assert.equal("salary" in gravado.mudancas[0].corpo, false);
});

test("a RESPOSTA do editar também sai sem salário", async () => {
  // É a rota mais fácil de esquecer: ela devolve a ficha recarregada.
  const { app } = monta({ permissoes: SEM_FOLHA });
  const r = await call(app, "put", "/employees/f1", { body: { name: "Bruna S." } });

  assert.equal("salary" in r.body, false);
});

test("o REAJUSTE aparece na história sem o valor, e não some dela", async () => {
  // "Houve um aumento em março" não é segredo; quanto foi, é. Esconder a linha
  // inteira faria a história mentir por omissão.
  const { app } = monta({ permissoes: SEM_FOLHA });
  const r = await call(app, "get", "/employees/f1/records");

  const reajuste = r.body.rows.find((x) => x.tipo === "reajuste");
  assert.ok(reajuste, "a linha do reajuste continua na lista");
  assert.equal(reajuste.amount, undefined);
  assert.equal(reajuste.texto, "anual");
});

test("LANÇAR reajuste sem a chave é 403 — aqui recusar é o certo", async () => {
  // Diferente de cadastrar: um reajuste É o valor. Aceitar e ignorar criaria
  // uma linha "reajuste de R$ 0,00" que ninguém pediu.
  const { app, gravado } = monta({ permissoes: SEM_FOLHA });
  const r = await call(app, "post", "/employees/f1/records", {
    body: { tipo: "reajuste", amount: 300000 },
  });

  assert.equal(r.status, 403);
  assert.deepEqual(gravado.ocorrencias, []);
});

test("o reajuste MOVE o salário da ficha", async () => {
  // Lançar "reajuste para R$ 2.800" e a ficha continuar dizendo R$ 2.500 seria
  // pedir para digitar a mesma coisa duas vezes — e a segunda é a que se esquece.
  const { app, gravado } = monta({ permissoes: COM_FOLHA });
  await call(app, "post", "/employees/f1/records", {
    body: { tipo: "reajuste", amount: 280000 },
  });

  assert.deepEqual(gravado.mudancas[0].corpo, { salary: 280000 });
});

test("a promoção move o CARGO, pela mesma razão", async () => {
  const { app, gravado } = monta({ permissoes: COM_FOLHA });
  await call(app, "post", "/employees/f1/records", {
    body: { tipo: "promocao", cargo: "Gerente" },
  });

  assert.deepEqual(gravado.mudancas[0].corpo, { role: "Gerente" });
});

test("uma advertência não mexe em salário nem em cargo", async () => {
  const { app, gravado } = monta({ permissoes: COM_FOLHA });
  await call(app, "post", "/employees/f1/records", {
    body: { tipo: "advertencia", gravidade: "escrita" },
  });

  assert.deepEqual(gravado.mudancas, []);
});

// ── AS PERMISSÕES DE ENTRADA ──────────────────────────────────────────────

test("sem `employees.view` a lista é 403", async () => {
  const { app } = monta({ permissoes: [] });
  const r = await call(app, "get", "/employees");
  assert.equal(r.status, 403);
});

test("quem só VÊ não cadastra", async () => {
  const { app, gravado } = monta({ permissoes: ["employees.view"] });
  const r = await call(app, "post", "/employees", { body: { name: "Novo" } });

  assert.equal(r.status, 403);
  assert.deepEqual(gravado.criados, []);
});

test("quem só VÊ não preenche o ponto", async () => {
  const { app, gravado } = monta({ permissoes: ["employees.view"] });
  const r = await call(app, "put", "/employees/f1/time/2026-09-19", {
    body: { batidas: [{ entrada: "08:00", saida: "17:00" }] },
  });

  assert.equal(r.status, 403);
  assert.deepEqual(gravado.pontos, []);
});

// ── APAGAR PERGUNTA ANTES ─────────────────────────────────────────────────

test("apagar quem tem história responde 409 com os números", async () => {
  // O caminho normal é DESLIGAR: a pessoa sai da lista e o que aconteceu com
  // ela continua existindo, que é o que se pede num processo trabalhista.
  const { app } = monta({
    permissoes: COM_FOLHA,
    api: {
      employee: {
        async data() {
          return { ...FICHA };
        },
        async quantoTemJunto() {
          return { ocorrencias: 4, pontos: 212 };
        },
        async remove() {
          throw new Error("não devia ter apagado");
        },
        async contagem() {
          return 3;
        },
      },
    },
  });

  const r = await call(app, "delete", "/employees/f1");

  assert.equal(r.status, 409);
  assert.equal(r.body.ocorrencias, 4);
  assert.equal(r.body.pontos, 212);
  assert.equal(r.body.precisaConfirmar, true);
});

test("com `?confirmado=1` ele apaga", async () => {
  let apagou = false;
  const { app } = monta({
    permissoes: COM_FOLHA,
    api: {
      employee: {
        async data() {
          return { ...FICHA };
        },
        async quantoTemJunto() {
          return { ocorrencias: 4, pontos: 212 };
        },
        async remove() {
          apagou = true;
          return true;
        },
        async contagem() {
          return 3;
        },
      },
    },
  });

  const r = await call(app, "delete", "/employees/f1", { query: { confirmado: "1" } });

  assert.equal(r.status, 200);
  assert.equal(apagou, true);
});

test("quem NÃO tem história apaga direto — cadastro errado não pede cerimônia", async () => {
  const { app } = monta({ permissoes: COM_FOLHA });
  const r = await call(app, "delete", "/employees/f1");
  assert.equal(r.status, 200);
});

// ── A FOTO ────────────────────────────────────────────────────────────────

test("a foto de funcionário EXIGE sessão, e o cache dela é privado", async () => {
  // A do fornecedor é pública: aquilo é a logo da Enel. Esta é o rosto de uma
  // pessoa empregada, e uma URL aberta vaza num print ou num log de proxy.
  const { app } = monta({
    permissoes: COM_FOLHA,
    api: {
      employeeImage: {
        async data() {
          return { mime: "image/png", updatedAt: new Date("2026-09-19"), data: Buffer.from("x") };
        },
      },
    },
  });

  const semSessao = monta({ permissoes: [] });
  EmployeeController(semSessao.app);
  const negado = await call(semSessao.app, "get", "/employee-photo/i1");
  assert.equal(negado.status, 403);

  const r = await call(app, "get", "/employee-photo/i1");
  assert.match(String(r.headers["cache-control"]), /private/);
});
