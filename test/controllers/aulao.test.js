const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const AulaoController = require("../../controllers/Aulao.js");
const Aulao = require("../../model/Aulao_model.js");

// ── OS AULÕES (16/09/2026) ────────────────────────────────────────────────
//
// "vou cadastrar esse aulão, com nome, data e horário, uma descrição, endereço
// etc., e uma foto de capa. (...) vagas, se é cobrado ou não, se cobrar aí cria
// a cobrança e notifica."
//
// O que estes casos travam é o DINHEIRO e as VAGAS — as duas coisas em que um
// erro não aparece na tela: aparece como alguém cobrado duas vezes, ou como
// trinta e uma pessoas num aulão de trinta.
const USER = { _id: "6a7cbba1d2908f75788e92bf", name: "Marlon" };
const PESSOA = "6a7f8e18ac5f3b34bb4e4723";
const CRIADA = "6a7f8e18ac5f3b34bb4e47ff";

// `pessoaPorTelefone` é o que decide entre ACHAR e CRIAR no caminho manual — e
// é a diferença entre reusar a ficha do aluno e duplicá-la.
function monta({
  aulao,
  inscritos = 0,
  cobrancaExistente = null,
  pessoaPorTelefone = null,
  // Quanto JÁ foi pago de cada cobrança. É o que separa "quitar" de "quitar de
  // novo", e o que faz o pagamento lançado ser o que FALTA.
  jaPago = {},
  // Os pagamentos QUE EXISTEM naquela cobrança. É o que decide entre apagar,
  // apagar o único, e não tocar em parciais.
  pagamentosDaCobranca = [],
  // O teto do plano já atingido: é o que prova que duplicar não é porta de fundo.
  limiteEstourado = false,
} = {}) {
  const feito = {
    cobrancas: [],
    avisos: [],
    inscritos: [],
    criadas: [],
    vinculos: [],
    pagamentos: [],
    presencas: [],
    cobrancaFechada: null,
    pagamentosApagados: [],
    duplicado: null,
  };
  const permissao = permiteTudo(USER);

  const app = fakeApp({
    ...permissao,
    api: {
      aulao: {
        async byId() { return aulao; },
        async inscritos() { return []; },
        async contagemDeTodos() { return {}; },
        async list() { return aulao ? [aulao] : []; },
        async inscrever(id, person, opcoes) {
          if (!aulao) return { ok: false, erro: "nao_achei" };
          if (aulao.seats > 0 && inscritos >= aulao.seats) return { ok: false, erro: "lotado", aulao };
          // `novaPessoa` viaja junto: é o que a tela lê para dizer "novo pelo
          // link". Um dobro que o descartasse deixaria passar a troca dos dois.
          feito.inscritos.push({ person, origem: opcoes?.origem, novaPessoa: opcoes?.novaPessoa });
          return { ok: true, id: "i1", aulao };
        },
        async desinscrever() { return { ok: true }; },
        async marcarPresenca(id, person, presente) {
          feito.presencas.push({ person, presente });
          return { ok: true, presente: presente === null ? undefined : presente };
        },
        async insert() { return { ok: true, id: "a1", slug: "x" }; },
        // O dobro guarda o que foi PEDIDO, e repete a regra do modelo sobre o
        // que a cópia leva — é ela que está em teste.
        async duplicar(criadoPor, id, opcoes) {
          if (!aulao) return { ok: false, erro: "nao_achei" };

          feito.duplicado = {
            name: String(opcoes?.nome || "").trim() || aulao.name,
            description: aulao.description,
            address: aulao.address,
            minutes: aulao.minutes,
            seats: aulao.seats,
            priceCents: aulao.priceCents,
            published: false,
            showcase: false,
          };

          return { ok: true, id: "a2", slug: "x-2" };
        },
        async update() { return { ok: true }; },
        async remove() { return { ok: true }; },
      },
      user: {
        async data() { return { _id: PESSOA, name: "Carla", lang: "pt-BR" }; },
        async dataStudent() { return { _id: PESSOA, name: "Carla", lang: "pt-BR" }; },
        // O cenário manda quem o telefone acha. `null` é "não existe".
        async dataByPhone() { return pessoaPorTelefone; },
        async insertStudent(dono, obj) {
          feito.criadas.push({ dono: String(dono), ...obj });
          return CRIADA;
        },
        // `data()` devolve o documento CRU — sem `hasAccess`. Quem deriva é o
        // `filter`, e o controlador passa por ele de propósito: ver o comentário
        // do `temAcesso`.
        filter(doc) {
          if (!doc) return doc;
          const { password, salt, ...resto } = doc;
          resto.hasAccess = !!password;
          return resto;
        },
      },
      link: {
        async link(prof, pessoa, origem) {
          feito.vinculos.push({ prof: String(prof), pessoa: String(pessoa), origem });
        },
      },
      finance: {
        async chargeOfAulao() { return cobrancaExistente; },
        async insertCharge(student, obj) {
          feito.cobrancas.push({ student, ...obj });
          return "c1";
        },
        async cobrancasDeAulao() { return {}; },
        // O dobro repete a REGRA do modelo, e não um "ok": é ela que está em
        // teste. Um dobro que apagasse sempre deixaria passar justamente o caso
        // dos parciais.
        async reabrirCobranca() {
          const c = cobrancaExistente;
          if (!c) return { ok: false, erro: "nao_achei" };

          const automaticos = pagamentosDaCobranca.filter((x) => x.automatico === true);

          if (automaticos.length) {
            feito.pagamentosApagados.push(...automaticos.map((x) => x._id));
            return { ok: true, apagados: automaticos.length, falta: c.amount || 0 };
          }

          const pagos = pagamentosDaCobranca.filter((x) => x.status === "paid");

          if (pagos.length === 1 && (pagos[0].amount || 0) >= (c.amount || 0)) {
            feito.pagamentosApagados.push(pagos[0]._id);
            return { ok: true, apagados: 1, falta: c.amount || 0 };
          }

          if (pagos.length > 1) return { ok: true, apagados: 0, manual: true, falta: 0 };

          return { ok: true, apagados: 0, falta: Math.max(0, (c.amount || 0) - (pagos[0]?.amount || 0)) };
        },
        // O dobro faz a conta do MODELO, e não a que eu gostaria: é a soma dos
        // pagamentos comparada com o valor. Um dobro que devolvesse "ok" sempre
        // deixaria passar justamente o defeito de lançar o valor cheio.
        async quitarCobranca(chargeId) {
          const c = cobrancaExistente;
          if (!c) return { ok: false, erro: "nao_achei" };

          const falta = Math.max(0, (c.amount || 0) - (jaPago[String(chargeId)] || 0));

          if (falta <= 0) {
            feito.cobrancaFechada = String(chargeId);
            return { ok: true, erro: "ja_pago", falta: 0 };
          }

          feito.pagamentos.push({ charge: String(chargeId), amount: falta });
          feito.cobrancaFechada = String(chargeId);
          return { ok: true, pagamento: "p1", valor: falta };
        },
      },
      tenant: { async currencyFor() { return "BRL"; } },
    },
  });

  // `limiteDoPlano` lê o plano pelo `app.api.center`. Com o teto em ZERO ele
  // barra — é o caminho de verdade, e não um dobro da função de barrar.
  app.api.center = {
    async limitsFor() { return limiteEstourado ? { aulaoes: 0 } : {}; },
  };

  AulaoController(app);
  return { app, feito, pedidas: permissao.pedidas };
}

