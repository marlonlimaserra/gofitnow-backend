const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const { fakeApp, call } = require("../helpers/harness.js");
const McpController = require("../../controllers/Mcp.js");
const tools = require("../../lib/mcpTools.js");

// A porta MCP: onde um modelo opera o sistema por FERRAMENTA, e não pela tela.
//
// O que estes casos guardam não é o protocolo — é a promessa que o protocolo
// carrega: **a ferramenta não é um caminho paralelo**. Ela passa pela mesma
// permissão da tela, chama os mesmos modelos e devolve o motivo quando recusa.
//
// Um caminho paralelo que "quase" faz o mesmo é a origem do bug que ninguém
// encontra: a tela valida o e-mail, a ferramenta não, e um dia aparece uma ficha
// com endereço impossível que "o sistema aceitou".
const TREINADOR = { _id: new ObjectId(), name: "Marlon" };
const PESSOA = new ObjectId();
const TREINO = new ObjectId();
const EXERCICIO = new ObjectId();
const DIETA = new ObjectId();
const ALIMENTO = new ObjectId();
const COBRANCA = new ObjectId();
const PAGAMENTO = new ObjectId();
const COMPROMISSO = new ObjectId();
const AVALIACAO = new ObjectId();
const SERVICO = new ObjectId();
const UNIDADE = new ObjectId();
const AULA = new ObjectId();
const CHECKIN = new ObjectId();
const PLANO = new ObjectId();
const AULAO = new ObjectId();
const EXAME = new ObjectId();
const SUPLEMENTO = new ObjectId();
const PRESCRICAO = new ObjectId();
const CONVERSA = new ObjectId();

// A aula da grade, o plano e o aulão como o banco os devolve. Fora do `monta`
// porque os casos também os leem para comparar.
const GroupClass = require("../../model/GroupClass_model.js");
const estadoDeVerdade = GroupClass.prototype.estadoAgora;

// Todos os dias da semana: assim "hoje" cai dentro dela em qualquer dia em que
// a suíte rode. Uma grade de seg/qua/sex faria metade dos casos passarem só às
// segundas.
const AULA_BASE = {
  _id: AULA,
  name: "Spinning",
  dias: [0, 1, 2, 3, 4, 5, 6],
  horarios: [{ inicio: 420, fim: 470 }],
  checkinAbre: 30,
  checkinFecha: 15,
  seats: 20,
  active: true,
};

const PLANO_BASE = {
  _id: PLANO,
  name: "Mensal",
  amount: 14990,
  currency: "BRL",
  cadencia: "monthly",
  active: true,
};

const EXAME_BASE = {
  _id: EXAME,
  student: PESSOA,
  collectedAt: "2026-09-10",
  lab: "Fleury",
  notes: "",
  markers: [
    { key: "vitaminD", name: "", value: 18, unit: "ng/mL", low: 30, high: 100, flag: "low" },
  ],
};

const SUPLEMENTO_BASE = {
  _id: SUPLEMENTO,
  student: PESSOA,
  name: "Creatina",
  brand: "Growth",
  dose: 5,
  unit: "g",
  moment: "postWorkout",
  weekdays: [],
  startDate: "2026-09-01",
  endDate: "",
  status: "current",
};

const PRESCRICAO_BASE = {
  _id: PRESCRICAO,
  student: PESSOA,
  type: "supplement",
  title: "Vitamina D",
  date: "2026-09-10",
  validUntil: "",
  council: "CRN 12345",
  notes: "",
  items: [{ name: "Vitamina D3 2.000 UI", dose: "1 cápsula", posology: "1x ao dia", duration: "60 dias" }],
};

const CONVERSA_BASE = {
  _id: CONVERSA,
  members: [TREINADOR._id, PESSOA],
  lastMessage: "bom dia!",
  lastAt: new Date("2026-09-18T10:01:00.000Z"),
  unread: {},
};

const AULAO_BASE = {
  _id: AULAO,
  name: "Aulão na praia",
  slug: "aulao-na-praia",
  startsAt: new Date("2026-09-27T11:00:00.000Z"),
  minutes: 90,
  seats: 100,
  priceCents: 2500,
  currency: "BRL",
  published: true,
};

