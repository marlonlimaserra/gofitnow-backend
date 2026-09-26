const test = require("node:test");
const assert = require("node:assert");

const { LISTAS, existe, nomeDoArquivo, planilha, documento } = require("../../lib/listasExportaveis.js");
const { rotulos } = require("../../lib/rotulosDeDocumento.js");
const { recorteDeIds, somenteEscolhidos } = require("../../lib/recorteDeIds.js");
const { porPagina } = require("../../lib/tetoDaLista.js");

// AS LISTAS QUE SE LEVAM EMBORA — uma definição, todos os aplicativos.
//
// *"acho melhor o xlsx e pdf sempre serem gerados pelo backend, assim
// garantimos que sempre vai ser igual em todos os apps"* (23/09/2026).
//
// O que estes casos seguram não é o desenho da tabela — é o que diferencia uma
// planilha útil de um arquivo que parece certo:
//
//   • nenhum rótulo sai como CHAVE. Uma coluna chamada `structure.state.ok` é
//     o defeito que este registro mais convida, porque ele mistura dois
//     catálogos de tradução e cair no lado errado não levanta erro nenhum.
//   • data é DATA e dinheiro é NÚMERO na planilha, e texto no papel. Uma data
//     como string não ordena nem filtra, e foi assim que o papel chegou a
//     imprimir "2026-09-23T12:00:00.000Z".
//   • marcar linhas e receber TODAS é o pior resultado possível: o arquivo sai
//     plausível, com gente que ninguém escolheu, e quem o recebe não desconfia.

// O `t` da rota: o catálogo do site primeiro, o do servidor depois. É o mesmo
// encadeamento de `controllers/Exportar.js`, e testar com um `t` mais simples
// esconderia justamente o erro que ele existe para evitar.
const { translator } = require("../../lib/i18n/index.js");

function rotulador(lang) {
  const doSite = rotulos(lang);
  const doServidor = translator(lang);

  return (chave, vars) => {
    const achado = doSite(chave, vars);
    if (achado !== String(chave)) return achado;
    return doServidor(chave, vars);
  };
}

const CONTEXTO = (extra = {}) => ({
  user: { _id: "u1", permissions: ["employees.payroll"] },
  query: {},
  lang: "pt-BR",
  fuso: "America/Sao_Paulo",
  moeda: "BRL",
  words: { Singular: "Aluno", Plural: "Alunos" },
  nomeDaUnidade: (id) => (id ? "Niterói" : ""),
  formas: (k) => ({ pix: "Pix", cash: "Dinheiro" })[k] || String(k || ""),
  linhas: [],
  ...extra,
});

// Uma linha com TODOS os campos que qualquer coluna possa ler. Uma só para as
// oito listas de propósito: o que cada coluna faz com um campo que não é dela é
// devolver vazio, e é isso que se quer conferir.
const LINHA = {
  _id: "6512f1c0c0c0c0c0c0c0c0c1",
  id: "6512f1c0c0c0c0c0c0c0c0c1",
  name: "Ana Souza",
  nickname: "Aninha",
  unit: "u1",
  personUnit: "u1",
  studentUnit: "u1",
  personName: "Ana Souza",
  studentName: "Ana Souza",
  studentPhone: "(21) 99999-0000",
  studentEmail: "ana@exemplo.com",
  phone: "(21) 99999-0000",
  whatsapp: "(21) 99999-0000",
  email: "ana@exemplo.com",
  goal: "Hipertrofia",
  role: "Recepção",
  bond: "clt",
  situacao: "ativo",
  admittedAt: "2024-03-14",
  salary: 260000,
  hasAccess: true,
  active: 1,
  teacherName: "Marlon",
  status: "current",
  startDate: "2026-09-01",
  endDate: "2026-12-01",
  weekdays: ["friday", "monday"],
  exerciseCount: 7,
  setCount: 21,
  createdAt: "2026-09-23T14:30:00.000Z",
  marca: "Movement",
  modelo: "LX",
  serie: "SN-9",
  categoria: "cardio",
  local: "Sala de cardio",
  estado: "ok",
  ultimaManutencao: "2026-08-10",
  gastoEmManutencao: 11000,
  saldo: 4,
  medida: "un",
  minimo: 2,
  ultimoEm: "2026-09-20T10:00:00.000Z",
  quando: "20/09/2026",
  titulo: "Esteira 3",
  detalhe: "Corretiva · troca de correia",
  direita: "R$ 110,00",
  numero: 12,
  description: "Mensalidade",
  dueDate: "2026-09-30",
  amount: 25000,
  pago: 10000,
  falta: 15000,
  atrasada: false,
  currency: "BRL",
  assunto: "Mensalidade",
  date: "2026-09-18T12:00:00.000Z",
  method: "pix",
  student: "6512f1c0c0c0c0c0c0c0c0c1",
  // Do histórico do funcionário.
  ate: "2026-09-20",
  texto: "Chegou 40 minutos atrasado.",
  gravidade: "verbal",
  ciente: true,
  justificada: false,
  createdByName: "Marlon",
  // Da conta a pagar.
  paidAt: null,
  note: "",
  // Do fornecedor.
  document: "33.050.196/0001-88",
  contact: "Central de atendimento",
  contas: 12,
};

