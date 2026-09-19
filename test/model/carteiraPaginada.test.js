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
  // Ela tem senha, sal e ficha inteira. Quatro campos é o que a tela e a
  // planilha usam — trazer o resto seria mandar a senha de todo mundo para o
  // navegador.
  //
  // `avatarAt` é um CARIMBO DE DATA, não a foto: diz se existe uma e de quando
  // é. A foto em si nunca passa por aqui — ela tem rota própria, com sessão.
  //
  // `unit` é o id da unidade da pessoa. Ele entra porque a LENTE filtra por
  // ele e a coluna o mostra — e porque a unidade é da PESSOA, não da cobrança:
  // guardá-la na cobrança criaria a pergunta "e quando o aluno muda de
  // unidade?", cuja resposta honesta seria "as cobranças antigas mentem".
  //
  // Esta lista é para ser CHATA de mudar. Quem acrescentar um campo aqui está
  // decidindo mandá-lo ao navegador de quem abre o financeiro, e o teste
  // quebrando é o momento de perguntar se é isso mesmo.
  const { model, chamadas } = fakeModel();
  await model.carteira({});

  const juncao = chamadas[0].pipeline.find((e) => e.$lookup?.from === "users");
  const projecao = juncao.$lookup.pipeline.find((e) => e.$project).$project;

  assert.deepEqual(Object.keys(projecao).sort(), ["avatarAt", "email", "name", "phone", "unit"]);
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

// ── A LENTE DA UNIDADE NO FINANCEIRO ────────────────────────────────────
//
// *"o financeiro ainda puxa tudo, precisa por a coluna de unidade se eu tiver
// filtrando por todas e se tem pelo menos 2"*.
test("com lente, filtra pela unidade da PESSOA", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({ unit: "6a80de570056d24c09f5da61" });

  const filtro = chamadas[0].pipeline.find((e) => e.$match?.studentUnit);
  assert.ok(filtro, "a consulta não recebeu a lente");
  assert.equal(String(filtro.$match.studentUnit), "6a80de570056d24c09f5da61");
});

test("a lente entra DEPOIS da junção e ANTES do facet", async () => {
  // Depois da junção porque é ali que a unidade aparece. Antes do `$facet`
  // porque é o que faz os três cartões do topo falarem da mesma unidade que a
  // lista embaixo — números que não batem com a lista do lado são piores que
  // números ausentes.
  const { model, chamadas } = fakeModel();
  await model.carteira({ unit: "6a80de570056d24c09f5da61" });

  const etapas = chamadas[0].pipeline;
  const juncao = etapas.findIndex((e) => e.$lookup?.from === "users");
  const lente = etapas.findIndex((e) => e.$match?.studentUnit);
  const facet = etapas.findIndex((e) => e.$facet);

  assert.ok(juncao < lente, "a lente veio antes da junção");
  assert.ok(lente < facet, "a lente veio depois do facet");
});

test("sem lente, nada muda na consulta", async () => {
  const { model, chamadas } = fakeModel();
  await model.carteira({});

  assert.equal(
    chamadas[0].pipeline.find((e) => e.$match?.studentUnit),
    undefined
  );
});

test("lente com id inválido é ignorada — e não esvazia o financeiro", async () => {
  for (const lixo of ["nada", "", "123"]) {
    const { model, chamadas } = fakeModel();
    await model.carteira({ unit: lixo });

    assert.equal(
      chamadas[0].pipeline.find((e) => e.$match?.studentUnit),
      undefined,
      String(lixo)
    );
  }
});

