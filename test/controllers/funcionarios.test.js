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
  photo: "abc123",
  whatsapp: "(21) 98812-4471",
  cpf: "123.456.789-00",
  endereco: "Rua X, 10",
  pis: "1234567890",
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

// ── O QUE A FOLHA DE PONTO LEVA JUNTO ────────────────────────────────────
//
// A folha impressa é assinada e arquivada: *"no pdf faltou a foto da pessoa"*,
// *"também faltou pôr o whatsapp para facilitar"*. Mas ela é sobre HORÁRIO — e
// endereço, PIS e salário não têm por que viajar com ela.
test("a folha de ponto leva foto e whatsapp, e nada de folha de pagamento", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/employees/f1/time", {
    query: { de: "2026-09-01", ate: "2026-09-30" },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.funcionario.name, "Bruna");
  // A foto vai como ID: quem busca os bytes é a tela, pela rota que exige
  // sessão — é o rosto de uma pessoa empregada.
  assert.equal(r.body.funcionario.photo, "abc123");
  assert.equal(r.body.funcionario.whatsapp, "(21) 98812-4471");

  for (const campo of [...CAMPOS_SENSIVEIS, "cpf", "endereco", "pis"]) {
    assert.equal(campo in r.body.funcionario, false, `${campo} não devia viajar com a folha`);
  }
});

test("sem foto, a folha de ponto manda nulo — e não o ObjectId de ninguém", async () => {
  const { app } = monta({
    api: { employee: { async data() { return { ...FICHA, photo: null, whatsapp: "" }; } } },
  });
  const r = await call(app, "get", "/employees/f1/time", {
    query: { de: "2026-09-01", ate: "2026-09-30" },
  });

  assert.equal(r.body.funcionario.photo, null);
  assert.equal(r.body.funcionario.whatsapp, "");
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

// ── OS ANEXOS: qualquer tipo entra, mas nem tudo SAI do mesmo jeito ───────
//
// *"quero poder pôr qualquer arquivo, tentei colocar mp3 e não consegui"*.
//
// A lista de quatro tipos existia para proteger a leitura. Recusar na entrada
// protegia errado — o áudio da conversa que gerou a advertência é um anexo
// legítimo. A proteção foi para a ROTA, e é aqui que ela é provada.
function comAnexo(anexo) {
  const guardados = [];

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can() {
          return { _id: "u1", name: "Marlon", permissions: ["employees.view", "employees.manage"] };
        },
      },
    },
    api: {
      tenant: { async currencyOfInstance() { return { currency: "BRL", currencies: [] }; } },
      employee: { async data() { return { _id: "f1" }; }, async contagem() { return 1; } },
      employeeRecord: {
        async data() { return { id: "r1" }; },
        parseAnexo: (a) =>
          a?.dataUri
            ? { mime: a.mime || "audio/mpeg", buffer: Buffer.from("x"), ficha: { name: a.name } }
            : undefined,
        async saveAnexos(id, lista) {
          guardados.push(...lista);
          return [{ id: "a1", name: lista[0]?.ficha?.name }];
        },
        async anexoDe() {
          return anexo;
        },
        podeSairInline: (mime) =>
          ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(mime),
      },
    },
  });

  EmployeeController(app);
  return { app, guardados };
}

const BYTES = { data: Buffer.from("x") };

test("um MP3 é aceito", async () => {
  const { app, guardados } = comAnexo();
  const r = await call(app, "post", "/employee-records/r1/anexos", {
    body: { name: "conversa.mp3", mime: "audio/mpeg", dataUri: "data:audio/mpeg;base64,eA==" },
  });

  assert.equal(r.status, 201);
  assert.equal(guardados.length, 1);
});

test("um arquivo por requisição — e o que falha diz qual foi", async () => {
  // Todos no corpo do lançamento não cabia: o `bodyParser` corta em 10 MB, o
  // base64 infla ~33%, e dois de 6 MB derrubariam o pedido inteiro, levando
  // junto o texto da advertência.
  const { app } = comAnexo();
  const r = await call(app, "post", "/employee-records/r1/anexos", { body: {} });

  assert.equal(r.status, 400);
  assert.match(String(r.body.msg), /7 MB/);
});

test("PDF sai INLINE — o atestado é para olhar", async () => {
  const { app } = comAnexo({ ...BYTES, mime: "application/pdf", name: "atestado.pdf" });
  const r = await call(app, "get", "/employee-records/r1/anexos/a1");

  assert.equal(r.headers["content-type"], "application/pdf");
  assert.match(r.headers["content-disposition"], /^inline/);
});

test("MP3 vira DOWNLOAD, e não toca na nossa origem", async () => {
  const { app } = comAnexo({ ...BYTES, mime: "audio/mpeg", name: "conversa.mp3" });
  const r = await call(app, "get", "/employee-records/r1/anexos/a1");

  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.match(r.headers["content-disposition"], /^attachment/);
  assert.match(r.headers["content-disposition"], /conversa\.mp3/);
});

test("HTML NUNCA sai inline — seria XSS na nossa origem", async () => {
  // Servido `inline`, ele roda script na nossa origem, com a sessão de quem
  // abriu. É a razão de a lista de tipos ter existido, e é o que substitui ela.
  const { app } = comAnexo({ ...BYTES, mime: "text/html", name: "x.html" });
  const r = await call(app, "get", "/employee-records/r1/anexos/a1");

  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.match(r.headers["content-disposition"], /^attachment/);
});

test("SVG também não — é documento executável com cara de imagem", async () => {
  const { app } = comAnexo({ ...BYTES, mime: "image/svg+xml", name: "a.svg" });
  const r = await call(app, "get", "/employee-records/r1/anexos/a1");

  assert.equal(r.headers["content-type"], "application/octet-stream");
});

test("`nosniff` vai em TODOS", async () => {
  // Sem ele o navegador adivinha o tipo pelo conteúdo, e um `.txt` com HTML
  // dentro volta a ser página.
  for (const mime of ["application/pdf", "audio/mpeg", "text/plain"]) {
    const { app } = comAnexo({ ...BYTES, mime, name: "a" });
    const r = await call(app, "get", "/employee-records/r1/anexos/a1");
    assert.equal(r.headers["x-content-type-options"], "nosniff", mime);
  }
});

test("aspas no nome não quebram o cabeçalho", async () => {
  const { app } = comAnexo({ ...BYTES, mime: "audio/mpeg", name: 'con"versa.mp3' });
  const r = await call(app, "get", "/employee-records/r1/anexos/a1");

  assert.equal(r.headers["content-disposition"], 'attachment; filename="conversa.mp3"');
});

test("o anexo é servido com cache PRIVADO", async () => {
  // É conteúdo de uma sessão: um proxy compartilhado não pode guardar o
  // atestado de alguém e servir para outro.
  const { app } = comAnexo({ ...BYTES, mime: "application/pdf", name: "a.pdf" });
  const r = await call(app, "get", "/employee-records/r1/anexos/a1");

  assert.match(String(r.headers["cache-control"]), /private/);
});