const PAGO = {
  _id: "a1",
  name: "Aulão de pernas",
  slug: "aulao-de-pernas",
  startsAt: new Date("2026-09-27T11:00:00Z"),
  minutes: 90,
  seats: 30,
  priceCents: 2500,
  published: true,
};

test("inscrever num aulão PAGO cria a cobrança, vencendo no DIA do aulão", async () => {
  // Não hoje: cobrar no ato transformaria uma inscrição feita com três semanas
  // de antecedência em pendência de três semanas no relatório.
  const { app, feito } = monta({ aulao: PAGO });
  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { person: PESSOA } });

  assert.equal(r.status, 201);
  assert.equal(feito.cobrancas.length, 1);
  assert.equal(feito.cobrancas[0].amount, 2500);
  assert.deepEqual(feito.cobrancas[0].dueDate, PAGO.startsAt);
  // O vínculo com o aulão: é ele que impede a segunda cobrança, e ele precisa
  // chegar ao modelo — `limparCobranca` descartaria um campo que não fosse
  // tratado explicitamente em `insertCharge`.
  assert.equal(String(feito.cobrancas[0].aulao), "a1");
});

test("aulão de GRAÇA não cria cobrança nenhuma", async () => {
  const { app, feito } = monta({ aulao: { ...PAGO, priceCents: 0 } });
  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { person: PESSOA } });

  assert.equal(r.status, 201);
  assert.deepEqual(feito.cobrancas, []);
});