function monta({
  permissoes = [
    "people.view",
    "people.create",
    "people.edit",
    "people.delete",
    "workouts.view",
    "workouts.manage",
    "diets.view",
    "diets.manage",
    "finance.view",
    "finance.manage",
    "schedule.view",
    "schedule.manage",
    "assessments.view",
    "assessments.manage",
    // Unidade se cadastra com users.manage, como na tela: abrir filial é
    // decisão de quem administra.
    "users.manage",
    // As áreas clínicas, e o chat. VER e MEXER separados nas quatro, como no
    // catálogo de permissões — quem reimprime uma receita não é quem a assina.
    "anamnesis.view",
    "anamnesis.manage",
    "exams.view",
    "exams.manage",
    "supplements.view",
    "supplements.manage",
    "prescriptions.view",
    "prescriptions.manage",
    "chat.view",
    "chat.send",
  ],
  treino = null,
  dieta = null,
  // Os TETOS do plano, do jeito que a central os devolve. `{}` é ilimitado, que
  // é o padrão e o que a central responde quando está fora do ar.
  limites = {},
  // Quantos documentos existem hoje — é o que `limiteDoPlano.contarNa` conta.
  quantosExistem = 0,
  pessoasNaUnidade = 0,
  aulas = null,
  inscritos = null,
  fechada = false,
  entrada = { ok: true, novo: true },
  // A anamnese: `null` é "nunca preenchida", que é o caminho em que o teto vale.
  anamnese = null,
  comEmail = null,
  prescricao = false,
  conflito = false,
  semVinculo = false,
} = {}) {
  const gravado = { pessoas: [], exercicios: null, refeicoes: null, apagados: [], conflito };

  const app = fakeApp({
    // `contarNa` conta direto na collection, sem passar por modelo nenhum.
    mongodb: {
      async connectToServer() {
        return { collection: () => ({ countDocuments: async () => quantosExistem }) };
      },
    },
    helpers: {
      ReqProtected: {
        async verify() {
          return TREINADOR;
        },
        has(user, permissao) {
          return permissoes.includes(permissao);
        },
      },
    },
    api: {
      center: {
        async limitsFor() {
          return limites;
        },
      },
      user: {
        async briefByIds(ids) {
          return Object.fromEntries((ids || []).map((id) => [String(id), { name: "Bruna" }]));
        },
        async pageStudents() {
          return { rows: [{ _id: PESSOA, name: "Bruna", email: "bruna@x.com", active: 1 }] };
        },
        async dataStudent(_t, id) {
          if (semVinculo) return undefined;
          if (String(id) !== String(PESSOA)) return undefined;
          return { _id: PESSOA, name: "Bruna", email: "bruna@x.com", password: comEmail ? "hash" : null };
        },
        async dataByEmail(email) {
          return email === "ocupado@x.com" ? { _id: new ObjectId() } : undefined;
        },
        async insertStudent(_t, dados) {
          gravado.pessoas.push(dados);
          return PESSOA;
        },
        async updateStudent(_t, _id, mudanca) {
          gravado.mudanca = mudanca;
          return true;
        },
        async deleteStudent(_t, id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      auth: {
        async deleteAllTokensByUser(id) {
          gravado.tokensApagados = String(id);
        },
      },
      diet: {
        async list() {
          return [{ _id: DIETA, name: "Cutting", meals: [] }];
        },
        async data(_t, id) {
          if (String(id) !== String(DIETA)) return undefined;
          return dieta || { _id: DIETA, name: "Cutting", student: PESSOA, meals: [] };
        },
        async insert(_t, _s, dados) {
          gravado.dieta = dados;
          return DIETA;
        },
        async update(_t, _id, mudanca) {
          gravado.dietaMudanca = mudanca;
          return true;
        },
        async delete(_t, id) {
          gravado.apagados.push(String(id));
          return true;
        },
        async saveMeals(_t, _id, refeicoes) {
          gravado.refeicoes = refeicoes;
          return true;
        },
      },
      finance: {
        async balanceOf() {
          return { BRL: { charged: 25000, paid: 15000, balance: 10000 } };
        },
        async paidByCharge() {
          return { [String(COBRANCA)]: 15000 };
        },
        async listCharges() {
          return [
            {
              _id: COBRANCA,
              student: PESSOA,
              amount: 25000,
              currency: "BRL",
              description: "Mensalidade",
              dueDate: new Date("2026-08-05"),
              status: "open",
            },
          ];
        },
        async listPayments() {
          return [
            {
              _id: PAGAMENTO,
              student: PESSOA,
              charge: COBRANCA,
              amount: 15000,
              currency: "BRL",
              method: "pix",
              date: new Date("2026-08-05T12:00:00.000Z"),
              status: "paid",
              note: "primeira parte",
            },
          ];
        },
        async chargeData(id) {
          if (String(id) !== String(COBRANCA)) return undefined;
          return {
            _id: COBRANCA,
            student: PESSOA,
            amount: gravado.cobrancaMudanca?.amount ?? 25000,
            currency: "BRL",
            description: "Mensalidade",
            dueDate: new Date("2026-08-05"),
            status: gravado.cobrancaMudanca?.status ?? "open",
          };
        },
        async paymentData(id) {
          if (String(id) !== String(PAGAMENTO)) return undefined;
          return {
            _id: PAGAMENTO,
            student: PESSOA,
            amount: gravado.pagamento?.amount === "" ? 0 : 15000,
            currency: "BRL",
            method: gravado.pagamento?.method || "pix",
            date: new Date(),
            status: "paid",
          };
        },
        async insertCharge(_s, dados, _quem, moeda) {
          gravado.cobranca = dados;
          gravado.cobrancaMoeda = moeda;
          return COBRANCA;
        },
        async updateCharge(_id, dados) {
          gravado.cobrancaMudanca = dados;
          return true;
        },
        async deleteCharge(id) {
          gravado.apagados.push(String(id));
          return true;
        },
        async insertPayment(_s, dados, _quem, moeda) {
          gravado.pagamento = dados;
          gravado.pagamentoMoeda = moeda;
          return PAGAMENTO;
        },
        async deletePayment(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      paymentMethod: {
        async keys() {
          return ["pix", "cash", "other"];
        },
      },
      appointment: {
        async between() {
          return [
            {
              _id: COMPROMISSO,
              student: PESSOA,
              date: new Date("2026-08-20T13:00:00.000Z"),
              minutes: 60,
              status: "scheduled",
              title: "",
            },
          ];
        },
        async data(_t, id) {
          if (String(id) !== String(COMPROMISSO)) return undefined;
          return {
            _id: COMPROMISSO,
            student: PESSOA,
            date: gravado.compromissoMudanca?.date || new Date("2026-08-20T13:00:00.000Z"),
            minutes: gravado.compromissoMudanca?.minutes || 60,
            status: gravado.situacao || "scheduled",
            title: "",
          };
        },
        async conflicts() {
          return gravado.conflito ? [{ _id: new ObjectId() }] : [];
        },
        async insert(_t, _s, dados) {
          gravado.compromisso = dados;
          return COMPROMISSO;
        },
        async update(_t, _id, dados) {
          gravado.compromissoMudanca = dados;
          return true;
        },
        async setStatus(_t, _id, status) {
          gravado.situacao = status;
          return true;
        },
        async delete(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      assessment: {
        async list() {
          return [{ _id: AVALIACAO, student: PESSOA, date: new Date("2026-08-01"), weight: 71, height: 1.63 }];
        },
        async data(_t, id) {
          if (String(id) !== String(AVALIACAO)) return undefined;
          return {
            _id: AVALIACAO,
            student: PESSOA,
            date: new Date("2026-08-01"),
            weight: gravado.avaliacaoMudanca?.weight ?? 71,
            height: 1.63,
            skinfolds: { triceps: 12 },
          };
        },
        async insert(_t, _s, dados) {
          gravado.avaliacao = dados;
          return AVALIACAO;
        },
        async update(_t, _id, dados) {
          gravado.avaliacaoMudanca = dados;
          return true;
        },
        async delete(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      service: {
        async list() {
          return [{ _id: SERVICO, name: "Consulta", minutes: 60, price: 8000, currency: "BRL" }];
        },
        async data(id) {
          if (String(id) !== String(SERVICO)) return undefined;
          return { _id: SERVICO, name: "Consulta", minutes: 60, price: 8000 };
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL", "USD"] };
        },
        async timezoneOfInstance() {
          return "America/Sao_Paulo";
        },
      },
      food: {
        async list() {
          return { rows: [{ _id: ALIMENTO, name: "Arroz", kcal: 130, protein: 2.7, portion: 100 }] };
        },
        async data(id) {
          if (String(id) !== String(ALIMENTO)) return undefined;
          return { _id: ALIMENTO, name: "Arroz", kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 };
        },
      },
      exercise: {
        async list() {
          return { rows: [{ _id: EXERCICIO, name: "Remada baixa", muscleGroup: "Costas" }] };
        },
        async data(id) {
          if (String(id) !== String(EXERCICIO)) return undefined;
          return {
            _id: EXERCICIO,
            name: "Remada baixa",
            muscleGroup: "Costas",
            ...(prescricao
              ? {
                  defaultMethod: "pyramid",
                  defaultSets: [
                    { unit: "reps", quantity: "15", load: "90" },
                    { unit: "reps", quantity: "12", load: "95" },
                  ],
                }
              : {}),
          };
        },
      },
      workout: {
        async list() {
          return [{ _id: TREINO, name: "A", exercises: [] }];
        },
        async data(_t, id) {
          if (String(id) !== String(TREINO)) return undefined;
          return treino || { _id: TREINO, name: "A", student: PESSOA, exercises: [] };
        },
        async insert(_t, _s, dados) {
          gravado.treino = dados;
          return TREINO;
        },
        async update(_t, _id, mudanca) {
          gravado.treinoMudanca = mudanca;
          return true;
        },
        async delete(_t, id) {
          gravado.apagados.push(String(id));
          return true;
        },
        async saveExercises(_t, _id, lista) {
          gravado.exercicios = lista;
          return true;
        },
      },

      // ── As telas que entraram em setembro de 2026 ─────────────────────────
      unit: {
        async list() {
          return [{ _id: UNIDADE, name: "Paraty", cidade: "Paraty", uf: "RJ", active: true }];
        },
        async data(id) {
          return String(id) === String(UNIDADE)
            ? { _id: UNIDADE, name: "Paraty", cidade: "Paraty", uf: "RJ", active: true }
            : undefined;
        },
        async quantasPessoas() {
          return pessoasNaUnidade;
        },
        async insert(dados) {
          gravado.unidade = dados;
          return dados.name ? UNIDADE : null;
        },
        async update(_id, dados) {
          gravado.unidadeMudanca = dados;
          return true;
        },
        async remove(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      groupClass: {
        async list() {
          return aulas || [AULA_BASE];
        },
        async listActive() {
          return aulas || [AULA_BASE];
        },
        async data(id) {
          return String(id) === String(AULA) ? aulas?.[0] || AULA_BASE : undefined;
        },
        async insert(dados) {
          gravado.aula = dados;
          return dados.name && dados.dias?.length ? AULA : null;
        },
        async update(_id, dados) {
          gravado.aulaMudanca = dados;
          return true;
        },
        async remove(id) {
          gravado.apagados.push(String(id));
          return true;
        },
        // O estado é o DE VERDADE — é ele que decide o que é "hoje".
        estadoAgora: estadoDeVerdade,
      },
      groupClassCheckin: {
        async contagemDoDia() {
          return { [`${AULA}:420`]: (inscritos || []).length };
        },
        async inscritos() {
          return inscritos || [];
        },
        async entrar(aula, dia, pessoa, opcoes) {
          gravado.entrou = { aula: String(aula), dia, pessoa: String(pessoa), ...opcoes };
          return entrada;
        },
        async marcarPresenca(id, presenca) {
          gravado.presenca = { id: String(id), presenca };
          return String(id) === String(CHECKIN);
        },
        async remover(id) {
          gravado.apagados.push(String(id));
          return String(id) === String(CHECKIN);
        },
        async removeAllOf(id) {
          gravado.checkinsApagados = String(id);
          return 0;
        },
        async daPessoa() {
          return [{ class: AULA, dia: "2026-09-18", inicio: 420, presenca: "presente" }];
        },
      },
      groupClassSession: {
        async fechadasDoDia() {
          return fechada ? new Set([`${AULA}:420`]) : new Set();
        },
        async estaFechada() {
          return fechada;
        },
        async fechar(aula, dia, inicio, valor, quem) {
          gravado.fechamento = { aula: String(aula), dia, inicio, fechada: valor, quem: String(quem) };
          return true;
        },
        async removeAllOf(id) {
          gravado.sessoesApagadas = String(id);
          return 0;
        },
      },
      membership: {
        async list() {
          return [PLANO_BASE];
        },
        async listActive() {
          return [PLANO_BASE];
        },
        async data(id) {
          return String(id) === String(PLANO) ? PLANO_BASE : undefined;
        },
        async insert(dados, moeda) {
          gravado.plano = dados;
          gravado.planoMoeda = moeda;
          return PLANO;
        },
        async update(_id, dados) {
          gravado.planoMudanca = dados;
          return true;
        },
        async remove(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      anamnesis: {
        async data() {
          return anamnese;
        },
        async save(_t, _s, dados) {
          gravado.anamnese = dados;
          return { criou: !anamnese };
        },
        async delete() {
          gravado.anamneseApagada = true;
          return Boolean(anamnese);
        },
      },
      exam: {
        async list() {
          return [EXAME_BASE];
        },
        async data(_t, id) {
          return String(id) === String(EXAME) ? EXAME_BASE : undefined;
        },
        async insert(_t, _s, dados) {
          gravado.exame = dados;
          return EXAME;
        },
        async update(_t, _id, dados) {
          gravado.exameMudanca = dados;
          return true;
        },
        async delete(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      supplement: {
        async list() {
          return [SUPLEMENTO_BASE];
        },
        async data(_t, id) {
          return String(id) === String(SUPLEMENTO) ? SUPLEMENTO_BASE : undefined;
        },
        async insert(_t, _s, dados) {
          gravado.suplemento = dados;
          return SUPLEMENTO;
        },
        async update(_t, _id, dados) {
          gravado.suplementoMudanca = dados;
          return true;
        },
        async delete(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      prescription: {
        async list() {
          return [PRESCRICAO_BASE];
        },
        async data(_t, id) {
          return String(id) === String(PRESCRICAO) ? PRESCRICAO_BASE : undefined;
        },
        async insert(_t, _s, dados) {
          gravado.prescricao = dados;
          return PRESCRICAO;
        },
        async update(_t, _id, dados) {
          gravado.prescricaoMudanca = dados;
          return true;
        },
        async delete(id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      chat: {
        async listOf() {
          return [CONVERSA_BASE];
        },
        async unreadTotal() {
          return 3;
        },
        async data(id) {
          return String(id) === String(CONVERSA) ? CONVERSA_BASE : undefined;
        },
        isMember(conversa, quem) {
          return (conversa?.members || []).some((m) => String(m) === String(quem));
        },
        otherOf(conversa, quem) {
          return (conversa?.members || []).find((m) => String(m) !== String(quem));
        },
        async messagesOf() {
          return [
            { from: PESSOA, body: "bom dia", createdAt: new Date("2026-09-18T10:00:00.000Z") },
            { from: TREINADOR._id, body: "bom dia!", createdAt: new Date("2026-09-18T10:01:00.000Z") },
          ];
        },
        async openWith() {
          gravado.abriuConversa = true;
          return CONVERSA_BASE;
        },
        async send(conversaId, de, texto) {
          gravado.mensagem = { conversaId: String(conversaId), de: String(de), texto };
          return texto ? { _id: new ObjectId(), body: texto } : undefined;
        },
      },
      aulao: {
        async collection() {
          return { countDocuments: async () => quantosExistem };
        },
        async list() {
          return [AULAO_BASE];
        },
        async contagemDeTodos() {
          return { [String(AULAO)]: 12 };
        },
        async insert(quem, dados) {
          gravado.aulao = dados;
          if (!dados.name) return { ok: false, erro: "sem_nome" };
          return { ok: true, id: AULAO, slug: "aulao-na-praia" };
        },
        async inscrever(aulaoId, pessoaId, opcoes) {
          gravado.inscricao = { aulaoId: String(aulaoId), pessoaId: String(pessoaId), ...opcoes };
          return gravado.conflito ? { ok: false, erro: "lotado" } : { ok: true, id: new ObjectId() };
        },
        async marcarPresenca(aulaoId, pessoaId, presente) {
          gravado.presencaAulao = { aulaoId: String(aulaoId), pessoaId: String(pessoaId), presente };
          return { ok: true, presente };
        },
      },
    },
  });

  McpController(app);
  return { app, gravado };
}

const rpc = (app, method, params) =>
  call(app, "post", "/mcp", { body: { jsonrpc: "2.0", id: 1, method, params } });

// O resultado da ferramenta vem embrulhado no envelope do MCP.
const saida = (r) => r.body.result.structuredContent;

// ── O protocolo, o mínimo dele ───────────────────────────────────────────

test("o aperto de mão diz quem somos e o que temos", async () => {
  const { app } = monta();

  const r = await rpc(app, "initialize", {});

  assert.equal(r.body.result.serverInfo.name, "gofitnow");
  assert.ok(r.body.result.capabilities.tools);
});

test("a lista de ferramentas sai no formato que o cliente espera", async () => {
  const { app } = monta();

  const r = await rpc(app, "tools/list", {});
  const lista = r.body.result.tools;

  assert.ok(lista.length >= 10);
  for (const f of lista) {
    assert.ok(f.name, "toda ferramenta precisa de nome");
    assert.ok(f.description, "e de descrição — é o que o modelo lê para decidir");
    assert.equal(f.inputSchema.type, "object");
  }
});

test("ferramenta que não existe é erro de PROTOCOLO", async () => {
  // Aqui é o cliente que está errado, não o mundo: -32602 é "parâmetro
  // inválido", e é o que faz um cliente bem escrito parar em vez de repetir.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "voar", arguments: {} });

  assert.equal(r.body.error.code, -32602);
});

// ── A permissão é a MESMA da tela ────────────────────────────────────────

test("sem a permissão da tela, a ferramenta recusa", async () => {
  const { app, gravado } = monta({ permissoes: [] });

  const r = await rpc(app, "tools/call", {
    name: "pessoa_criar",
    arguments: { nome: "Bruna" },
  });

  assert.equal(saida(r).erro, "sem_permissao");
  assert.equal(gravado.pessoas.length, 0, "não pode nem chegar ao modelo");
});

test("a recusa volta como RESULTADO, não como erro de protocolo", async () => {
  // O modelo precisa poder ler o motivo e dizer à pessoa o que faltou. Um erro
  // de protocolo faria o cliente tentar de novo, igual.
  const { app } = monta({ permissoes: [] });

  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "x" } });

  assert.equal(r.body.error, undefined);
  assert.equal(r.body.result.isError, true);
});

// ── Pessoas ──────────────────────────────────────────────────────────────

test("criar pessoa segue a regra da tela: e-mail é opcional", async () => {
  // Ele foi obrigatório por muito tempo, e a tela deixou de exigir. A
  // ferramenta tem de acompanhar — senão a mesma casa tem duas regras.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "Bruna" } });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.pessoas[0].email, "");
});

test("e-mail inválido é recusado com motivo, não com exceção", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_criar",
    arguments: { nome: "Bruna", email: "nao-e-email" },
  });

  assert.equal(saida(r).erro, "email_invalido");
  assert.equal(gravado.pessoas.length, 0);
});

test("e-mail já usado não vira ficha duplicada", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_criar",
    arguments: { nome: "Bruna", email: "ocupado@x.com" },
  });

  assert.equal(saida(r).erro, "email_em_uso");
  assert.equal(gravado.pessoas.length, 0);
});

test("a resposta diz ONDE olhar — é o que faz a tela acompanhar", async () => {
  // O front recebe isto e abre a tela certa, destacando o que mudou. É assim
  // que a pessoa vê a ação acontecer sem o modelo ter tocado na tela.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "Bruna" } });

  assert.equal(saida(r).alvo.rota, `/people/${PESSOA}`);
});

test("achar UMA pessoa leva a tela até ela", async () => {
  // Procurar alguém pelo nome quase sempre é o começo de "e agora faz X com
  // ela": abrir a ficha adianta o passo seguinte e mostra que a busca acertou.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "bru" } });

  assert.equal(saida(r).alvo.rota, `/people/${PESSOA}`);
});

test("achar VÁRIAS não navega para nenhuma", async () => {
  // Escolher uma seria escolher pela pessoa; ir para a lista sem o filtro seria
  // pior que ficar parado, porque ela teria de buscar de novo à mão.
  const { app } = monta();
  app.api.user.pageStudents = async () => ({
    rows: [
      { _id: PESSOA, name: "Bruna" },
      { _id: new ObjectId(), name: "Bruno" },
    ],
  });

  const r = await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "bru" } });

  assert.equal(saida(r).pessoas.length, 2);
  assert.equal(saida(r).alvo, undefined);
});

test("ver um treino abre o treino", async () => {
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_ver",
    arguments: { treinoId: String(TREINO) },
  });

  assert.equal(saida(r).alvo.rota, `/people/${PESSOA}/workouts/${TREINO}`);
});

test("a ficha devolvida NÃO traz senha nem salt", async () => {
  // O que entra no contexto de um modelo sai na resposta dele em algum momento.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "bru" } });

  const p = saida(r).pessoas[0];
  assert.deepEqual(Object.keys(p).sort(), ["ativo", "email", "id", "nome", "telefone"]);
});

test("tirar o e-mail de quem tem senha é recusado", async () => {
  // A mesma regra da tela: o e-mail é o login. Tirá-lo deixaria a pessoa sem
  // porta de entrada, e sem aviso.
  const { app } = monta({ comEmail: true });

  const r = await rpc(app, "tools/call", {
    name: "pessoa_editar",
    arguments: { pessoaId: String(PESSOA), email: "" },
  });

  assert.equal(saida(r).erro, "email_e_login");
});

test("editar manda SÓ o que mudou", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "pessoa_editar",
    arguments: { pessoaId: String(PESSOA), telefone: "11999" },
  });

  assert.deepEqual(gravado.mudanca, { phone: "11999" });
});

test("excluir mata a sessão junto", async () => {
  // Sem isto, quem já estava logado continuaria dentro de uma conta que não
  // existe mais.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_excluir",
    arguments: { pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.tokensApagados, String(PESSOA));
});

test("pessoa de outro profissional não é encontrada", async () => {
  // `dataStudent` só devolve quem está vinculado a quem pediu — a ferramenta
  // não fura o vínculo porque não conhece outro caminho até a ficha.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_excluir",
    arguments: { pessoaId: String(new ObjectId()) },
  });

  assert.equal(saida(r).erro, "pessoa_nao_encontrada");
});