const NOMES = Object.keys(LISTAS);

test("as oito listas existem e cada uma declara a SUA permissão", () => {
  assert.deepStrictEqual(NOMES, [
    "pessoas",
    "treinos",
    "funcionarios",
    "historicoDoFuncionario",
    "equipamentos",
    "estoque",
    "historico",
    "fornecedores",
    "contas",
    "cobrancas",
    "pagamentos",
  ]);

  for (const nome of NOMES) {
    const lista = LISTAS[nome];
    // Sem permissão, estas duas rotas seriam uma porta lateral para ler o que a
    // tela recusa — e uma lista nova esquecer a chave é um erro silencioso.
    assert.match(lista.permissao, /^[a-z]+\.[a-z]+$/, nome);
    assert.strictEqual(typeof lista.linhas, "function", nome);
    assert.strictEqual(typeof lista.colunas, "function", nome);
  }
});

test("uma lista que não existe não existe — e o nome não vira caminho", () => {
  assert.ok(existe("pessoas"));
  assert.ok(!existe("gente"));
  assert.ok(!existe("../../etc/passwd"));
  assert.ok(!existe("constructor"));
  assert.ok(!existe("toString"));
});

for (const lang of ["pt-BR", "en"]) {
  test(`nenhum rótulo sai como chave — ${lang}`, () => {
    const t = rotulador(lang);

    for (const nome of NOMES) {
      const colunas = LISTAS[nome].colunas(t, CONTEXTO({ lang, linhas: [LINHA] }));

      for (const c of colunas) {
        // Uma chave crua tem ponto e nenhum espaço: "structure.state.ok".
        // Nenhum rótulo de verdade se parece com isso em nenhum dos idiomas.
        assert.ok(
          !/^[a-z][A-Za-z]*(\.[A-Za-z]+)+$/.test(c.rotulo),
          `${nome}: o rótulo "${c.rotulo}" saiu como chave`
        );
        assert.ok(c.rotulo && c.rotulo.trim(), `${nome}: rótulo vazio`);
      }
    }
  });

  test(`nenhuma CÉLULA sai como chave — ${lang}`, () => {
    // É o erro mais provável deste registro: o rótulo vem do catálogo do site e
    // o VALOR muitas vezes vem do catálogo do servidor (vínculo, estado do
    // equipamento, tipo de manutenção). Cair no lado errado escreve
    // `employees.status.ativo` no meio da tabela, e ninguém revisa célula.
    const t = rotulador(lang);

    for (const nome of NOMES) {
      const colunas = LISTAS[nome].colunas(t, CONTEXTO({ lang, linhas: [LINHA] }));

      for (const c of colunas) {
        const v = c.valor(LINHA);
        if (typeof v !== "string") continue;

        assert.ok(
          !/^[a-z][A-Za-z]*(\.[A-Za-z]+)+$/.test(v),
          `${nome} / ${c.rotulo}: a célula "${v}" saiu como chave`
        );
      }
    }
  });
}

test("o vocabulário da casa manda na coluna do nome", () => {
  const t = rotulador("pt-BR");

  const pessoas = LISTAS.pessoas.colunas(t, CONTEXTO({ words: { Singular: "Paciente", Plural: "Pacientes" } }));
  assert.strictEqual(pessoas[0].rotulo, "Paciente");

  const cobrancas = LISTAS.cobrancas.colunas(t, CONTEXTO({ words: { Singular: "Paciente" } }));
  assert.ok(cobrancas.some((c) => c.rotulo === "Paciente"));
});

