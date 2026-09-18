const test = require("node:test");
const assert = require("node:assert/strict");

const Finance_model = require("../../model/Finance_model.js");

// A CARTEIRA, uma PÁGINA por vez.
//
// A lista inteira vinha de uma vez e o navegador cortava, ordenava e buscava.
// Funciona com duzentas cobranças e cai com vinte mil — e, pior, a ORDEM deixa
// de ser ordem: ordenar as quinze linhas carregadas dá a ordem das quinze.
//
// Isto aqui não mede tempo: mede a FORMA DO PIPELINE, que é onde moram as
// decisões. A separação do `$facet` É a regra de negócio, e é o tipo de coisa
// que não quebra teste nenhum quando alguém a desfaz — só passa a mostrar um
// número errado com toda a confiança.
function fakeModel({ rows = [], total = 0, resumo = null } = {}) {
  const chamadas = [];

  const model = new Finance_model({});
  model.charges = async () => ({
    aggregate(pipeline, opcoes) {
      chamadas.push({ pipeline, opcoes });
      return {
        async toArray() {
          return [{ rows, total: total ? [{ n: total }] : [], resumo: resumo ? [resumo] : [] }];
        },
      };
    },
  });

  return { model, chamadas };
}

const ramo = (pipeline, nome) => pipeline.find((e) => e.$facet).$facet[nome];

// `find((e) => e.$skip)` NÃO acha `{ $skip: 0 }` — zero é falso, e a primeira
// página é justamente `$skip: 0`. Procurar pela CHAVE evita o caso em que o
// teste passa por não ter achado o que devia conferir.
const estagio = (estagios, chave) => estagios.find((e) => chave in e);
const nomes = (estagios) => estagios.map((e) => Object.keys(e)[0]);
const texto = (x) => JSON.stringify(x);

test("uma ida ao banco, e três respostas", async () => {
  // Página, contagem e resumo saem do MESMO pipeline. Três consultas seriam
  // três varreduras da mesma janela para desenhar uma tela.
  const { model, chamadas } = fakeModel();
  await model.carteira({ de: "2026-09-01", ate: "2026-09-30" });

  assert.equal(chamadas.length, 1);
  const facet = chamadas[0].pipeline.find((e) => e.$facet);
  assert.deepEqual(Object.keys(facet.$facet).sort(), ["resumo", "rows", "total"]);
});

test("o RESUMO não enxerga o recorte — é a janela inteira", async () => {
  // *"cada vez que eu troco de aba, os valores ali em cima mudam"*. A pergunta
  // dos três cartões é "como está o mês", e ela não muda porque alguém quis ver
  // só uma parte da lista. Este é o caso que impede o `$match` de voltar para
  // dentro do ramo do resumo.
  const { model, chamadas } = fakeModel();
  await model.carteira({ status: "open,late", busca: "ana" });

  const doResumo = ramo(chamadas[0].pipeline, "resumo");
  assert.deepEqual(nomes(doResumo), ["$group"], "o resumo agrupa e mais nada");
  assert.ok(!texto(doResumo).includes("ana"), "a busca não pode alcançar o resumo");
});

test("a página e a contagem enxergam o MESMO recorte", async () => {
  // Se divergirem, a tela mostra "1–15 de 300" e pagina sobre outra coisa.
  const { model, chamadas } = fakeModel();
  await model.carteira({ status: "open", busca: "mensalidade" });

  const daPagina = ramo(chamadas[0].pipeline, "rows");
  const daContagem = ramo(chamadas[0].pipeline, "total");

  const filtrosDaPagina = daPagina.filter((e) => e.$match);
  const filtrosDaContagem = daContagem.filter((e) => e.$match);

  assert.deepEqual(filtrosDaPagina, filtrosDaContagem);
  assert.ok(filtrosDaPagina.length > 0, "havia recorte a aplicar");
});

test("o corte pede a página certa ao banco", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({ pagina: 3, limite: 20 });

  const daPagina = ramo(chamadas[0].pipeline, "rows");
  assert.deepEqual(estagio(daPagina, "$skip"), { $skip: 40 });
  assert.deepEqual(estagio(daPagina, "$limit"), { $limit: 20 });
});