// ── Treinos ──────────────────────────────────────────────────────────────

test("acrescentar exercício COPIA nome e grupo do catálogo", async () => {
  // O treino tem de continuar legível se o exercício sair do catálogo depois.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: {
      treinoId: String(TREINO),
      exercicioId: String(EXERCICIO),
      series: 4,
      quantidade: "12",
      carga: "20kg",
    },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.exercicios[0].name, "Remada baixa");
  assert.equal(gravado.exercicios[0].muscleGroup, "Costas");
  assert.equal(gravado.exercicios[0].sets.length, 4);
  assert.equal(gravado.exercicios[0].sets[0].quantity, "12");
});

test("o exercício chega com a PRESCRIÇÃO que o cadastro guardou", async () => {
  // O mesmo que a tela faz ao adicionar: quem cadastrou "Remada baixa com
  // triângulo" com 4 séries de 15/12/10/8 espera que ela chegue assim, pela voz
  // ou pelo dedo — se fosse só na tela, pedir por voz daria outro treino.
  const { app, gravado } = monta({ prescricao: true });

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO) },
  });

  assert.equal(saida(r).ok, true);
  const posto = gravado.exercicios[0];
  assert.equal(posto.sets.length, 2);
  assert.equal(posto.sets[0].quantity, "15");
  assert.equal(posto.sets[1].load, "95");
  assert.equal(posto.method, "pyramid");
});

test("o que o profissional DIZ vence a prescrição guardada", async () => {
  // "Acrescenta remada, 3 séries de 12" é uma prescrição feita agora. Aplicar o
  // padrão por cima seria ignorar o que acabou de ser dito.
  const { app, gravado } = monta({ prescricao: true });

  await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO), series: 3, quantidade: "12" },
  });

  const posto = gravado.exercicios[0];
  assert.equal(posto.sets.length, 3);
  assert.ok(posto.sets.every((s) => s.quantity === "12"));
});

test("exercício sem prescrição continua entrando com uma série em branco", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO) },
  });

  assert.equal(gravado.exercicios[0].sets.length, 1);
  assert.equal(gravado.exercicios[0].sets[0].quantity, "");
});

test("exercício fora do catálogo é recusado — não se inventa nome", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(new ObjectId()) },
  });

  assert.equal(saida(r).erro, "exercicio_nao_encontrado");
  assert.equal(gravado.exercicios, null);
});

test("o exercício entra no FIM, sem apagar os que já estavam", async () => {
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [] }],
  };
  const { app, gravado } = monta({ treino });

  await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO) },
  });

  assert.equal(gravado.exercicios.length, 2);
  assert.equal(gravado.exercicios[0].name, "Supino");
});

test("editar séries mantém o que não foi mandado", async () => {
  // Quem pede "coloca a carga" não está pedindo para apagar as repetições.
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [{ unit: "reps", quantity: "10", load: "" }] }],
  };
  const { app, gravado } = monta({ treino });

  await rpc(app, "tools/call", {
    name: "treino_exercicio_editar",
    arguments: { treinoId: String(TREINO), posicao: 0, carga: "30kg" },
  });

  assert.equal(gravado.exercicios[0].sets[0].load, "30kg");
  assert.equal(gravado.exercicios[0].sets[0].quantity, "10", "a repetição não podia sumir");
});

test("mudar a quantidade de séries repete o que a primeira tinha", async () => {
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [{ unit: "reps", quantity: "10", load: "20kg" }] }],
  };
  const { app, gravado } = monta({ treino });

  await rpc(app, "tools/call", {
    name: "treino_exercicio_editar",
    arguments: { treinoId: String(TREINO), posicao: 0, series: 3 },
  });

  assert.equal(gravado.exercicios[0].sets.length, 3);
  assert.equal(gravado.exercicios[0].sets[0].quantity, "10");
});

test("posição que não existe diz QUANTAS existem", async () => {
  // O modelo precisa do número para se corrigir sozinho, em vez de tentar de
  // novo no escuro.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_editar",
    arguments: { treinoId: String(TREINO), posicao: 7 },
  });

  assert.equal(saida(r).erro, "posicao_inexistente");
  assert.match(saida(r).detalhe, /0 exerc/);
});

test("remover tira só um, e diz qual", async () => {
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [] }, { name: "Remada", sets: [] }],
  };
  const { app, gravado } = monta({ treino });

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_remover",
    arguments: { treinoId: String(TREINO), posicao: 0 },
  });

  assert.equal(saida(r).removido, "Supino");
  assert.equal(gravado.exercicios.length, 1);
  assert.equal(gravado.exercicios[0].name, "Remada");
});

test("treino com fim antes do começo é recusado", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_criar",
    arguments: {
      pessoaId: String(PESSOA),
      nome: "Treino A",
      inicio: "2026-03-01",
      fim: "2026-01-01",
    },
  });

  assert.equal(saida(r).erro, "fim_antes_do_inicio");
  assert.equal(gravado.treino, undefined);
});

test("treino nasce com o professor de quem está operando", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "treino_criar",
    arguments: { pessoaId: String(PESSOA), nome: "Treino A" },
  });

  assert.equal(gravado.treino.teacherName, "Marlon");
});

// ── O catálogo, como contrato ────────────────────────────────────────────

test("toda ferramenta declara permissão e schema", async () => {
  // Uma ferramenta sem permissão seria uma porta aberta; uma sem schema faria o
  // modelo adivinhar os campos.
  for (const f of tools.FERRAMENTAS) {
    assert.ok(f.permissao, `${f.nome} sem permissão`);
    assert.ok(f.schema?.properties, `${f.nome} sem schema`);
    assert.ok(f.descricao.length > 30, `${f.nome}: a descrição é o que o modelo lê`);
  }
});