test("quem sai e volta NÃO é cobrado duas vezes", async () => {
  // A cobrança não é apagada na saída — ela pode estar paga, e apagar
  // lançamento pago é apagar dinheiro que entrou. Então a segunda inscrição
  // tem de reconhecer a dívida que já existe.
  const { app, feito } = monta({ aulao: PAGO, cobrancaExistente: { _id: "c-antiga" } });
  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { person: PESSOA } });

  assert.equal(r.status, 201);
  assert.deepEqual(feito.cobrancas, [], "criou uma segunda cobrança");
  assert.equal(r.body.cobranca, "c-antiga");
});

test("aulão LOTADO recusa, e não cobra", async () => {
  // A ordem importa: recusar depois de cobrar deixaria dívida sem vaga.
  const { app, feito } = monta({ aulao: PAGO, inscritos: 30 });
  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { person: PESSOA } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "lotado");
  assert.deepEqual(feito.cobrancas, []);
});

test("vagas ZERO quer dizer SEM LIMITE, e não nenhuma vaga", async () => {
  // Aulão em parque não tem resposta para "quantas vagas?". Ler zero como
  // "lotado" fecharia a inscrição de todo aulão aberto.
  const { app } = monta({ aulao: { ...PAGO, seats: 0 }, inscritos: 500 });
  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { person: PESSOA } });

  assert.equal(r.status, 201);
});

test("a pessoa tem de ser da lista de quem chama", async () => {
  // Sem isto, um id de outra conta inscreveria alguém que este profissional não
  // acompanha — e criaria uma cobrança no nome dela.
  const { app, feito } = monta({ aulao: PAGO });
  app.api.user.dataStudent = async () => null;

  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { person: PESSOA } });
  assert.equal(r.status, 404);
  assert.deepEqual(feito.cobrancas, []);
});

test("as rotas são fechadas pelas chaves da AGENDA", async () => {
  // Não `aulao.*`: uma chave nova não chegaria a papel nenhum, porque
  // `ensureSystemRoles` só roda no provisionamento. Ver o cabeçalho do
  // controller.
  const { app, pedidas } = monta({ aulao: PAGO });
  await call(app, "get", "/aulaoes");
  await call(app, "post", "/aulaoes", { body: { name: "x", startsAt: new Date() } });

  assert.ok(pedidas.includes("schedule.view"));
  assert.ok(pedidas.includes("schedule.manage"));
});