test("sem permissão de folha, o salário não tem coluna", () => {
  const t = rotulador("pt-BR");

  const com = LISTAS.funcionarios.colunas(t, CONTEXTO({ linhas: [LINHA] }));
  const sem = LISTAS.funcionarios.colunas(
    t,
    CONTEXTO({ linhas: [LINHA], user: { _id: "u1", permissions: ["employees.view"] } })
  );

  assert.ok(com.some((c) => c.rotulo === "Salário"));
  assert.ok(!sem.some((c) => c.rotulo === "Salário"));
});

test("a coluna de unidade só aparece quando a lista mistura unidades", () => {
  const t = rotulador("pt-BR");
  const semUnidade = { ...LINHA, unit: null, personUnit: null, studentUnit: null };

  for (const nome of ["funcionarios", "equipamentos", "historico", "pagamentos"]) {
    const com = LISTAS[nome].colunas(t, CONTEXTO({ linhas: [LINHA] }));
    const sem = LISTAS[nome].colunas(t, CONTEXTO({ linhas: [semUnidade] }));

    assert.ok(com.some((c) => c.rotulo === "Unidade"), `${nome} deveria mostrar a unidade`);
    assert.ok(!sem.some((c) => c.rotulo === "Unidade"), `${nome} não deveria mostrar a unidade`);
  }
});

test("o equipamento lê `local` e `gastoEmManutencao` — os nomes que o banco usa", () => {
  // O painel lia `onde` e `custoTotal`, que não existem: as duas colunas saíam
  // VAZIAS em toda planilha e em toda folha, e coluna em branco parece cadastro
  // incompleto em vez de defeito.
  const t = rotulador("pt-BR");
  const colunas = LISTAS.equipamentos.colunas(t, CONTEXTO({ linhas: [LINHA] }));

  const onde = colunas.find((c) => c.rotulo === "Onde está");
  const gasto = colunas.find((c) => c.rotulo === "Já custou");

  assert.strictEqual(onde.valor(LINHA), "Sala de cardio");
  assert.deepStrictEqual(gasto.valor(LINHA), { dinheiro: 11000, moeda: "BRL" });
});

test("a situação da cobrança é CALCULADA, e não o campo gravado", () => {
  const t = rotulador("pt-BR");
  const colunas = LISTAS.cobrancas.colunas(t, CONTEXTO());
  const situacao = colunas[colunas.length - 1];

  assert.strictEqual(situacao.valor({ ...LINHA, status: "canceled" }), t("finance.canceled"));
  assert.strictEqual(situacao.valor({ ...LINHA, falta: 0 }), t("finance.statusPaid"));
  assert.strictEqual(situacao.valor({ ...LINHA, atrasada: true }), t("finance.late"));
  assert.strictEqual(situacao.valor(LINHA), t("finance.open"));
});

// ── A PLANILHA ────────────────────────────────────────────────────────────

const abrir = async (bytes) => {
  const ExcelJS = require("exceljs");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book.worksheets[0];
};

test("data vira DATA e dinheiro vira NÚMERO — não texto", async () => {
  const colunas = [
    { rotulo: "Dia", largura: 12, valor: () => ({ data: "2026-09-30" }) },
    { rotulo: "Instante", largura: 16, valor: () => ({ dataHora: "2026-09-23T14:30:00.000Z" }) },
    { rotulo: "Valor", largura: 12, direita: true, valor: () => ({ dinheiro: 260000, moeda: "BRL" }) },
  ];

  const aba = await abrir(await planilha({ titulo: "T", colunas, linhas: [{}], lang: "pt-BR" }));
  const linha = aba.getRow(2);

  assert.ok(linha.getCell(1).value instanceof Date, "a data saiu como texto");
  assert.ok(linha.getCell(2).value instanceof Date, "o instante saiu como texto");
  // 2600, e não 260000 nem "R$ 2.600,00": quem abre uma lista de dinheiro no
  // Excel abre para somar.
  assert.strictEqual(linha.getCell(3).value, 2600);

  assert.strictEqual(aba.getColumn(1).numFmt, "dd/mm/yyyy");
  assert.strictEqual(aba.getColumn(2).numFmt, "dd/mm/yyyy hh:mm");
  assert.strictEqual(aba.getColumn(3).numFmt, "#,##0.00");
});