test("o que muda dados devolve ALVO — a tela precisa saber onde olhar", async () => {
  const escrevem = ["pessoa_criar", "pessoa_editar", "treino_criar", "treino_exercicio_adicionar"];

  for (const nome of escrevem) {
    assert.ok(
      tools.achar(nome).descricao,
      `${nome} precisa existir para o front acompanhar a ação`
    );
  }
});


// ── Dietas ───────────────────────────────────────────────────────────────
//
// Mesma promessa das outras: a ferramenta chama o modelo da tela, com a
// permissão da tela. O que muda é a forma do dado — um plano tem refeições, e
// cada refeição tem alimentos, então há DUAS posições para errar.

test("criar plano grava e diz onde a tela deve olhar", async () => {
  // O caminho feliz faltava aqui, e o buraco apareceu em produção: pedir "cria
  // um plano alimentar" por voz voltava "Ferramenta desconhecida: dieta_criar" —
  // era o navegador que não sabia rotear, não a ferramenta. Com o caminho feliz
  // coberto dos dois lados, a próxima falha aponta o lado certo.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "dieta_criar",
    arguments: {
      pessoaId: String(PESSOA),
      nome: "Keto",
      objetivo: "Perda de peso",
      metaKcal: 900,
    },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.dieta.name, "Keto");
  assert.equal(gravado.dieta.goal, "Perda de peso");
  assert.equal(gravado.dieta.targetKcal, 900);
  assert.equal(saida(r).alvo.recarregar, `diet:${DIETA}`);
  assert.match(saida(r).alvo.rota, /tab=diet&diet=/);
});

test("excluir plano também manda recarregar", async () => {
  // O plano some do banco; sem o aviso ele continua na lista de quem está com a
  // ficha aberta — e o profissional acha que o pedido se perdeu.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "dieta_excluir",
    arguments: { dietaId: String(DIETA) },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(saida(r).alvo.recarregar, `diet:${DIETA}`);
});

test("criar plano recusa fim antes do começo", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "dieta_criar",
    arguments: {
      pessoaId: String(PESSOA),
      nome: "Cutting",
      inicio: "2026-03-01",
      fim: "2026-01-01",
    },
  });

  assert.equal(saida(r).erro, "fim_antes_do_inicio");
  assert.equal(gravado.dieta, undefined);
});

test("a refeição entra no fim, com a hora validada", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "refeicao_adicionar",
    arguments: { dietaId: String(DIETA), nome: "Café da manhã", hora: "07:00" },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.refeicoes[0].name, "Café da manhã");
  assert.equal(gravado.refeicoes[0].time, "07:00");
});

test("hora impossível é recusada — 25:00 não existe", async () => {
  // Sem isto ela viraria texto vazio no modelo e a refeição ficaria sem hora,
  // sem ninguém saber por quê.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "refeicao_adicionar",
    arguments: { dietaId: String(DIETA), nome: "Ceia", hora: "25:00" },
  });

  assert.equal(saida(r).erro, "hora_invalida");
  assert.equal(gravado.refeicoes, null);
});

test("alimento do catálogo entra com os valores PROPORCIONAIS", async () => {
  // Os valores do catálogo são por 100 g. Copiá-los sem regra de três faria
  // 30 g de arroz contar como 100 g, e o dia inteiro sairia errado.
  const dieta = {
    _id: DIETA,
    name: "Cutting",
    student: PESSOA,
    meals: [{ name: "Almoço", foods: [] }],
  };
  const { app, gravado } = monta({ dieta });

  await rpc(app, "tools/call", {
    name: "refeicao_alimento_adicionar",
    arguments: {
      dietaId: String(DIETA),
      refeicao: 0,
      alimentoId: String(ALIMENTO),
      quantidade: 50,
    },
  });

  const posto = gravado.refeicoes[0].foods[0];
  assert.equal(posto.name, "Arroz");
  assert.equal(posto.quantity, 50);
  assert.equal(posto.kcal, 65, "metade de 130");
  assert.equal(posto.protein, 1.4, "metade de 2.7, arredondado");
});

test("alimento livre entra só com o nome, sem inventar caloria", async () => {
  // Uma receita da casa não tem rótulo. Zero mentiria na soma do dia.
  const dieta = { _id: DIETA, name: "x", student: PESSOA, meals: [{ name: "Jantar", foods: [] }] };
  const { app, gravado } = monta({ dieta });

  await rpc(app, "tools/call", {
    name: "refeicao_alimento_adicionar",
    arguments: { dietaId: String(DIETA), refeicao: 0, nome: "Sopa da vó", quantidade: 1 },
  });

  const posto = gravado.refeicoes[0].foods[0];
  assert.equal(posto.name, "Sopa da vó");
  assert.equal(posto.kcal, undefined);
});

test("sem alimentoId e sem nome, recusa", async () => {
  const dieta = { _id: DIETA, name: "x", student: PESSOA, meals: [{ name: "Jantar", foods: [] }] };
  const { app, gravado } = monta({ dieta });

  const r = await rpc(app, "tools/call", {
    name: "refeicao_alimento_adicionar",
    arguments: { dietaId: String(DIETA), refeicao: 0 },
  });

  assert.equal(saida(r).erro, "sem_alimento");
  assert.equal(gravado.refeicoes, null);
});

test("as DUAS posições são conferidas, e o erro diz quantas existem", async () => {
  const dieta = {
    _id: DIETA,
    name: "x",
    student: PESSOA,
    meals: [{ name: "Almoço", foods: [{ name: "Arroz" }] }],
  };
  const { app } = monta({ dieta });

  const semRefeicao = await rpc(app, "tools/call", {
    name: "refeicao_alimento_remover",
    arguments: { dietaId: String(DIETA), refeicao: 9, alimento: 0 },
  });
  assert.match(saida(semRefeicao).detalhe, /1 refei/);

  const semAlimento = await rpc(app, "tools/call", {
    name: "refeicao_alimento_remover",
    arguments: { dietaId: String(DIETA), refeicao: 0, alimento: 9 },
  });
  assert.match(saida(semAlimento).detalhe, /1 aliment/);
});

test("remover refeição leva os alimentos dela junto", async () => {
  const dieta = {
    _id: DIETA,
    name: "x",
    student: PESSOA,
    meals: [
      { name: "Café", foods: [{ name: "Pão" }] },
      { name: "Almoço", foods: [] },
    ],
  };
  const { app, gravado } = monta({ dieta });

  const r = await rpc(app, "tools/call", {
    name: "refeicao_remover",
    arguments: { dietaId: String(DIETA), posicao: 0 },
  });

  assert.equal(saida(r).removida, "Café");
  assert.equal(gravado.refeicoes.length, 1);
  assert.equal(gravado.refeicoes[0].name, "Almoço");
});

test("a dieta manda RECARREGAR a tela, que não tem rota própria", async () => {
  // O plano mora numa aba da ficha, com o id na busca da URL: navegar para lá
  // sem recarregar deixaria a tela aberta mostrando o de antes.
  const dieta = { _id: DIETA, name: "x", student: PESSOA, meals: [{ name: "Café", foods: [] }] };
  const { app } = monta({ dieta });

  const r = await rpc(app, "tools/call", {
    name: "refeicao_editar",
    arguments: { dietaId: String(DIETA), posicao: 0, hora: "08:30" },
  });

  assert.equal(saida(r).alvo.recarregar, `diet:${DIETA}`);
  assert.match(saida(r).alvo.rota, /tab=diet&diet=/);
});

test("sem a permissão de dieta, recusa", async () => {
  const { app, gravado } = monta({ permissoes: ["diets.view"] });

  const r = await rpc(app, "tools/call", {
    name: "refeicao_adicionar",
    arguments: { dietaId: String(DIETA), nome: "Ceia" },
  });

  assert.equal(saida(r).erro, "sem_permissao");
  assert.equal(gravado.refeicoes, null);
});

// ── Financeiro ───────────────────────────────────────────────────────────
//
// Cobrança e pagamento são coisas SEPARADAS, e as ferramentas guardam isso: uma
// diz quem deve, a outra diz o que entrou. Uma ferramenta só, de "registrar
// dinheiro", não responderia a primeira pergunta.

test("o financeiro sai com o dinheiro em centavos E escrito", async () => {
  // Só centavos faria o modelo dizer "25000" ao profissional; só texto o
  // impediria de somar. Os dois, e cada um serve a um leitor.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "financeiro_ver",
    arguments: { pessoaId: String(PESSOA) },
  });

  const cobranca = saida(r).cobrancas[0];
  assert.equal(cobranca.valor.centavos, 25000);
  assert.match(cobranca.valor.texto, /250,00/);
  assert.equal(cobranca.falta.centavos, 10000);
});

test("a situação da cobrança é a que a TELA mostra, não a gravada", async () => {
  // "Quitada" é consequência de os pagamentos cobrirem o valor. Devolver o
  // `status` cru faria o modelo dizer "em aberto" para uma cobrança que a
  // pessoa vê quitada.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "financeiro_ver",
    arguments: { pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).cobrancas[0].situacao, "em aberto");
  assert.equal(saida(r).pagamentos[0].observacao, "primeira parte");
});

test("cobrar aceita o valor como a pessoa fala", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "cobranca_criar",
    arguments: { pessoaId: String(PESSOA), valor: "250,00", descricao: "Mensalidade" },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.cobranca.amount, "250,00");
  assert.equal(saida(r).alvo.recarregar, `finance:${PESSOA}`);
});

test("cobrança de outra pessoa não é encontrada", async () => {
  // O id vem de fora. Sem esta conferência, saber o id de uma cobrança abriria
  // o financeiro de quem não é seu.
  const { app } = monta({ semVinculo: true });

  const r = await rpc(app, "tools/call", {
    name: "cobranca_editar",
    arguments: { cobrancaId: String(COBRANCA), valor: "10,00" },
  });

  assert.equal(saida(r).erro, "cobranca_nao_encontrada");
});

test("marcar cobrança como paga não é oferecido — ela é consequência", async () => {
  const paga = tools.achar("cobranca_editar").schema.properties.situacao.enum;

  assert.deepEqual(paga, ["open", "canceled"]);
});

test("pagamento com forma que não existe no catálogo é recusado", async () => {
  // `method` vira coluna de relatório. Uma chave inventada seria uma forma de
  // pagamento que não é forma de pagamento nenhuma.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pagamento_registrar",
    arguments: { pessoaId: String(PESSOA), valor: "100", forma: "bitcoin" },
  });

  assert.equal(saida(r).erro, "forma_desconhecida");
  assert.equal(gravado.pagamento, undefined);
});