// ── O SLUG ────────────────────────────────────────────────────────────────
test("o slug é legível, e sai do nome", async () => {
  // Ele vai num link de divulgação, lido em voz alta e digitado à mão. Um id
  // sorteado faria o endereço não dizer nada.
  assert.equal(Aulao.slugDe("Aulão de Pernas 27/09"), "aulao-de-pernas-27-09");
  assert.equal(Aulao.slugDe("  Treino   na  Praia!  "), "treino-na-praia");
});

test("o preço aceita as duas pontuações que se digitam", async () => {
  // "R$ 25,50" e "25.50" — a última pontuação manda. Adivinhar pelo primeiro
  // separador erraria "1.200,50".
  assert.equal(Aulao.centavos("R$ 25,50"), 2550);
  assert.equal(Aulao.centavos("25.50"), 2550);
  assert.equal(Aulao.centavos("1.200,00"), 120000);
  assert.equal(Aulao.centavos(""), 0);
});

// ── A VITRINE DA VAFIT (16/09/2026) ───────────────────────────────────────
//
// "pode criar lá no site a rota que verifica todo mundo que tem aulão
// disponível."
//
// É a ÚNICA leitura do produto que devolve dado de clientes diferentes na mesma
// resposta. Todas as outras passam por `lib/escopo.js`, que exige o `instance`
// em cada consulta — é ele que impede o dado de um cliente aparecer para outro.
//
// O que estes casos travam é o CONSENTIMENTO. Se algum dia alguém derivar
// `showcase` de `published` "por conveniência", o produto passa a divulgar o
// evento de todo cliente num site que não é o dele — com nome, foto, horário e
// endereço, que num estúdio pequeno é quase o endereço dele.
test("`showcase` é uma marca SEPARADA de `published`", async () => {
  // Publicar abre o aulão no endereço do próprio cliente. Aparecer na vitrine
  // da VAFIT é outra coisa, e nasce desligada.
  const s = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "model", "Aulao_model.js"),
    "utf8"
  );

  assert.ok(s.includes("showcase: obj.showcase === true"), "showcase deixou de ser campo próprio");
  assert.ok(
    !/showcase:\s*[^,\n]*published/.test(s),
    "showcase passou a ser DERIVADO de published — isso divulga cliente sem ele pedir"
  );
});

test("a leitura cruzada exige as três marcas, e os clientes ativos", async () => {
  // Um filtro que caia daqui não dá erro: dá aulão de rascunho, ou de cliente
  // que saiu do produto, aparecendo no site. Por isso a conferência é no fonte —
  // é onde a decisão mora.
  const s = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "model", "Aulao_model.js"),
    "utf8"
  );

  const consulta = s.slice(s.indexOf("paraVitrine"), s.indexOf("Aulao_model.prototype.remove"));

  assert.ok(consulta.includes("showcase: true"), "sem a marca de consentimento");
  assert.ok(consulta.includes("published: true"), "rascunho entraria na vitrine");
  assert.ok(consulta.includes("startsAt: { $gte: new Date() }"), "aulão passado entraria");
  assert.ok(consulta.includes("instance: { $in: ativos }"), "cliente desativado continuaria anunciando");
});

test("a projeção da vitrine é uma lista FECHADA", async () => {
  // É o que impede um campo novo do aulão de aparecer no site público por
  // acidente. Um `projection` ausente devolveria o documento inteiro — hoje
  // isso seria inofensivo, e no primeiro campo interno que alguém acrescentar
  // deixa de ser.
  const s = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "model", "Aulao_model.js"),
    "utf8"
  );
  const consulta = s.slice(s.indexOf("paraVitrine"), s.indexOf("Aulao_model.prototype.remove"));

  assert.ok(consulta.includes("projection:"), "a vitrine devolveria o documento cru");
  // `createdBy` é id de usuário: não é informação de vitrine, e não pode entrar.
  assert.ok(!consulta.includes("createdBy"), "id de usuário na resposta pública");
});