test("limite absurdo é contido antes de virar consulta", async () => {
  const { model, chamadas } = fakeModel();
  const r = await model.carteira({ limite: 100000, pagina: -5 });

  const daPagina = ramo(chamadas[0].pipeline, "rows");
  assert.deepEqual(estagio(daPagina, "$limit"), { $limit: 200 });
  // Página zero ou negativa vira a primeira, e não um `$skip` negativo — que o
  // Mongo recusa com erro.
  assert.deepEqual(estagio(daPagina, "$skip"), { $skip: 0 });
  assert.equal(r.pagina, 1);
});

test("a ordem sai de uma lista fechada, e o desempate é estável", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({ ordem: "person", direcao: "asc" });

  const ordenacao = estagio(ramo(chamadas[0].pipeline, "rows"), "$sort").$sort;

  assert.equal(ordenacao.studentName, 1);
  // Vazio sempre no fim, nas duas direções.
  assert.equal(ordenacao.__vazio, 1);
  // Sem um critério estável, duas cobranças com o mesmo vencimento trocam de
  // lugar entre uma página e outra — e aí uma some e outra aparece duas vezes.
  assert.equal(ordenacao._id, 1);
});

test("campo de ordenação inventado cai no vencimento, e não vira consulta torta", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({ ordem: "'; drop", direcao: "asc" });

  const ordenacao = estagio(ramo(chamadas[0].pipeline, "rows"), "$sort").$sort;
  assert.ok("dueDate" in ordenacao);
  assert.ok(!texto(ordenacao).includes("drop"));
});

test("a busca vai para o BANCO, e escapa o que o usuário digitou", async () => {
  // Ela era um `filter` em JavaScript sobre a lista inteira — o que só funciona
  // enquanto a lista inteira vem. E como agora vira regex, um "(" digitado na
  // caixa de busca derrubaria a consulta se não fosse escapado.
  const { model, chamadas } = fakeModel();
  await model.carteira({ busca: "a(b" });

  const filtro = ramo(chamadas[0].pipeline, "rows").find((e) => e.$match && e.$match.$or);
  const comoTexto = texto(filtro);

  assert.ok(comoTexto.includes("studentName"), "busca por nome");
  assert.ok(comoTexto.includes("description"), "e por descrição");
  assert.doesNotThrow(() => new RegExp(filtro.$match.$or[0].studentName.$regex));
});

test("`late` não vira filtro de campo — ela é calculada", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({ status: "late" });

  const filtro = ramo(chamadas[0].pipeline, "rows").find((e) => e.$match && e.$match.$or);
  assert.deepEqual(filtro.$match.$or, [{ atrasada: true }]);
});

test("dois status somam, em vez de um substituir o outro", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({ status: "open,late" });

  const filtro = ramo(chamadas[0].pipeline, "rows").find((e) => e.$match && e.$match.$or);
  assert.deepEqual(filtro.$match.$or, [{ status: { $in: ["open"] } }, { atrasada: true }]);
});

test("status desconhecido é tratado como SEM filtro", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({ status: "inventado" });

  const daPagina = ramo(chamadas[0].pipeline, "rows");
  assert.equal(daPagina.filter((e) => e.$match).length, 0, "nada reconhecido = tudo");
});

test("a junção com pagamentos só soma o que ENTROU, e NÃO por `status: paid`", async () => {
  // Pendente é promessa, reembolsado é dinheiro que voltou, cancelado é
  // lançamento que não devia existir.
  //
  // O filtro é `$nin` e não `status: "paid"` porque pagamento ANTIGO não tem o
  // campo, e ausente significa pago. O literal os deixaria de fora — e o
  // "Recebido" da carteira discordaria do total da ficha da pessoa, que soma em
  // JavaScript e trata ausente como pago.
  const statusDePagamento = require("../../lib/statusDePagamento.js");
  const { model, chamadas } = fakeModel();
  await model.carteira({});

  const juncao = chamadas[0].pipeline.find((e) => e.$lookup?.from === "payments");
  const filtro = juncao.$lookup.pipeline.find((e) => e.$match).$match;

  assert.deepEqual(filtro.status, { $nin: statusDePagamento.NAO_ENTRAM });
  assert.ok(statusDePagamento.NAO_ENTRAM.includes("canceled"));
  assert.ok(!texto(juncao).includes('"status":"paid"'), "nada de literal");
});