test("o dia do calendário não escorrega de fuso", async () => {
  // Meia-noite UTC em São Paulo é o dia anterior às 21h. A célula é fixada ao
  // MEIO-DIA justamente para caber doze horas de empurrão para cada lado.
  const colunas = [{ rotulo: "Dia", largura: 12, valor: () => ({ data: "2026-09-30" }) }];
  const aba = await abrir(await planilha({ titulo: "T", colunas, linhas: [{}], lang: "pt-BR" }));

  assert.strictEqual(aba.getRow(2).getCell(1).value.toISOString().slice(0, 10), "2026-09-30");
});

test("o formato da data segue quem lê", async () => {
  const colunas = [{ rotulo: "Dia", largura: 12, valor: () => ({ data: "2026-09-30" }) }];

  const pt = await abrir(await planilha({ titulo: "T", colunas, linhas: [{}], lang: "pt-BR" }));
  const en = await abrir(await planilha({ titulo: "T", colunas, linhas: [{}], lang: "en" }));

  assert.strictEqual(pt.getColumn(1).numFmt, "dd/mm/yyyy");
  assert.strictEqual(en.getColumn(1).numFmt, "mm/dd/yyyy");
});

test("uma coluna de datas cuja PRIMEIRA linha está vazia ainda é de datas", async () => {
  // O formato é decidido pela primeira célula COM tipo, e não pela primeira
  // linha: senão uma admissão em branco no topo tiraria o formato da coluna
  // inteira, e as outras vinte sairiam como número serial.
  const colunas = [{ rotulo: "Dia", largura: 12, valor: (l) => ({ data: l.dia }) }];
  const aba = await abrir(
    await planilha({ titulo: "T", colunas, linhas: [{ dia: null }, { dia: "2026-09-30" }], lang: "pt-BR" })
  );

  assert.strictEqual(aba.getColumn(1).numFmt, "dd/mm/yyyy");
});

test("a planilha não estoura com lista vazia", async () => {
  const t = rotulador("pt-BR");

  for (const nome of NOMES) {
    const colunas = LISTAS[nome].colunas(t, CONTEXTO({ linhas: [] }));
    const aba = await abrir(await planilha({ titulo: nome, colunas, linhas: [], lang: "pt-BR" }));
    assert.strictEqual(aba.rowCount, 1, `${nome}: só o cabeçalho`);
  }
});

// ── O PAPEL ───────────────────────────────────────────────────────────────

const papel = (extra = {}) =>
  documento({
    titulo: "Lista",
    lang: "pt-BR",
    fuso: "America/Sao_Paulo",
    colunas: [
      { rotulo: "Dia", largura: 12, valor: () => ({ data: "2026-09-30" }) },
      { rotulo: "Valor", largura: 12, direita: true, valor: () => ({ dinheiro: 260000, moeda: "BRL" }) },
      { rotulo: "Nome", largura: 20, valor: (l) => l.name },
    ],
    linhas: [{ name: "Ana" }],
    ...extra,
  });

test("no papel, a data sai escrita — e não o carimbo do banco", () => {
  const html = papel();

  assert.ok(html.includes("30/09/2026"), "a data não foi formatada");
  assert.ok(!html.includes("2026-09-30T"), "saiu a data crua do banco");
  assert.ok(html.includes("R$"), "o dinheiro não foi formatado");
});

test("o rodapé diz QUANDO foi impresso — e não `{{quando}}`", () => {
  // Saiu assim em produção: `rotulos()` ignorava o segundo argumento, e nenhuma
  // chave sem variável denunciava isso.
  const html = papel();

  assert.ok(!html.includes("{{"), "sobrou uma variável por trocar");
  assert.match(html, /Impresso em \d{2}\/\d{2}\/\d{4}/);
});