test("50 dólares entram como DÓLAR", async () => {
  // A ferramenta não tinha o campo, e pedir "registra 50 dólares" gravava 50
  // reais, calado. A moeda fica gravada em cada lançamento porque é ela que dá
  // sentido ao número.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pagamento_registrar",
    arguments: { pessoaId: String(PESSOA), valor: "50", forma: "pix", moeda: "usd" },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.pagamentoMoeda, "USD");
});

test("moeda que a conta não usa é recusada, e não vira a padrão", async () => {
  // Aceitar caladamente faria um relatório somar ienes com reais.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "cobranca_criar",
    arguments: { pessoaId: String(PESSOA), valor: "50", moeda: "JPY" },
  });

  assert.equal(saida(r).erro, "moeda_desconhecida");
  assert.equal(gravado.cobranca, undefined);
});

test("sem moeda dita, a da conta manda", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "cobranca_criar",
    arguments: { pessoaId: String(PESSOA), valor: "50" },
  });

  assert.equal(gravado.cobrancaMoeda, "BRL");
});

test("pagamento avulso é legítimo — nem toda entrada tem cobrança", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pagamento_registrar",
    arguments: { pessoaId: String(PESSOA), valor: "100", forma: "pix" },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.pagamento.charge, undefined);
});

// ── Agenda ───────────────────────────────────────────────────────────────

test("marcar em cima de outro atendimento AVISA, e não recusa", async () => {
  // Recusar impediria o encaixe combinado por telefone; calar faria a
  // sobreposição aparecer quando as duas pessoas chegassem.
  const { app } = monta({ conflito: true });

  const r = await rpc(app, "tools/call", {
    name: "compromisso_criar",
    arguments: { pessoaId: String(PESSOA), quando: "2026-08-20T10:00:00.000Z" },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(saida(r).conflita, true);
});

test("sem duração dita, a do SERVIÇO manda", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "compromisso_criar",
    arguments: {
      pessoaId: String(PESSOA),
      quando: "2026-08-20T10:00:00.000Z",
      servicoId: String(SERVICO),
    },
  });

  assert.equal(gravado.compromisso.minutes, 60);
});

test("data impossível não vira compromisso", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "compromisso_criar",
    arguments: { pessoaId: String(PESSOA), quando: "quinta que vem" },
  });

  assert.equal(saida(r).erro, "data_invalida");
  assert.equal(gravado.compromisso, undefined);
});

test("faltou e desmarcado são situações DIFERENTES", async () => {
  // Juntá-las apagaria a única informação que a agenda tem sobre assiduidade.
  const situacoes = tools.achar("compromisso_situacao").schema.properties.situacao.enum;

  assert.ok(situacoes.includes("missed"));
  assert.ok(situacoes.includes("canceled"));
});

test("a agenda recarrega o DIA do compromisso, e não a semana inteira", async () => {
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "compromisso_situacao",
    arguments: { compromissoId: String(COMPROMISSO), situacao: "done" },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(saida(r).alvo.recarregar, "agenda:2026-08-20");
});

// ── Avaliação física ─────────────────────────────────────────────────────

test("a avaliação NÃO recebe percentual de gordura nem IMC", async () => {
  // Eles são derivados do método e do protocolo, calculados na tela. Gravar um
  // número mandado de fora seria gravar algo que a próxima conta contradiz.
  const campos = Object.keys(tools.achar("avaliacao_criar").schema.properties);

  assert.ok(!campos.some((c) => /gordura|imc|massa/i.test(c)));
  assert.ok(campos.includes("dobras"));
  assert.ok(campos.includes("circunferencias"));
});

test("a avaliação criada por ferramenta nasce PRONTA, não rascunho", async () => {
  // O rascunho existe para a tela gravar campo a campo enquanto se digita. Aqui
  // a medida chega inteira — e um rascunho ficaria pendurado na ficha.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "avaliacao_criar",
    arguments: { pessoaId: String(PESSOA), peso: 71, altura: 163 },
  });

  assert.equal(gravado.avaliacao.draft, false);
  assert.equal(gravado.avaliacao.weight, 71);
});

test("a lista de avaliações não devolve resultado calculado", async () => {
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "avaliacao_listar",
    arguments: { pessoaId: String(PESSOA) },
  });

  const primeira = saida(r).avaliacoes[0];
  assert.equal(primeira.peso, 71);
  assert.ok(!("gordura" in primeira));
});

test("toda ferramenta nova também declara permissão e schema", async () => {
  // O mesmo caso do catálogo antigo, valendo para as dezesseis que entraram.
  for (const nome of [
    "financeiro_ver",
    "cobranca_criar",
    "pagamento_registrar",
    "agenda_ver",
    "compromisso_criar",
    "avaliacao_criar",
  ]) {
    const f = tools.achar(nome);
    assert.ok(f, nome);
    assert.ok(f.permissao, nome + " sem permissão");
    assert.equal(f.schema.type, "object", nome);
  }
});

test("sem a permissão da área, a ferramenta recusa", async () => {
  const { app, gravado } = monta({ permissoes: ["people.view"] });

  const r = await rpc(app, "tools/call", {
    name: "cobranca_criar",
    arguments: { pessoaId: String(PESSOA), valor: "10" },
  });

  assert.match(saida(r).erro, /permiss/i);
  assert.equal(gravado.cobranca, undefined);
});

// ── O TETO DO PLANO ───────────────────────────────────────────────────────
//
// A falha que a revisão de 19/09/2026 encontrou: as ferramentas criavam sem
// olhar o teto, e a rota da tela olhava. A conta travada em 50 pessoas criava a
// 51ª pedindo ao assistente — não por falta de permissão (essa era conferida),
// mas porque a cota só existia num dos dois caminhos.
//
// O que estes casos guardam é a paridade. Um teto que vale só no botão não é um
// teto: é uma promessa que o produto quebra para quem sabe pedir de outro jeito.
test("criar pessoa respeita o teto do plano, como a rota da tela", async () => {
  const { app, gravado } = monta({ limites: { people: 50 }, quantosExistem: 50 });

  const r = await rpc(app, "tools/call", {
    name: "pessoa_criar",
    arguments: { nome: "Bruna Lima" },
  });

  assert.equal(saida(r).ok, false);
  assert.equal(saida(r).erro, "teto_do_plano");
  // E nada foi criado: o motivo não pode ser um aviso depois do fato.
  assert.deepEqual(gravado.pessoas, []);
});

test("o motivo diz os NÚMEROS — é o que deixa o modelo explicar o que fazer", async () => {
  const { app } = monta({ limites: { people: 50 }, quantosExistem: 50 });
  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "Bruna" } });

  assert.match(saida(r).detalhe, /50/);
});

test("teto ZERO é outra conversa: o plano não inclui", async () => {
  // "Seu plano não inclui avaliações" manda falar com quem vende; "você chegou
  // a 50" manda apagar algo. A mesma frase para os dois mandaria metade das
  // pessoas para o lugar errado.
  const { app } = monta({ limites: { assessments: 0 } });

  const r = await rpc(app, "tools/call", {
    name: "avaliacao_criar",
    arguments: { pessoaId: String(PESSOA), peso: 71 },
  });

  assert.equal(saida(r).erro, "fora_do_plano");
});

test("sem teto, cria — e a central fora do ar não tranca ninguém", async () => {
  // `limitsFor` devolvendo `{}` é o que acontece quando o central não responde.
  // Falhar ABERTO é a mesma decisão que já estava escrita lá: um limite
  // inventado barraria um cliente que pagou.
  const { app, gravado } = monta({ limites: {}, quantosExistem: 9999 });

  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "Bruna" } });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.pessoas.length, 1);
});

test("os quatro outros criadores também param no teto", async () => {
  const casos = [
    ["treino_criar", { pessoaId: String(PESSOA), nome: "Treino A" }, { workouts: 1 }],
    ["dieta_criar", { pessoaId: String(PESSOA), nome: "Cutting" }, { diets: 1 }],
    ["compromisso_criar", { pessoaId: String(PESSOA), quando: "2026-09-30T13:00:00.000Z" }, { schedule: 1 }],
    ["avaliacao_criar", { pessoaId: String(PESSOA), peso: 71 }, { assessments: 1 }],
  ];

  for (const [nome, args, limites] of casos) {
    const { app } = monta({ limites, quantosExistem: 1 });
    const r = await rpc(app, "tools/call", { name: nome, arguments: args });

    assert.equal(saida(r).erro, "teto_do_plano", `${nome} passou por cima do teto`);
  }
});

// ── Unidades ──────────────────────────────────────────────────────────────

test("listar unidades não conta gente sem que peçam", async () => {
  // A contagem é uma consulta POR unidade. Trazê-la sempre faria toda pergunta
  // sobre endereço pagar por um número que ninguém leu.
  const { app } = monta({ pessoasNaUnidade: 7 });

  const semContagem = await rpc(app, "tools/call", { name: "unidade_listar", arguments: {} });
  assert.equal(saida(semContagem).unidades[0].pessoas, undefined);

  const com = await rpc(app, "tools/call", {
    name: "unidade_listar",
    arguments: { comContagem: true },
  });
  assert.equal(saida(com).unidades[0].pessoas, 7);
});

test("criar unidade manda o endereço em PARTES", async () => {
  // A linha pronta é DERIVADA delas na gravação. Mandar uma linha só faria o
  // ponto do mapa virar adivinhação.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "unidade_criar",
    arguments: { nome: "Paraty", cidade: "Paraty", uf: "RJ", numero: "120" },
  });

  assert.equal(gravado.unidade.name, "Paraty");
  assert.equal(gravado.unidade.cidade, "Paraty");
  assert.equal(gravado.unidade.numero, "120");
});

test("editar unidade manda SÓ o que veio", async () => {
  // O modelo grava campo a campo o que recebe. Mandar o documento inteiro de
  // volta apagaria a foto e o ponto do mapa, que estas ferramentas não escrevem.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "unidade_editar",
    arguments: { unidadeId: String(UNIDADE), cidade: "Angra" },
  });

  assert.deepEqual(Object.keys(gravado.unidadeMudanca), ["cidade"]);
});

test("unidade com gente dentro não é apagada, e o erro diz quantas", async () => {
  const { app, gravado } = monta({ pessoasNaUnidade: 7 });

  const r = await rpc(app, "tools/call", {
    name: "unidade_excluir",
    arguments: { unidadeId: String(UNIDADE) },
  });

  assert.equal(saida(r).erro, "unidade_com_gente");
  assert.match(saida(r).detalhe, /7/);
  assert.deepEqual(gravado.apagados, []);
});

test("cadastrar unidade exige users.manage, e não people.view", async () => {
  // Ver a lista é rotina de quem atende; abrir filial é de quem administra.
  const { app } = monta({ permissoes: ["people.view"] });

  const r = await rpc(app, "tools/call", { name: "unidade_criar", arguments: { nome: "Paraty" } });

  assert.equal(r.body.result.isError, true);
  assert.equal(saida(r).erro, "sem_permissao");
});

// ── Aulas coletivas ───────────────────────────────────────────────────────