// ── INSCREVER À MÃO, E QUEM JÁ ERA ALUNO ─────────────────────────────────
//
// *"preciso ver quem se inscreveu e se já é usuário do meu sistema ou não, e
// também opção de inserir manualmente."*
//
// O risco deste caminho não é recusar: é DUPLICAR. Anotar à mão alguém que já é
// aluno — provável, porque quem digita o número é outra pessoa e o formato vem
// diferente — criaria uma segunda ficha, com o histórico partido em dois.

test("inscrever à mão pelo TELEFONE reusa a ficha que existe", async () => {
  const { app, feito } = monta({
    aulao: PAGO,
    // A ficha está gravada SEM formatação, e quem digita manda formatado. É o
    // caso real: `lib/telefone.js` é quem faz os dois casarem.
    pessoaPorTelefone: { _id: PESSOA, name: "Carla", phone: "11987650001" },
  });

  const r = await call(app, "post", "/aulaoes/a1/inscritos", {
    body: { phone: "(11) 98765-0001", name: "Carla Digitada Diferente" },
  });

  assert.equal(r.status, 201);
  // NÃO criou ninguém…
  assert.deepEqual(feito.criadas, []);
  // …e inscreveu a ficha que já existia.
  assert.equal(feito.inscritos[0].person, PESSOA);
  assert.equal(feito.inscritos[0].novaPessoa, false);
});

test("achada pelo telefone é VINCULADA a quem inscreveu", async () => {
  // Sem o vínculo a pessoa fica inscrita e invisível na lista de Pessoas dele —
  // inscrita num aulão de alguém que não a acompanha.
  const { app, feito } = monta({
    aulao: PAGO,
    pessoaPorTelefone: { _id: PESSOA, name: "Carla", phone: "11987650001" },
  });

  await call(app, "post", "/aulaoes/a1/inscritos", { body: { phone: "11987650001" } });

  assert.equal(feito.vinculos.length, 1);
  assert.equal(feito.vinculos[0].pessoa, PESSOA);
});

test("telefone NOVO com nome cria a ficha, e marca como nova", async () => {
  const { app, feito } = monta({ aulao: PAGO, pessoaPorTelefone: null });

  const r = await call(app, "post", "/aulaoes/a1/inscritos", {
    body: { phone: "(11) 94444-0001", name: "Helena Brandão" },
  });

  assert.equal(r.status, 201);
  assert.equal(feito.criadas.length, 1);
  assert.equal(feito.criadas[0].name, "Helena Brandão");
  // "cadastre só isso": nome e telefone, sem e-mail inventado.
  assert.equal(feito.criadas[0].email, undefined);
  assert.equal(feito.inscritos[0].novaPessoa, true);
});

test("telefone novo SEM nome pede o nome — 422, e não cria nada", async () => {
  const { app, feito } = monta({ aulao: PAGO, pessoaPorTelefone: null });

  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { phone: "11944440001" } });

  assert.equal(r.status, 422);
  assert.equal(r.body.code, "precisa_do_nome");
  assert.deepEqual(feito.criadas, []);
  assert.deepEqual(feito.inscritos, []);
});

test("nome sem telefone não passa: o telefone é a identidade", async () => {
  const { app, feito } = monta({ aulao: PAGO, pessoaPorTelefone: null });

  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: { name: "Só o nome" } });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "precisa_do_telefone");
  assert.deepEqual(feito.criadas, []);
});

test("corpo vazio continua sendo 400 — o caminho antigo não afrouxou", async () => {
  const { app } = monta({ aulao: PAGO });

  const r = await call(app, "post", "/aulaoes/a1/inscritos", { body: {} });

  assert.equal(r.status, 400);
});

test("inscrito à mão pela LISTA não é marcado como novo", async () => {
  // Quem veio da lista já era aluno por definição — marcá-lo como novo faria a
  // contagem de "pessoas novas" contar presença.
  const { app, feito } = monta({ aulao: PAGO });

  await call(app, "post", "/aulaoes/a1/inscritos", { body: { person: PESSOA } });

  assert.equal(feito.inscritos[0].novaPessoa, false);
  assert.equal(feito.inscritos[0].origem, "interna");
});