test("o documento da PESSOA é recortado antes de sair da junção", async () => {
  // Ela tem senha, sal e ficha inteira. Três campos é o que a tela e a planilha
  // usam — trazer o resto seria mandar a senha de todo mundo para o navegador.
  const { model, chamadas } = fakeModel();
  await model.carteira({});

  const juncao = chamadas[0].pipeline.find((e) => e.$lookup?.from === "users");
  const projecao = juncao.$lookup.pipeline.find((e) => e.$project).$project;

  assert.deepEqual(Object.keys(projecao).sort(), ["email", "name", "phone"]);
  assert.ok(!("password" in projecao));
});

test("a janela vira filtro de VENCIMENTO, e é o primeiro estágio", async () => {
  // Primeiro porque é o único que usa índice: depois de um `$lookup` o Mongo já
  // não o aproveita, e a consulta passa a varrer as cobranças do cliente todo.
  const { model, chamadas } = fakeModel();
  await model.carteira({ de: "2026-09-01", ate: "2026-09-30", fuso: "America/Sao_Paulo" });

  const primeiro = chamadas[0].pipeline[0];
  assert.ok(primeiro.$match.dueDate.$gte instanceof Date);
  assert.ok(primeiro.$match.dueDate.$lte instanceof Date);
});

test("sem janela, o primeiro estágio não inventa filtro", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({});
  assert.deepEqual(chamadas[0].pipeline[0], { $match: {} });
});

test("a ordenação usa collation do banco, e não localeCompare", async () => {
  // É ela que faz "Ávila" cair perto de "Avila", e não depois de "Zanetti".
  const { model, chamadas } = fakeModel();
  await model.carteira({ ordem: "person" });

  assert.deepEqual(chamadas[0].opcoes.collation, { locale: "pt", strength: 1 });
});

test("resumo vazio vira zeros, e não undefined na tela", async () => {
  // Janela sem nenhuma cobrança faz o `$group` não devolver documento nenhum.
  const { model } = fakeModel({ rows: [], total: 0, resumo: null });
  const r = await model.carteira({});

  assert.deepEqual(r.resumo, {
    recebido: 0,
    aReceber: 0,
    atrasado: 0,
    quantasAtrasadas: 0,
    quantasAbertas: 0,
    total: 0,
  });
  assert.equal(r.total, 0);
});

test("o resumo soma o que entrou e o que FALTA das abertas", async () => {
  // A aritmética que o resumo fazia em JavaScript virou `$group`, e ela tem
  // regras que não são óbvias:
  //
  //   recebido   TODO pagamento, mesmo o de uma cobrança cancelada depois —
  //              cancelar não desfaz o dinheiro que entrou.
  //   aReceber   só o que falta das ABERTAS. Somar o que falta de uma cancelada
  //              seria prometer dinheiro que ninguém vai cobrar.
  //   atrasado   o que falta das atrasadas, que é um subconjunto das abertas.
  const { model, chamadas } = fakeModel();
  await model.carteira({});

  const grupo = ramo(chamadas[0].pipeline, "resumo")[0].$group;

  assert.deepEqual(grupo.recebido, { $sum: "$pago" });
  assert.deepEqual(grupo.aReceber, {
    $sum: { $cond: [{ $eq: ["$status", "open"] }, "$falta", 0] },
  });
  assert.deepEqual(grupo.atrasado, { $sum: { $cond: ["$atrasada", "$falta", 0] } });
});

test("ATRASADA é calculada, e nunca lida de um campo", async () => {
  // É uma cobrança ABERTA cuja data passou. Gravá-la exigiria alguém varrer o
  // banco à meia-noite — e uma cobrança já paga nunca pode entrar aqui.
  const { model, chamadas } = fakeModel();
  await model.carteira({});

  const calculado = chamadas[0].pipeline.find((e) => e.$addFields?.atrasada);
  const condicoes = texto(calculado.$addFields.atrasada);

  assert.ok(condicoes.includes('"$status","open"'.replace(/"/g, '"')) || condicoes.includes("open"));
  assert.ok(condicoes.includes("$falta"), "quem já pagou não está atrasado");
  assert.ok(condicoes.includes("dueDate"));
});