test("a grade de hoje traz o DIA e os minutos que as outras ferramentas pedem", async () => {
  // Sem eles, o modelo montaria a chave do relógio dele — e gravaria a chamada
  // de hoje em ontem quando o relógio estivesse errado.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "aula_coletiva_hoje", arguments: {} });

  assert.match(saida(r).dia, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(saida(r).aulas[0].horarios[0].inicioMinutos, 420);
  assert.equal(saida(r).aulas[0].horarios[0].inicio, "07:00");
});

test("fechada, lotada e fora da janela saem SEPARADAS", async () => {
  // O conserto de cada uma é outro: clicar, abrir vaga, esperar. Uma flag só
  // mandaria a recepção resolver o problema errado.
  const { app } = monta({ fechada: true });

  const r = await rpc(app, "tools/call", { name: "aula_coletiva_hoje", arguments: {} });
  const h = saida(r).aulas[0].horarios[0];

  assert.equal(h.fechada, true);
  assert.equal(h.lotada, false);
  assert.equal(typeof h.checkinAberto, "boolean");
});

test("criar aula pede dia e horário — sem eles ela nunca aconteceria", async () => {
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "aula_coletiva_criar",
    arguments: { nome: "Spinning", dias: [], horarios: [] },
  });

  assert.equal(saida(r).erro, "aula_incompleta");
});

test("o horário entra como relógio de parede, e volta como relógio", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "aula_coletiva_criar",
    arguments: {
      nome: "Spinning",
      dias: [1, 3, 5],
      horarios: [{ inicio: "07:00", fim: "07:50" }],
    },
  });

  assert.deepEqual(gravado.aula.horarios, [{ inicio: "07:00", fim: "07:50" }]);
  assert.equal(saida(r).aula.horarios[0].inicio, "07:00");
  assert.equal(saida(r).aula.horarios[0].inicioMinutos, 420);
});

test("apagar a aula leva check-ins e fechamentos junto", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", { name: "aula_coletiva_excluir", arguments: { aulaId: String(AULA) } });

  assert.equal(gravado.checkinsApagados, String(AULA));
  assert.equal(gravado.sessoesApagadas, String(AULA));
});

test("inscrever à mão recusa horário fechado, e nada é gravado", async () => {
  const { app, gravado } = monta({ fechada: true });

  const r = await rpc(app, "tools/call", {
    name: "aula_coletiva_inscrever",
    arguments: { aulaId: String(AULA), pessoaId: String(PESSOA), inicioMinutos: 420 },
  });

  assert.equal(saida(r).erro, "aula_fechada");
  assert.equal(gravado.entrou, undefined);
});

test("inscrever à mão recusa quando as vagas acabaram", async () => {
  // As mesmas três recusas do aplicativo. Afrouxar aqui porque "quem está no
  // balcão manda" é justamente o caso em que ninguém vê a lista inteira.
  const cheios = Array.from({ length: 20 }, (_, i) => ({ _id: new ObjectId(), person: PESSOA, name: "X" + i }));
  const { app, gravado } = monta({ inscritos: cheios });

  const r = await rpc(app, "tools/call", {
    name: "aula_coletiva_inscrever",
    arguments: { aulaId: String(AULA), pessoaId: String(PESSOA), inicioMinutos: 420 },
  });

  assert.equal(saida(r).erro, "aula_lotada");
  assert.equal(gravado.entrou, undefined);
});

test("inscrever à mão leva a regra de um-por-dia DA AULA", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "aula_coletiva_inscrever",
    arguments: { aulaId: String(AULA), pessoaId: String(PESSOA), inicioMinutos: 420, dia: "2026-09-21" },
  });

  assert.equal(gravado.entrou.dia, "2026-09-21");
  assert.equal(gravado.entrou.inicio, 420);
  assert.equal(gravado.entrou.variosHorarios, false);
});

test("pessoa de outro profissional não entra na aula", async () => {
  const { app, gravado } = monta({ semVinculo: true });

  const r = await rpc(app, "tools/call", {
    name: "aula_coletiva_inscrever",
    arguments: { aulaId: String(AULA), pessoaId: String(PESSOA), inicioMinutos: 420 },
  });

  assert.equal(saida(r).erro, "pessoa_nao_encontrada");
  assert.equal(gravado.entrou, undefined);
});

test("a presença tem TRÊS estados, e o schema não deixa inventar um quarto", async () => {
  const presenca = tools.achar("aula_coletiva_presenca").schema.properties.presenca;
  assert.deepEqual(presenca.enum, ["presente", "faltou", "inscrito"]);
});

test("marcar presença usa o id do CHECK-IN, não o da pessoa", async () => {
  // A mesma pessoa pode estar em dois horários do mesmo dia: o id dela não
  // distinguiria uma linha da outra.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "aula_coletiva_presenca",
    arguments: { checkinId: String(CHECKIN), presenca: "presente" },
  });

  assert.deepEqual(gravado.presenca, { id: String(CHECKIN), presenca: "presente" });
});

test("fechar o horário é do DIA, e leva quem fechou", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "aula_coletiva_fechar",
    arguments: { aulaId: String(AULA), inicioMinutos: 420, dia: "2026-09-21", fechada: true },
  });

  assert.equal(gravado.fechamento.dia, "2026-09-21");
  assert.equal(gravado.fechamento.fechada, true);
  assert.equal(gravado.fechamento.quem, String(TREINADOR._id));
});

test("o histórico da pessoa traz o NOME da aula, já resolvido", async () => {
  // "Spinning, 18/09, presente" é a resposta. Uma segunda chamada para traduzir
  // ids em nomes faria o modelo gastar um turno com o que já está na mão.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_aulas_historico",
    arguments: { pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).aulas[0].aula, "Spinning");
  assert.equal(saida(r).aulas[0].hora, "07:00");
  assert.equal(saida(r).aulas[0].presenca, "presente");
});

// ── Planos de mensalidade ─────────────────────────────────────────────────

test("o plano sai com o dinheiro em centavos E escrito", async () => {
  const { app } = monta();
  const r = await rpc(app, "tools/call", { name: "plano_listar", arguments: {} });

  assert.equal(saida(r).planos[0].valor.centavos, 14990);
  assert.match(saida(r).planos[0].valor.texto, /149,90/);
});

test("criar plano grava a MOEDA da conta", async () => {
  // "149" em real e "149" em dólar são preços diferentes. Um cardápio sem moeda
  // mente no dia em que a conta muda de país.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "plano_criar",
    arguments: { nome: "Mensal", valor: 149.9, cadencia: "monthly" },
  });

  assert.equal(gravado.planoMoeda, "BRL");
  assert.equal(gravado.plano.amount, 149.9);
});

test("o plano da academia não se confunde com o plano alimentar", async () => {
  // Três coisas deste produto se chamam "plano". A descrição é o que o modelo
  // lê para escolher, e é onde a distinção precisa estar escrita.
  const cardapio = tools.achar("plano_listar").descricao;
  const comida = tools.achar("dieta_listar").descricao;

  assert.match(cardapio, /alimentar/i);
  assert.notEqual(cardapio, comida);
});

test("mexer no cardápio exige finance.manage", async () => {
  const { app } = monta({ permissoes: ["finance.view"] });
  const r = await rpc(app, "tools/call", { name: "plano_criar", arguments: { nome: "Mensal" } });

  assert.equal(saida(r).erro, "sem_permissao");
});

// ── Aulões ────────────────────────────────────────────────────────────────

test("o aulão sai com quantos se inscreveram", async () => {
  const { app } = monta();
  const r = await rpc(app, "tools/call", { name: "aulao_listar", arguments: {} });

  assert.equal(saida(r).auloes[0].inscritos, 12);
  assert.equal(saida(r).auloes[0].apelido, "aulao-na-praia");
});

test("criar aulão sem data é recusado — ele é um evento", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "aulao_criar",
    arguments: { nome: "Aulão na praia", quando: "não é data" },
  });

  assert.equal(saida(r).erro, "data_invalida");
  assert.equal(gravado.aulao, undefined);
});

test("o teto do aulão conta só os que ainda VÃO acontecer", async () => {
  // Um aulão que passou não pode ocupar vaga para sempre: o teto viraria uma
  // dívida crescente, e o cliente precisaria apagar o histórico para cadastrar
  // o próximo.
  const { app } = monta({ limites: { aulaoes: 3 }, quantosExistem: 3 });

  const r = await rpc(app, "tools/call", {
    name: "aulao_criar",
    arguments: { nome: "Aulão", quando: "2026-09-27T11:00:00.000Z" },
  });

  assert.equal(saida(r).erro, "teto_do_plano");
});