test("a ficha criada à mão também gera a cobrança do aulão pago", async () => {
  // O caminho novo não pode escapar da regra do dinheiro: quem entra num aulão
  // de R$ 25 sai devendo R$ 25, tenha sido anotado à mão ou não.
  const { app, feito } = monta({ aulao: PAGO, pessoaPorTelefone: null });

  await call(app, "post", "/aulaoes/a1/inscritos", {
    body: { phone: "11944440001", name: "Helena" },
  });

  assert.equal(feito.cobrancas.length, 1);
  assert.equal(feito.cobrancas[0].amount, 2500);
  assert.equal(feito.cobrancas[0].student, CRIADA);
});

// ── PRESENÇA E "MARCAR COMO PAGO" ────────────────────────────────────────
//
// *"senti falta de 'marcar como pago' e 'marcar presença'."*
//
// O de pago mexe em DINHEIRO, e é onde um erro não aparece na tela: aparece como
// um pagamento a mais no relatório do mês, ou como alguém cobrado de novo.

test("quitar lança o que FALTA, e não o valor cheio", async () => {
  // Quem pagou metade antes não pode aparecer tendo pago uma vez e meia.
  const { app, feito } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, currency: "BRL", status: "open" },
    jaPago: { c1: 1000 },
  });

  const r = await call(app, "post", "/aulaoes/a1/inscritos/" + PESSOA + "/pago", { body: {} });

  assert.equal(r.status, 200);
  assert.equal(feito.pagamentos.length, 1);
  assert.equal(feito.pagamentos[0].amount, 1500);
});

test("quitar fecha a cobrança também — senão ela fica aberta devendo zero", async () => {
  const { app, feito } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, currency: "BRL", status: "open" },
  });

  await call(app, "post", "/aulaoes/a1/inscritos/" + PESSOA + "/pago", { body: {} });

  assert.equal(feito.cobrancaFechada, "c1");
});

test("clicar duas vezes NÃO lança dois pagamentos", async () => {
  // O gesto mais natural que existe quando a rede demora.
  const { app, feito } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, currency: "BRL", status: "open" },
    jaPago: { c1: 2500 },
  });

  const r = await call(app, "post", "/aulaoes/a1/inscritos/" + PESSOA + "/pago", { body: {} });

  // 200 e não erro: o estado desejado é o estado atual.
  assert.equal(r.status, 200);
  assert.equal(r.body.jaEstava, true);
  assert.deepEqual(feito.pagamentos, []);
});

test("aulão de GRAÇA recusa em vez de lançar R$ 0,00", async () => {
  // Um lançamento de zero no financeiro é lixo que alguém vai tentar entender
  // depois.
  const { app, feito } = monta({ aulao: { ...PAGO, priceCents: 0 } });

  const r = await call(app, "post", "/aulaoes/a1/inscritos/" + PESSOA + "/pago", { body: {} });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "aulao_gratuito");
  assert.deepEqual(feito.pagamentos, []);
});

test("sem cobrança não inventa uma", async () => {
  const { app, feito } = monta({ aulao: PAGO, cobrancaExistente: null });

  const r = await call(app, "post", "/aulaoes/a1/inscritos/" + PESSOA + "/pago", { body: {} });

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "sem_cobranca");
  assert.deepEqual(feito.pagamentos, []);
});

test("quitar pede `finance.manage` — mexer em dinheiro não é mexer na agenda", async () => {
  // Numa conta com recepção, quem cuida da lista da aula e quem pode dizer que
  // entrou dinheiro são pessoas diferentes de propósito.
  const { app, pedidas } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, status: "open" },
  });

  await call(app, "post", "/aulaoes/a1/inscritos/" + PESSOA + "/pago", { body: {} });

  assert.ok(pedidas.includes("finance.manage"), "pediu: " + pedidas.join(", "));
});