// ── O RECORTE POR ID ──────────────────────────────────────────────────────
//
// Uma lista de ids, para a folha impressa das cobranças marcadas. Ela abre por
// link, sem a tela atrás, e precisa buscar de novo exatamente aquelas linhas.
test("os ids escolhidos viram um $in, e vêm ANTES dos outros recortes", async () => {
  // Primeiro porque é o corte mais estreito: pô-lo depois faria o banco rodar
  // regex de busca em milhares de linhas para jogar fora todas menos cinco.
  const { model, chamadas } = fakeModel();
  await model.carteira({
    ids: "68c9f6b1a2b3c4d5e6f70011,68c9f6b1a2b3c4d5e6f70022",
    busca: "ana",
  });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  const primeiro = linhas.find((e) => e.$match);

  assert.ok(texto(primeiro).includes("$in"), "o primeiro recorte tem de ser o dos ids");
  assert.ok(texto(primeiro).includes("_id"));
});

test("id inválido é descartado, e não vira consulta quebrada", async () => {
  // Um id colado errado no endereço não pode derrubar a folha inteira.
  const { model, chamadas } = fakeModel();
  await model.carteira({ ids: "68c9f6b1a2b3c4d5e6f70011,nao-e-id, ,," });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  const comIn = linhas.filter((e) => e.$match && texto(e.$match).includes("$in"));

  assert.equal(comIn.length, 1);
  // Um só sobrou.
  assert.equal(comIn[0].$match._id.$in.length, 1);
});