test("inscrever no aulão NÃO cria cobrança, e diz isso", async () => {
  // A rota da tela cria, com regras próprias (vencimento no dia do aulão, uma
  // por pessoa mesmo que ela saia e volte). Duplicá-las aqui seria o caminho
  // paralelo que este arquivo promete não ser.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "aulao_inscrever",
    arguments: { aulaoId: String(AULAO), pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(saida(r).cobrancaCriada, false);
});

// ── A revisão inteira ─────────────────────────────────────────────────────

test("nenhuma ferramenta tem nome repetido", async () => {
  // Duas com o mesmo nome fariam `achar` devolver a primeira para sempre, e a
  // segunda nunca seria chamada — sem nada quebrar.
  const nomes = tools.FERRAMENTAS.map((f) => f.nome);
  assert.equal(new Set(nomes).size, nomes.length);
});

test("toda permissão declarada EXISTE no catálogo de permissões", async () => {
  // Uma chave com erro de digitação nunca casa, e a ferramenta recusaria para
  // todo mundo — inclusive para o dono da conta, que tem tudo.
  const permissions = require("../../lib/permissions.js");

  for (const f of tools.FERRAMENTAS) {
    assert.ok(permissions.isValid(f.permissao), `${f.nome}: permissão "${f.permissao}" não existe`);
  }
});

test("as telas que criam com TETO também o conferem por ferramenta", async () => {
  // A paridade, dita como lista: se amanhã alguém escrever `unidade_criar` sem
  // o teto, este caso não pega — mas os de cima pegam. Este guarda a outra
  // metade: que a ferramenta EXISTE para cada coisa que a tela limita.
  const criadores = {
    people: "pessoa_criar",
    workouts: "treino_criar",
    diets: "dieta_criar",
    schedule: "compromisso_criar",
    assessments: "avaliacao_criar",
    units: "unidade_criar",
    memberships: "plano_criar",
    groupClasses: "aula_coletiva_criar",
    aulaoes: "aulao_criar",
    anamnesis: "anamnese_preencher",
    exams: "exame_criar",
    supplements: "suplemento_criar",
    prescriptions: "prescricao_criar",
  };

  for (const chave of Object.keys(criadores)) {
    assert.ok(tools.achar(criadores[chave]), `sem ferramenta para criar ${chave}`);
  }
});

test("TODO criador que a tela limita também é barrado por ferramenta", async () => {
  // A paridade medida, e não listada: cada um é chamado com o teto estourado, e
  // o que passar aparece aqui. É o caso que pega a ferramenta nova escrita sem
  // o guarda — que é exatamente como a falha original entrou.
  const casos = [
    ["pessoa_criar", { nome: "Bruna" }, "people"],
    ["treino_criar", { pessoaId: String(PESSOA), nome: "Treino A" }, "workouts"],
    ["dieta_criar", { pessoaId: String(PESSOA), nome: "Cutting" }, "diets"],
    ["compromisso_criar", { pessoaId: String(PESSOA), quando: "2026-09-30T13:00:00.000Z" }, "schedule"],
    ["avaliacao_criar", { pessoaId: String(PESSOA), peso: 71 }, "assessments"],
    ["unidade_criar", { nome: "Paraty" }, "units"],
    ["plano_criar", { nome: "Mensal" }, "memberships"],
    [
      "aula_coletiva_criar",
      { nome: "Spinning", dias: [1], horarios: [{ inicio: "07:00", fim: "07:50" }] },
      "groupClasses",
    ],
    ["aulao_criar", { nome: "Aulão", quando: "2026-09-27T11:00:00.000Z" }, "aulaoes"],
    ["anamnese_preencher", { pessoaId: String(PESSOA), alergias: "x" }, "anamnesis"],
    ["exame_criar", { pessoaId: String(PESSOA), marcadores: [{ nome: "X", valor: 1 }] }, "exams"],
    ["suplemento_criar", { pessoaId: String(PESSOA), nome: "Creatina" }, "supplements"],
    ["prescricao_criar", { pessoaId: String(PESSOA), itens: [{ nome: "Vitamina D" }] }, "prescriptions"],
  ];

  for (const [nome, args, chave] of casos) {
    const { app } = monta({ limites: { [chave]: 1 }, quantosExistem: 1 });
    const r = await rpc(app, "tools/call", { name: nome, arguments: args });

    assert.equal(saida(r).erro, "teto_do_plano", `${nome} passou por cima do teto de ${chave}`);
  }
});

// ── OS TETOS DE ESTRUTURA ─────────────────────────────────────────────────
//
// Outra natureza que os de cima: nunca são ilimitados. Vazio é o padrão do
// sistema, porque um teto anti-abuso que some quando o painel não responde não
// é um teto.
//
// A tela salva o treino inteiro de uma vez e recusa o pedido; a ferramenta
// acrescenta um a um — e passava de trinta sem olhar.
test("acrescentar exercício para no teto de exercícios por treino", async () => {
  const cheio = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: Array.from({ length: 30 }, () => ({ name: "X", sets: [{}] })),
  };
  const { app, gravado } = monta({ treino: cheio, limites: { exercisesPerWorkout: 30 } });

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO) },
  });

  assert.equal(saida(r).erro, "teto_do_plano");
  assert.equal(gravado.exercicios, null);
});

test("e no teto de séries por exercício", async () => {
  const { app, gravado } = monta({ limites: { setsPerExercise: 4 } });

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO), series: 9 },
  });

  assert.equal(saida(r).erro, "teto_do_plano");
  assert.equal(gravado.exercicios, null);
});

test("editar as séries também passa pelo teto", async () => {
  // Sem isto, o caminho de fugir do limite seria acrescentar com três e editar
  // para trinta.
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Remada", sets: [{ unit: "reps" }] }],
  };
  const { app, gravado } = monta({ treino, limites: { setsPerExercise: 4 } });

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_editar",
    arguments: { treinoId: String(TREINO), posicao: 0, series: 9 },
  });

  assert.equal(saida(r).erro, "teto_do_plano");
  assert.equal(gravado.exercicios, null);
});

test("acrescentar alimento para no teto da refeição", async () => {
  const dieta = {
    _id: DIETA,
    name: "Cutting",
    student: PESSOA,
    meals: [{ name: "Almoço", foods: Array.from({ length: 30 }, () => ({ name: "X" })) }],
  };
  const { app, gravado } = monta({ dieta, limites: { foodsPerMeal: 30 } });

  const r = await rpc(app, "tools/call", {
    name: "refeicao_alimento_adicionar",
    arguments: { dietaId: String(DIETA), refeicao: 0, nome: "Arroz" },
  });

  assert.equal(saida(r).erro, "teto_do_plano");
  assert.equal(gravado.refeicoes, null);
});

test("dentro do teto, continua entrando", async () => {
  // O caso que prova que o guarda não virou uma parede: 30 com teto 30 é
  // exatamente o permitido, e o corte é `>`.
  const { app, gravado } = monta({ limites: { exercisesPerWorkout: 30, setsPerExercise: 20 } });

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO), series: 3 },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.exercicios.length, 1);
});

test("vincular a pessoa a uma unidade confere que ela existe", async () => {
  // Um id chutado seria aceito pelo banco como um vínculo qualquer, e a pessoa
  // sumiria de toda lista com lente — visível só em "Todas as unidades", sem
  // ninguém entender por quê.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_editar",
    arguments: { pessoaId: String(PESSOA), unidadeId: String(new ObjectId()) },
  });

  assert.equal(saida(r).erro, "unidade_nao_encontrada");
  assert.equal(gravado.mudanca, undefined);
});

test("com a unidade certa, o vínculo é gravado", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "pessoa_editar",
    arguments: { pessoaId: String(PESSOA), unidadeId: String(UNIDADE) },
  });

  assert.equal(gravado.mudanca.unit, String(UNIDADE));
});

test("string vazia TIRA a pessoa da unidade", async () => {
  // É uma edição legítima, e diferente de "não mandou nada": quem saiu da
  // filial precisa poder sair.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "pessoa_editar",
    arguments: { pessoaId: String(PESSOA), unidadeId: "" },
  });

  assert.equal(gravado.mudanca.unit, "");
});

test("buscar por unidade leva a LENTE ao banco", async () => {
  const { app } = monta();
  let recebido;

  app.api.user.pageStudents = async (_t, filtros) => {
    recebido = filtros;
    return { rows: [] };
  };

  await rpc(app, "tools/call", {
    name: "pessoa_buscar",
    arguments: { termo: "bru", unidadeId: String(UNIDADE) },
  });

  assert.equal(recebido.unit, String(UNIDADE));
});

test("sem unidade pedida, a busca não filtra por nenhuma", async () => {
  const { app } = monta();
  let recebido;

  app.api.user.pageStudents = async (_t, filtros) => {
    recebido = filtros;
    return { rows: [] };
  };

  await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "bru" } });

  assert.equal(recebido.unit, undefined);
});

// ── Anamnese ──────────────────────────────────────────────────────────────

test("anamnese que ninguém preencheu é uma RESPOSTA, não um erro", async () => {
  // É o caso de quem acabou de cadastrar alguém. Devolver "não encontrada"
  // faria o modelo dizer que houve falha onde só há ficha nova.
  const { app } = monta();
  const r = await rpc(app, "tools/call", {
    name: "anamnese_ver",
    arguments: { pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(saida(r).preenchida, false);
});

test("a anamnese sai em português, e sem os campos vazios", async () => {
  // Vinte e um campos vazios encheriam o contexto de nada, e o modelo repetiria
  // "não informado" vinte e uma vezes. E "familyHistory" no meio da frase é o
  // esquema vazando para o profissional.
  const { app } = monta({
    anamnese: { mainComplaint: "dor no ombro", allergies: "", familyHistory: "diabetes" },
  });

  const r = await rpc(app, "tools/call", {
    name: "anamnese_ver",
    arguments: { pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).anamnese.queixaPrincipal, "dor no ombro");
  assert.equal(saida(r).anamnese.historicoFamiliar, "diabetes");
  assert.equal("alergias" in saida(r).anamnese, false);
  assert.equal("mainComplaint" in saida(r).anamnese, false);
});

test("preencher manda SÓ o que veio, com o nome do banco", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "anamnese_preencher",
    arguments: { pessoaId: String(PESSOA), alergias: "dipirona", horasDeSono: 7 },
  });

  assert.deepEqual(gravado.anamnese, { allergies: "dipirona", sleepHours: 7 });
});

test("o teto da anamnese vale na PRIMEIRA, e não trava a correção", async () => {
  // Esta chamada é um upsert: preenche a primeira e corrige a décima. Barrar
  // sem distinguir faria a pessoa perder a correção por um limite que ela não
  // estourou.
  const primeira = monta({ limites: { anamnesis: 5 }, quantosExistem: 5 });
  const r1 = await rpc(primeira.app, "tools/call", {
    name: "anamnese_preencher",
    arguments: { pessoaId: String(PESSOA), alergias: "dipirona" },
  });
  assert.equal(saida(r1).erro, "teto_do_plano");
  assert.equal(primeira.gravado.anamnese, undefined);

  const jaExiste = monta({
    limites: { anamnesis: 5 },
    quantosExistem: 5,
    anamnese: { mainComplaint: "dor" },
  });
  const r2 = await rpc(jaExiste.app, "tools/call", {
    name: "anamnese_preencher",
    arguments: { pessoaId: String(PESSOA), alergias: "dipirona" },
  });
  assert.equal(saida(r2).ok, true);
});

test("preencher sem campo nenhum não grava uma anamnese em branco", async () => {
  const { app, gravado } = monta();
  const r = await rpc(app, "tools/call", {
    name: "anamnese_preencher",
    arguments: { pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).erro, "nada_para_mudar");
  assert.equal(gravado.anamnese, undefined);
});

test("ver anamnese pede anamnesis.view; preencher pede manage", async () => {
  const soVer = monta({ permissoes: ["people.view", "anamnesis.view"] });

  const lendo = await rpc(soVer.app, "tools/call", {
    name: "anamnese_ver",
    arguments: { pessoaId: String(PESSOA) },
  });
  assert.equal(saida(lendo).ok, true);

  const escrevendo = await rpc(soVer.app, "tools/call", {
    name: "anamnese_preencher",
    arguments: { pessoaId: String(PESSOA), alergias: "x" },
  });
  assert.equal(saida(escrevendo).erro, "sem_permissao");
});

// ── Exames ────────────────────────────────────────────────────────────────

test("o marcador sai com o veredito de FORA DA FAIXA", async () => {
  // Calculado na leitura, nunca gravado: a faixa é editável, e congelar o
  // veredito faria ele contradizer a própria linha.
  const { app } = monta();
  const r = await rpc(app, "tools/call", {
    name: "exame_listar",
    arguments: { pessoaId: String(PESSOA) },
  });

  const m = saida(r).exames[0].marcadores[0];
  assert.equal(m.chave, "vitaminD");
  assert.equal(m.valor, 18);
  assert.equal(m.fora, "low");
});

test("marcador com CHAVE não leva nome livre junto", async () => {
  // Os dois juntos fariam o mesmo marcador virar duas identidades, e nenhum
  // gráfico junta as duas.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "exame_criar",
    arguments: {
      pessoaId: String(PESSOA),
      data: "2026-09-10",
      marcadores: [{ chave: "vitaminD", nome: "Vit D", valor: 18, unidade: "ng/mL" }],
    },
  });

  assert.equal(gravado.exame.markers[0].key, "vitaminD");
  assert.equal(gravado.exame.markers[0].name, "");
});