test("presença aceita os TRÊS estados, e `null` limpa", async () => {
  const { app, feito } = monta({ aulao: PAGO });

  for (const [mandado, esperado] of [[true, true], [false, false], [null, null]]) {
    const r = await call(app, "put", "/aulaoes/a1/inscritos/" + PESSOA + "/presenca", {
      body: { presente: mandado },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.presente, esperado);
  }

  // `null` é "ninguém conferiu", e é diferente de "faltou": no dia seguinte,
  // ausente-por-omissão acusaria de falta quem o professor não chamou.
  assert.deepEqual(feito.presencas.map((p) => p.presente), [true, false, null]);
});

test("presença pede `schedule.manage` — é a lista da aula, não o caixa", async () => {
  const { app, pedidas } = monta({ aulao: PAGO });

  await call(app, "put", "/aulaoes/a1/inscritos/" + PESSOA + "/presenca", { body: { presente: true } });

  assert.ok(pedidas.includes("schedule.manage"));
});

// ── DESFAZER O "MARCAR COMO PAGO" ────────────────────────────────────────
//
// *"ele fala marco como não pago, mas continua pago."*
//
// O defeito: a primeira versão só apagava pagamentos com `automatico: true`, e
// os lançados antes de a marca existir não a tinham. O botão anunciava e não
// cumpria.
//
// Estes casos travam as duas pontas: ele tem de conseguir desfazer o caso comum,
// e NUNCA apagar parciais que alguém digitou.

test("desfaz o pagamento que o botão criou", async () => {
  const { app, feito } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, status: "paid" },
    pagamentosDaCobranca: [{ _id: "y1", amount: 2500, status: "paid", automatico: true }],
  });

  const r = await call(app, "delete", "/aulaoes/a1/inscritos/" + PESSOA + "/pago");

  assert.equal(r.status, 200);
  assert.equal(r.body.apagados, 1);
  assert.deepEqual(feito.pagamentosApagados, ["y1"]);
});

test("desfaz também o pagamento ÚNICO sem a marca — o caso que falhava", async () => {
  // Lançado antes de a marca existir, ou digitado à mão cobrindo tudo. Um
  // pagamento só, do valor exato, não tem ambiguidade.
  const { app, feito } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, status: "paid" },
    pagamentosDaCobranca: [{ _id: "y2", amount: 2500, status: "paid" }],
  });

  const r = await call(app, "delete", "/aulaoes/a1/inscritos/" + PESSOA + "/pago");

  assert.equal(r.body.apagados, 1);
  assert.deepEqual(feito.pagamentosApagados, ["y2"]);
});

test("NUNCA apaga parciais — devolve `manual` e não toca em nada", async () => {
  // Metade em dinheiro no dia da aula, metade no Pix depois: é história que
  // alguém digitou, e escolher qual apagar seria adivinhar.
  const { app, feito } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, status: "paid" },
    pagamentosDaCobranca: [
      { _id: "y3", amount: 1000, status: "paid" },
      { _id: "y4", amount: 1500, status: "paid" },
    ],
  });

  const r = await call(app, "delete", "/aulaoes/a1/inscritos/" + PESSOA + "/pago");

  assert.equal(r.status, 200);
  assert.equal(r.body.manual, true);
  assert.equal(r.body.apagados, 0);
  assert.deepEqual(feito.pagamentosApagados, []);
});

test("pagamento único MENOR que a cobrança não é apagado", async () => {
  // Um parcial sozinho continua sendo parcial: desfazer aqui apagaria metade de
  // um acerto que alguém fez, e a cobrança já não estava quitada de todo jeito.
  const { app, feito } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, status: "open" },
    pagamentosDaCobranca: [{ _id: "y5", amount: 1000, status: "paid" }],
  });

  const r = await call(app, "delete", "/aulaoes/a1/inscritos/" + PESSOA + "/pago");

  assert.equal(r.body.apagados, 0);
  assert.deepEqual(feito.pagamentosApagados, []);
});