test("o que veio do banco entra ESCAPADO", () => {
  const html = papel({ linhas: [{ name: '<script>alert(1)</script>' }] });

  assert.ok(!html.includes("<script>alert"), "o HTML da linha não foi escapado");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("o recorte vai impresso, porque a folha circula longe da tela", () => {
  // Dez linhas sem essa nota não deixam ninguém saber se a lista tem dez ou se
  // o filtro estava ligado.
  assert.ok(papel({ recorte: "3 marcadas" }).includes("3 marcadas"));
});

test("lista vazia diz que está vazia, e não sai como tabela sem linhas", () => {
  const html = papel({ linhas: [] });

  assert.ok(html.includes("Nenhuma linha neste recorte"));
  assert.ok(!html.includes("<tbody>"));
});

// ── O NOME DO ARQUIVO ─────────────────────────────────────────────────────

test("o nome do arquivo sobrevive ao WhatsApp e à pasta de downloads", () => {
  const nome = nomeDoArquivo("Cobranças · Setembro", "xlsx");

  assert.match(nome, /^cobrancas-setembro-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.ok(!/[^a-z0-9.-]/.test(nome), "sobrou caractere que alguém reescreve");
});

// ── O RECORTE DO QUE ESTÁ MARCADO ─────────────────────────────────────────

test("nenhum id VÁLIDO é nenhuma linha — nunca a base inteira", () => {
  // O pior resultado possível: marcar três, receber trezentas, e o arquivo
  // parecer certo para quem o recebe.
  assert.strictEqual(recorteDeIds(undefined), null, "sem parâmetro é sem recorte");
  assert.strictEqual(recorteDeIds(""), null);

  assert.deepStrictEqual(recorteDeIds("lixo"), [], "id inválido é recorte vazio");
  assert.strictEqual(recorteDeIds("6512f1c0c0c0c0c0c0c0c0c1").length, 1);
  assert.strictEqual(recorteDeIds("6512f1c0c0c0c0c0c0c0c0c1, lixo").length, 1);
});

test("o mesmo vale para a lista que já está na memória", () => {
  const linhas = [{ id: "m1" }, { id: "v2" }, { id: "m3" }];

  assert.strictEqual(somenteEscolhidos(linhas, undefined).length, 3);
  assert.deepStrictEqual(somenteEscolhidos(linhas, "m1,m3").map((l) => l.id), ["m1", "m3"]);
  assert.deepStrictEqual(somenteEscolhidos(linhas, "nada"), []);
});

// ── O TETO ────────────────────────────────────────────────────────────────

test("a exportação não sai cortada em 200 — e a query continua presa nele", () => {
  // O defeito que isto fecha: a planilha pedia 5000, o clamp devolvia 200, e o
  // arquivo saía com duzentas linhas sem uma palavra dizendo que faltava o
  // resto. Numa conta de quinhentos alunos, alguém manda a lista para a
  // contabilidade faltando trezentas pessoas.
  const tela = { padrao: 25, maximo: 200 };

  assert.strictEqual(porPagina(999999, tela), 200, "a rede não escolhe o teto");
  assert.strictEqual(porPagina(undefined, tela), 25);

  assert.strictEqual(porPagina(undefined, { ...tela, exportando: true }), 5000);
  assert.strictEqual(porPagina(999999, { ...tela, exportando: true }), 5000);
});

// ── O TETO, QUANDO ELE CORTA ──────────────────────────────────────────────

test("quando o teto corta, o ARQUIVO diz — na planilha e no papel", async () => {
  // *"o backend gerar esse xlsx com TUDO"* (24/09/2026), e "tudo" tem um
  // limite. Cinco mil linhas e nenhuma pista de que faltam as outras é o mesmo
  // defeito do clamp de 200, só que mais raro — e mais raro é pior, porque
  // ninguém está esperando por ele.
  const t = rotulador("pt-BR");
  const colunas = [{ rotulo: "Nome", largura: 20, valor: (l) => l.name }];
  const muitas = Array.from({ length: 5000 }, (_, i) => ({ name: "n" + i }));

  const aba = await abrir(await planilha({ titulo: "T", colunas, linhas: muitas, lang: "pt-BR", t }));

  // Cabeçalho + 5000 + uma em branco + o aviso.
  assert.strictEqual(aba.rowCount, 5003);
  assert.match(String(aba.getRow(5003).getCell(1).value), /5000/);

  const html = documento({ titulo: "T", colunas, linhas: muitas, lang: "pt-BR", recorte: "Todos" });
  assert.match(html, /Todos ·/);
  assert.match(html, /5000/);
});

test("uma lista que NÃO bateu no teto não ganha aviso nenhum", async () => {
  const t = rotulador("pt-BR");
  const colunas = [{ rotulo: "Nome", largura: 20, valor: (l) => l.name }];
  const poucas = [{ name: "Ana" }, { name: "Bruno" }];

  const aba = await abrir(await planilha({ titulo: "T", colunas, linhas: poucas, lang: "pt-BR", t }));
  assert.strictEqual(aba.rowCount, 3);

  const html = documento({ titulo: "T", colunas, linhas: poucas, lang: "pt-BR", recorte: "2 marcadas" });
  assert.ok(!html.includes("couberam"));
});


// ── O HISTÓRICO DE UM FUNCIONÁRIO ─────────────────────────────────────────

test("sem a chave da folha, o reajuste continua na história — sem o valor", async () => {
  // *"esconder a linha inteira faria a história mentir por omissão"*. Mostrar o
  // valor seria a planilha vazando salário, que é pior: ela sai do sistema e
  // vira arquivo no computador de alguém.
  const t = rotulador("pt-BR");
  const reajuste = { ...LINHA, tipo: "reajuste", amount: 280000 };

  const comFolha = LISTAS.historicoDoFuncionario.colunas(
    t,
    CONTEXTO({ linhas: [reajuste] })
  );
  const semFolha = LISTAS.historicoDoFuncionario.colunas(
    t,
    CONTEXTO({ linhas: [{ ...reajuste, amount: 0 }], user: { _id: "u1", permissions: ["employees.view"] } })
  );

  assert.ok(comFolha.some((c) => c.rotulo === "Salário"));
  assert.ok(!semFolha.some((c) => c.rotulo === "Salário"));
  // A linha continua existindo nas duas.
  assert.ok(semFolha.some((c) => c.rotulo === "Tipo"));
});

test("as colunas que não têm o que mostrar não aparecem", () => {
  // Uma coluna "Gravidade" em branco numa lista sem advertência nenhuma parece
  // cadastro incompleto — e são cinco colunas de largura que o papel não tem.
  const t = rotulador("pt-BR");

  const so = (linhas) =>
    LISTAS.historicoDoFuncionario.colunas(t, CONTEXTO({ linhas })).map((c) => c.rotulo);

  const magra = so([{ tipo: "anotacao", data: "2026-09-01", texto: "ok", ciente: false }]);

  assert.ok(!magra.includes("Gravidade"));
  assert.ok(!magra.includes("Até"));
  assert.ok(!magra.includes("Falta justificada"));
  assert.ok(magra.includes("Tipo"));
  assert.ok(magra.includes("O que aconteceu"));

  const cheia = so([LINHA, { ...LINHA, tipo: "falta" }]);
  assert.ok(cheia.includes("Gravidade"));
  assert.ok(cheia.includes("Até"));
  assert.ok(cheia.includes("Falta justificada"));
});

test("'não justificada' só se diz de uma FALTA", () => {
  // Numa linha de férias, isso seria uma afirmação sobre coisa nenhuma.
  const t = rotulador("pt-BR");
  const linhas = [{ ...LINHA, tipo: "falta" }, { ...LINHA, tipo: "ferias" }];

  const coluna = LISTAS.historicoDoFuncionario
    .colunas(t, CONTEXTO({ linhas }))
    .find((c) => c.rotulo === "Falta justificada");

  assert.strictEqual(coluna.valor(linhas[0]), "não justificada");
  assert.strictEqual(coluna.valor(linhas[1]), "");
});

test("a ciência é coluna, e não detalhe", () => {
  // Sem a assinatura — ou a recusa testemunhada —, a advertência não sustenta
  // nada depois. Quem confere o histórico está justamente conferindo isso.
  const t = rotulador("pt-BR");
  const coluna = LISTAS.historicoDoFuncionario
    .colunas(t, CONTEXTO({ linhas: [LINHA] }))
    .find((c) => c.rotulo === "O funcionário ficou ciente");

  assert.strictEqual(coluna.valor({ ciente: true }), "Sim");
  assert.strictEqual(coluna.valor({ ciente: false }), "Não");
});


// ── OS FORNECEDORES ───────────────────────────────────────────────────────

test("a coluna que justifica a lista é QUANTAS CONTAS cada um tem", () => {
  // Sem ela isto é um apanhado de nomes; com ela dá para ver o que é fornecedor
  // de verdade e o que é cadastro criado por engano e nunca usado.
  const t = rotulador("pt-BR");
  const coluna = LISTAS.fornecedores
    .colunas(t, CONTEXTO({ linhas: [LINHA] }))
    .find((c) => c.rotulo === "Contas a pagar");

  assert.strictEqual(coluna.valor(LINHA), 12);
  assert.strictEqual(coluna.valor({}), 0);
  assert.strictEqual(coluna.direita, true);
});

test("as colunas de cadastro mínimo não aparecem vazias", () => {
  // O cadastro mínimo é nome e categoria: CNPJ, contato e situação quase sempre
  // estão em branco, e três colunas vazias fazem a planilha parecer cadastro
  // incompleto.
  const t = rotulador("pt-BR");
  const so = (linhas) => LISTAS.fornecedores.colunas(t, CONTEXTO({ linhas })).map((c) => c.rotulo);

  const magra = so([{ name: "Padaria", categoria: "outros", active: true }]);
  assert.deepStrictEqual(magra, ["Nome", "Categoria padrão", "Descrição padrão", "Contas a pagar"]);

  const cheia = so([LINHA, { ...LINHA, active: false }]);
  assert.ok(cheia.includes("CNPJ ou CPF"));
  assert.ok(cheia.includes("Quem atende"));
  assert.ok(cheia.includes("Status"));
});


// ── AS CONTAS A PAGAR ─────────────────────────────────────────────────────

test("a situação da conta é o RELÓGIO, e não o campo gravado", () => {
  // Só `paid` e `canceled` estão no banco: "atrasada" é calculada do
  // vencimento. Ler o campo faria a folha dizer "em aberto" numa conta vencida
  // há três meses.
  const t = rotulador("pt-BR");
  const coluna = LISTAS.contas
    .colunas(t, CONTEXTO({ linhas: [LINHA] }))
    .find((c) => c.rotulo === "Situação");

  assert.strictEqual(coluna.valor({ status: "open", atrasada: true }), t("finance.status.late"));
  assert.strictEqual(coluna.valor({ status: "open", atrasada: false }), t("finance.status.open"));
  assert.strictEqual(coluna.valor({ status: "paid" }), t("finance.status.paid"));
});

test("sem unidade é 'Da casa toda', e não uma célula em branco", () => {
  // O contador e o software não pertencem a filial nenhuma — é um recorte de
  // verdade, e em branco a planilha pareceria cadastro pela metade.
  const t = rotulador("pt-BR");
  const coluna = LISTAS.contas
    .colunas(t, CONTEXTO({ linhas: [LINHA] }))
    .find((c) => c.rotulo === "Unidade");

  assert.strictEqual(coluna.valor({ unit: "u1" }), "Niterói");
  assert.strictEqual(coluna.valor({ unit: null }), "Da casa toda");
});

test("com a LENTE numa unidade, a coluna dela some da planilha também", () => {
  // Todas as linhas diriam "Niterói" — e o recorte impresso no alto da folha já
  // conta isso. É a mesma regra da tela: *"se escolhi Niterói, não precisa
  // mostrar coluna unidade"*.
  const t = rotulador("pt-BR");

  const semLente = LISTAS.contas.colunas(t, CONTEXTO({ linhas: [LINHA] })).map((c) => c.rotulo);
  const comLente = LISTAS.contas
    .colunas(t, CONTEXTO({ linhas: [LINHA], query: { unit: "u1" } }))
    .map((c) => c.rotulo);

  assert.ok(semLente.includes("Unidade"));
  assert.ok(!comLente.includes("Unidade"));
});

test("observação e unidade só aparecem quando há o que mostrar", () => {
  const t = rotulador("pt-BR");
  const so = (linhas) => LISTAS.contas.colunas(t, CONTEXTO({ linhas })).map((c) => c.rotulo);

  const magra = so([{ description: "Luz", unit: null, note: "" }]);
  assert.ok(!magra.includes("Unidade"));
  assert.ok(!magra.includes("Observação"));

  const cheia = so([{ ...LINHA, note: "pagar no boleto" }]);
  assert.ok(cheia.includes("Unidade"));
  assert.ok(cheia.includes("Observação"));
});