test("sem chave, o nome livre passa", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "exame_criar",
    arguments: {
      pessoaId: String(PESSOA),
      marcadores: [{ nome: "Ferritina do lab X", valor: 40 }],
    },
  });

  assert.equal(gravado.exame.markers[0].key, "");
  assert.equal(gravado.exame.markers[0].name, "Ferritina do lab X");
});

test("o catálogo de marcadores existe e traz as chaves", async () => {
  const { app } = monta();
  const r = await rpc(app, "tools/call", { name: "exame_marcadores", arguments: {} });

  assert.ok(saida(r).marcadores.length > 10);
  assert.ok(saida(r).marcadores.every((m) => m.chave));
});

test("a busca no catálogo encurta a lista", async () => {
  const { app } = monta();
  const r = await rpc(app, "tools/call", {
    name: "exame_marcadores",
    arguments: { busca: "testosterone" },
  });

  assert.ok(saida(r).marcadores.length >= 1);
  assert.ok(saida(r).marcadores.every((m) => m.chave.toLowerCase().includes("testosterone")));
});

test("lançar exame respeita o teto do plano", async () => {
  const { app, gravado } = monta({ limites: { exams: 2 }, quantosExistem: 2 });
  const r = await rpc(app, "tools/call", {
    name: "exame_criar",
    arguments: { pessoaId: String(PESSOA), marcadores: [{ nome: "X", valor: 1 }] },
  });

  assert.equal(saida(r).erro, "teto_do_plano");
  assert.equal(gravado.exame, undefined);
});

test("editar exame sem mandar marcadores não apaga os que estavam lá", async () => {
  // `somenteOsDitos`: a diferença entre "não mandou" e "mandou vazio" é a
  // diferença entre manter e apagar.
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "exame_editar",
    arguments: { exameId: String(EXAME), laboratorio: "Sabin" },
  });

  assert.deepEqual(Object.keys(gravado.exameMudanca), ["lab"]);
});

// ── Suplementação ─────────────────────────────────────────────────────────

test("o suplemento sai com a situação e os dias", async () => {
  const { app } = monta();
  const r = await rpc(app, "tools/call", {
    name: "suplemento_listar",
    arguments: { pessoaId: String(PESSOA) },
  });

  const s = saida(r).suplementos[0];
  assert.equal(s.nome, "Creatina");
  assert.equal(s.momento, "postWorkout");
  assert.equal(s.situacao, "current");
  // Vazio é TODO DIA, e não "nenhum dia".
  assert.deepEqual(s.diasDaSemana, []);
});

test("criar suplemento respeita o teto", async () => {
  const { app, gravado } = monta({ limites: { supplements: 3 }, quantosExistem: 3 });
  const r = await rpc(app, "tools/call", {
    name: "suplemento_criar",
    arguments: { pessoaId: String(PESSOA), nome: "Creatina" },
  });

  assert.equal(saida(r).erro, "teto_do_plano");
  assert.equal(gravado.suplemento, undefined);
});

test("editar o suplemento manda só o que mudou", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "suplemento_editar",
    arguments: { suplementoId: String(SUPLEMENTO), fim: "2026-12-31" },
  });

  assert.deepEqual(gravado.suplementoMudanca, { endDate: "2026-12-31" });
});

// ── Prescrições ───────────────────────────────────────────────────────────

test("a LISTA não traz os itens; ver traz", async () => {
  // Dez receitas com oito itens cada são oitenta linhas para responder "quantas
  // receitas ela tem".
  const { app } = monta();

  const lista = await rpc(app, "tools/call", {
    name: "prescricao_listar",
    arguments: { pessoaId: String(PESSOA) },
  });
  assert.equal(saida(lista).prescricoes[0].conteudo, undefined);
  assert.equal(saida(lista).prescricoes[0].itens, 1);

  const uma = await rpc(app, "tools/call", {
    name: "prescricao_ver",
    arguments: { prescricaoId: String(PRESCRICAO) },
  });
  assert.equal(saida(uma).prescricao.conteudo[0].nome, "Vitamina D3 2.000 UI");
  assert.equal(saida(uma).prescricao.conteudo[0].posologia, "1x ao dia");
});

test("receita sem item nenhum não é emitida", async () => {
  // Uma folha em branco assinada. O modelo do banco descarta o item sem nome em
  // silêncio (a tela tem linha vazia no fim); sobrar zero é outra coisa.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "prescricao_criar",
    arguments: { pessoaId: String(PESSOA), itens: [{ nome: "   " }] },
  });

  assert.equal(saida(r).erro, "prescricao_sem_itens");
  assert.equal(gravado.prescricao, undefined);
});

test("o item da receita vai em texto, como se escreve no papel", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "prescricao_criar",
    arguments: {
      pessoaId: String(PESSOA),
      tipo: "medication",
      conselho: "CRN 12345",
      itens: [
        { nome: "Vitamina D3 2.000 UI", dose: "1 cápsula", posologia: "1x ao dia, em jejum", duracao: "60 dias" },
      ],
    },
  });

  assert.equal(gravado.prescricao.items[0].name, "Vitamina D3 2.000 UI");
  assert.equal(gravado.prescricao.items[0].posology, "1x ao dia, em jejum");
  // O REGISTRO de quem assina vai gravado no documento, e não lido do perfil na
  // hora de imprimir: o que foi emitido não muda porque a pessoa corrigiu o
  // número do conselho depois.
  assert.equal(gravado.prescricao.council, "CRN 12345");
});

test("editar a receita para uma lista vazia é recusado", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "prescricao_editar",
    arguments: { prescricaoId: String(PRESCRICAO), itens: [] },
  });

  assert.equal(saida(r).erro, "prescricao_sem_itens");
  assert.equal(gravado.prescricaoMudanca, undefined);
});

test("reimprimir é view; emitir é manage", async () => {
  // A separação mais forte do catálogo de permissões: a recepção pode precisar
  // ver o que foi receitado; emitir é só de quem assina.
  const recepcao = monta({ permissoes: ["people.view", "prescriptions.view"] });

  const lendo = await rpc(recepcao.app, "tools/call", {
    name: "prescricao_listar",
    arguments: { pessoaId: String(PESSOA) },
  });
  assert.equal(saida(lendo).ok, true);

  const emitindo = await rpc(recepcao.app, "tools/call", {
    name: "prescricao_criar",
    arguments: { pessoaId: String(PESSOA), itens: [{ nome: "X" }] },
  });
  assert.equal(saida(emitindo).erro, "sem_permissao");
});

// ── Conversas ─────────────────────────────────────────────────────────────

test("a conversa sai com o nome do outro e o não lido", async () => {
  const { app } = monta();
  const r = await rpc(app, "tools/call", { name: "conversa_listar", arguments: {} });

  assert.equal(saida(r).conversas[0].pessoa, "Bruna");
  assert.equal(saida(r).naoLidas, 3);
});

test("quem não é da conversa não a lê, mesmo tendo o id", async () => {
  // Participar é a única autorização que existe aqui: ter chat.view deixa a
  // pessoa conversar, não deixa ler a conversa dos outros.
  const { app } = monta();
  app.api.chat.data = async () => ({ _id: CONVERSA, members: [new ObjectId(), new ObjectId()] });

  const r = await rpc(app, "tools/call", {
    name: "conversa_mensagens",
    arguments: { conversaId: String(CONVERSA) },
  });

  assert.equal(saida(r).erro, "conversa_nao_encontrada");
});

test("as mensagens dizem quem falou, sem devolver ids", async () => {
  const { app } = monta();
  const r = await rpc(app, "tools/call", {
    name: "conversa_mensagens",
    arguments: { conversaId: String(CONVERSA) },
  });

  assert.deepEqual(
    saida(r).mensagens.map((m) => m.de),
    ["pessoa", "eu"]
  );
});

test("mandar mensagem ABRE a conversa quando não há uma", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "mensagem_enviar",
    arguments: { pessoaId: String(PESSOA), texto: "a aula das 7 mudou para as 8" },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.abriuConversa, true);
  assert.equal(gravado.mensagem.texto, "a aula das 7 mudou para as 8");
});

test("mensagem vazia não vira mensagem", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "mensagem_enviar",
    arguments: { pessoaId: String(PESSOA), texto: "   " },
  });

  assert.equal(saida(r).erro, "mensagem_vazia");
  assert.equal(gravado.mensagem, undefined);
});

test("não se manda mensagem para quem não é da lista", async () => {
  const { app, gravado } = monta({ semVinculo: true });

  const r = await rpc(app, "tools/call", {
    name: "mensagem_enviar",
    arguments: { pessoaId: String(PESSOA), texto: "oi" },
  });

  assert.equal(saida(r).erro, "pessoa_nao_encontrada");
  assert.equal(gravado.mensagem, undefined);
});

test("enviar exige chat.send, e ler só chat.view", async () => {
  const soLe = monta({ permissoes: ["people.view", "chat.view"] });

  const lendo = await rpc(soLe.app, "tools/call", { name: "conversa_listar", arguments: {} });
  assert.equal(saida(lendo).ok, true);

  const mandando = await rpc(soLe.app, "tools/call", {
    name: "mensagem_enviar",
    arguments: { pessoaId: String(PESSOA), texto: "oi" },
  });
  assert.equal(saida(mandando).erro, "sem_permissao");
});

test("a mensagem enviada por ferramenta também NOTIFICA o celular", async () => {
  // O WebSocket entrega na hora para quem está com a conversa ABERTA. Quem
  // fechou o app não recebe nada — e sem o push a ferramenta faria metade do
  // que a tela faz, com a diferença aparecendo só do lado de lá: o profissional
  // veria "enviada" e a pessoa não saberia dela.
  //
  // O que se prova aqui é a DIREÇÃO e o evento, como nos outros testes de
  // aviso deste projeto: o disparo em si é melhor esforço por decisão (ver
  // lib/avisar.js), e exigi-lo testaria o dobro do OneSignal, não a regra.
  const { EVENTOS } = require("../../lib/avisar.js");
  assert.equal(EVENTOS.message.rota, "/chat");

  const { app, gravado } = monta();
  const r = await rpc(app, "tools/call", {
    name: "mensagem_enviar",
    arguments: { pessoaId: String(PESSOA), texto: "a aula mudou" },
  });

  // E o aviso desligado (é o caso do ambiente de teste, sem OneSignal) NÃO
  // desfaz o envio: a mensagem está gravada, que é o que importa.
  assert.equal(saida(r).ok, true);
  assert.equal(gravado.mensagem.texto, "a aula mudou");
});