test("desfazer pede `finance.manage` — apagar dinheiro é mexer em dinheiro", async () => {
  const { app, pedidas } = monta({
    aulao: PAGO,
    cobrancaExistente: { _id: "c1", student: PESSOA, amount: 2500, status: "paid" },
    pagamentosDaCobranca: [{ _id: "y6", amount: 2500, status: "paid", automatico: true }],
  });

  await call(app, "delete", "/aulaoes/a1/inscritos/" + PESSOA + "/pago");

  assert.ok(pedidas.includes("finance.manage"), "pediu: " + pedidas.join(", "));
});

// ── DUPLICAR ─────────────────────────────────────────────────────────────
//
// *"bote opção de duplicar, aí eu só preencho a nova data e hora."*
//
// Três coisas não podem vazar para a cópia, e cada uma é um estrago diferente:
// a PUBLICAÇÃO (aulão no ar anunciando a data da semana passada), as INSCRIÇÕES
// (cobranças para gente que não se inscreveu) e os IDS das fotos (apagar o
// original levaria as fotos da cópia junto).

test("a cópia nasce RASCUNHO, mesmo se o original estava publicado", async () => {
  const { app, feito } = monta({ aulao: { ...PAGO, published: true, showcase: true } });

  const r = await call(app, "post", "/aulaoes/a1/duplicar", { body: {} });

  assert.equal(r.status, 201);
  assert.equal(feito.duplicado.published, false);
  assert.equal(feito.duplicado.showcase, false);
});

test("a cópia leva o que se repete: preço, vagas, duração, endereço", async () => {
  const { app, feito } = monta({
    aulao: { ...PAGO, address: "Praia de São Francisco", description: "texto com emoji" },
  });

  await call(app, "post", "/aulaoes/a1/duplicar", { body: {} });

  assert.equal(feito.duplicado.priceCents, 2500);
  assert.equal(feito.duplicado.seats, 30);
  assert.equal(feito.duplicado.minutes, 90);
  assert.equal(feito.duplicado.address, "Praia de São Francisco");
  assert.equal(feito.duplicado.description, "texto com emoji");
});

test("o nome pedido vence; sem ele, fica o do original", async () => {
  const { app, feito } = monta({ aulao: PAGO });

  await call(app, "post", "/aulaoes/a1/duplicar", { body: { name: "Aulão de pernas (cópia 2)" } });
  assert.equal(feito.duplicado.name, "Aulão de pernas (cópia 2)");

  const outro = monta({ aulao: PAGO });
  await call(outro.app, "post", "/aulaoes/a1/duplicar", { body: {} });
  assert.equal(outro.feito.duplicado.name, "Aulão de pernas");
});

test("duplicar RESPEITA o limite do plano — é criar", async () => {
  // Sem isto o botão seria a porta de fundo para passar do teto, e quem a usasse
  // não saberia que passou.
  const { app, feito } = monta({ aulao: PAGO, limiteEstourado: true });

  const r = await call(app, "post", "/aulaoes/a1/duplicar", { body: {} });

  assert.equal(r.status, 409);
  assert.equal(feito.duplicado, null);
});

test("aulão que não existe não vira cópia", async () => {
  const { app, feito } = monta({ aulao: null });

  const r = await call(app, "post", "/aulaoes/inexistente/duplicar", { body: {} });

  assert.equal(r.status, 404);
  assert.equal(feito.duplicado, null);
});

test("duplicar pede `schedule.manage`", async () => {
  const { app, pedidas } = monta({ aulao: PAGO });

  await call(app, "post", "/aulaoes/a1/duplicar", { body: {} });

  assert.ok(pedidas.includes("schedule.manage"));
});