test("sem ids, não há recorte por id nenhum", async () => {
  // Uma lista vazia não pode virar `$in: []`, que casaria com NADA — a tela
  // ficaria em branco sem ninguém entender por quê.
  const { model, chamadas } = fakeModel();
  await model.carteira({ ids: "" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.ok(!linhas.some((e) => e.$match && texto(e.$match).includes("_id")));
});

test("o RESUMO não enxerga o recorte por id", async () => {
  // Os três cartões do topo falam do mês inteiro. Marcar cinco linhas para
  // imprimir não pode fazer o "recebido no mês" virar o das cinco.
  const { model, chamadas } = fakeModel();
  await model.carteira({ ids: "68c9f6b1a2b3c4d5e6f70011" });

  const resumo = ramo(chamadas[0].pipeline, "resumo");
  assert.ok(!texto(resumo).includes("$in"));
});

// ── OS RECEBIMENTOS ───────────────────────────────────────────────────────
//
// *"eu cadastrei esse pagamento, mas não aparece aqui em financeiro"*.
//
// A carteira parte de `charges`. Um pagamento AVULSO — sem cobrança do outro
// lado — não tem como virar linha ali: ele não estava filtrado, não tinha onde
// aparecer. R$ 75 de uma camisa sumidos do relatório do mês.
function fakeRecebimentos({ rows = [], total = 0, resumo = null } = {}) {
  const chamadas = [];

  const model = new Finance_model({});
  model.payments = async () => ({
    aggregate(pipeline) {
      chamadas.push({ pipeline });
      return {
        async toArray() {
          return [{ rows, total: total ? [{ n: total }] : [], resumo: resumo ? [resumo] : [] }];
        },
      };
    },
  });

  return { model, chamadas };
}

test("a janela é a DATA DO PAGAMENTO, e não o vencimento de nada", async () => {
  // É o que separa as duas perguntas: "o que me devem" olha vencimento, "o que
  // entrou" olha quando entrou. Um pagamento de setembro numa cobrança de
  // agosto é caixa de setembro.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ de: "2026-09-01", ate: "2026-09-30" });

  const primeiro = chamadas[0].pipeline[0];
  assert.ok(primeiro.$match.date, "a janela tem de ser sobre `date`");
  assert.ok(!texto(primeiro).includes("dueDate"));
});

test("o pagamento AVULSO entra na lista", async () => {
  // A junção com a cobrança é `$lookup`, e não `$match`: sem cobrança ela
  // devolve vazio e a linha continua inteira. Um `$match` a eliminaria — que é
  // exatamente o defeito que esta consulta existe para não ter.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({});

  const juncoes = chamadas[0].pipeline.filter((e) => e.$lookup);
  const comCobranca = juncoes.find((e) => e.$lookup.from === "charges");

  assert.ok(comCobranca, "a cobrança tem de vir por junção");
  assert.ok(!texto(chamadas[0].pipeline).includes('"charge":{"$ne":null}'));
});

test("o RESUMO separa os QUATRO estados", async () => {
  // Um cartão por estado, e não um só com tudo somado: cada um responde uma
  // pergunta diferente, e juntá-los faria o caixa do mês mostrar dinheiro que
  // não está na conta.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({});

  const resumo = texto(ramo(chamadas[0].pipeline, "resumo"));
  for (const chave of ["recebido", "pendente", "reembolsado", "cancelado"]) {
    assert.ok(resumo.includes(chave), `faltou ${chave} no resumo`);
  }
});

test("o resumo lê o lançamento ANTIGO como pago", async () => {
  // Ele não tem o campo, e ausente sempre significou pago. Sem o `$ifNull` os
  // mais antigos da conta cairiam fora de todos os três cartões.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({});

  assert.ok(texto(ramo(chamadas[0].pipeline, "resumo")).includes("$ifNull"));
});

test("o resumo NÃO enxerga a busca nem a lente", async () => {
  // A mesma regra da carteira: os cartões falam da janela, não da parte da
  // lista que alguém resolveu ver.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ busca: "ana", unit: "68c9f6b1a2b3c4d5e6f70011" });

  const resumo = ramo(chamadas[0].pipeline, "resumo");
  assert.ok(!texto(resumo).includes("ana"));
  assert.ok(!texto(resumo).includes("studentUnit"));
});

test("a lente da unidade filtra pela unidade da PESSOA", async () => {
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ unit: "68c9f6b1a2b3c4d5e6f70011" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.ok(texto(linhas).includes("studentUnit"));
});

test("a ordem sai de uma lista fechada", async () => {
  // O campo vai para dentro de um `$sort`; aceitar o que vier é deixar a tela
  // escolher por qual chave o banco trabalha.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ ordem: "'; drop", direcao: "asc" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.deepEqual(estagio(linhas, "$sort").$sort, { date: 1, _id: 1 });
});

test("limite absurdo é contido antes de virar consulta", async () => {
  const { model } = fakeRecebimentos();
  const r = await model.recebimentos({ limite: 100000, pagina: -5 });

  assert.equal(r.limite, 200);
  assert.equal(r.pagina, 1);
});

test("os ESTADOS pedidos filtram os recebimentos", async () => {
  // *"nós temos status pago pendente reembolsado e cancelado"*. Quatro, e são
  // outros que os da cobrança.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ status: "pending,refunded" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.ok(texto(linhas).includes("pending"));
  assert.ok(texto(linhas).includes("refunded"));
});

test("pedir PAGO alcança o lançamento antigo, que não tem o campo", async () => {
  // Ausente sempre significou pago. Um `$in: ["paid"]` literal deixaria de fora
  // justamente os mais antigos da conta — e o relatório perderia dinheiro real.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ status: "paid" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.ok(texto(linhas).includes('"$exists":false'));
});

test("estado inventado não vira consulta", async () => {
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ status: "'; drop" });

  const linhas = ramo(chamadas[0].pipeline, "rows");
  assert.ok(!texto(linhas).includes("drop"));
});

test("o RESUMO continua cego ao estado pedido", async () => {
  // Marcar "pendente" para conferir uma lista não pode fazer o "recebido" do
  // mês virar zero — os cartões falam da janela.
  const { model, chamadas } = fakeRecebimentos();
  await model.recebimentos({ status: "pending" });

  // O resumo TEM "pending" — ele é um dos cartões. O que ele não pode ter é o
  // `$in` do filtro PEDIDO, que é o que o amarraria ao recorte da lista.
  const resumo = ramo(chamadas[0].pipeline, "resumo");
  assert.ok(texto(resumo).includes("pendente"), "pendente é um cartão");
  assert.ok(!texto(resumo).includes("$in\":"), "o resumo não enxerga o estado pedido");
});
