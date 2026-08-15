const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const rateLimit = require("../../lib/rateLimit.js");
const BookingController = require("../../controllers/Booking.js");
const BookingPage_model = require("../../model/BookingPage_model.js");

// As páginas de agendamento, pela porta da rua.
//
// Uma página é um RECORTE: um apelido na URL (`/g/avaliacao`) e a escolha
// de quais serviços e profissionais aparecem nela.
//
// O que estes testes existem para provar é uma coisa só, e é a que separa
// filtro de enfeite: **o recorte vale na hora de MARCAR**, não só na listagem.
// Filtrar apenas a tela deixaria qualquer um trocar um id no pedido e marcar um
// serviço que a página não oferece.
const PRO_A = new ObjectId();
const PRO_B = new ObjectId();
const SERVICO_A = new ObjectId();
const SERVICO_B = new ObjectId();

const USUARIO = { _id: new ObjectId(), name: "Marlon" };

// O jeito que o modelo de verdade responde as duas perguntas do recorte — é
// dele que a rota depende, então é ele que entra aqui.
const recorte = new BookingPage_model({});

// Um dia útil daqui a uma semana, às 10h — dentro do horizonte e longe da
// antecedência mínima, para o caminho feliz não depender de que horas o teste
// roda. Hora LOCAL: é assim que a grade semanal é lida.
function daquiUmaSemana() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(10, 0, 0, 0);
  return d;
}

const DIAS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function gradeAbertaEm(quando) {
  return { [DIAS[quando.getDay()]]: [{ from: "08:00", to: "18:00" }] };
}

// `semGrade` é quem nunca abriu a configuração de agenda: não há documento de
// disponibilidade nenhum para essa conta. Com a grade por profissional fora da
// tela, esse passou a ser o caso NORMAL de uma casa nova.
function monta({ paginas = [], grades = null, servicos = null, semana = {}, semGrade = false } = {}) {
  const permissao = permiteTudo(USUARIO);
  const marcados = [];

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      center: {
        async byHost() {
          return { instance: "marlon", active: 1 };
        },
      },
      bookingPage: {
        async bySlug(slug) {
          return paginas.find((p) => p.slug === slug && p.active === 1);
        },
        ofereceServico: recorte.ofereceServico,
        ofereceProfissional: recorte.ofereceProfissional,
        async list() {
          return paginas;
        },
      },
      availability: {
        async listActive() {
          return (
            grades || [
              { professional: PRO_A, active: 1, weekdays: {}, slotStep: 30 },
              { professional: PRO_B, active: 1, weekdays: {}, slotStep: 30 },
            ]
          );
        },
        async of(id) {
          if (semGrade) return undefined;
          return { professional: id, active: 1, weekdays: semana, slotStep: 30, blocks: [] };
        },
      },
      user: {
        // Quem é profissional na casa. É daqui que sai a lista de uma página
        // com horário próprio: ela não depende mais de cada um ter ligado a
        // própria agenda.
        async professionals() {
          return [
            { _id: PRO_A, name: "Ana" },
            { _id: PRO_B, name: "Bruno" },
          ];
        },
        async briefByIds() {
          return {
            [String(PRO_A)]: { name: "Ana" },
            [String(PRO_B)]: { name: "Bruno" },
          };
        },
        async dataByEmail() {
          return undefined;
        },
        async insertStudent() {
          return new ObjectId();
        },
      },
      link: {
        async link() {
          return true;
        },
      },
      service: {
        async list() {
          return (
            servicos || [
              { _id: SERVICO_A, name: "Avaliação", minutes: 60, price: 0, capacity: 1, active: 1, professionals: [] },
              { _id: SERVICO_B, name: "Personal", minutes: 60, price: 12000, capacity: 1, active: 1, professionals: [] },
            ]
          );
        },
        async data(id) {
          const todos = await this.list();
          return todos.find((s) => String(s._id) === String(id));
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL" };
        },
      },
      appointment: {
        async between() {
          return [];
        },
        async insert(profissional, aluno, dados) {
          marcados.push({ profissional, aluno, ...dados });
          return new ObjectId();
        },
        async data(_profissionais, id) {
          return { _id: id, date: new Date() };
        },
      },
    },
  });

  BookingController(app);
  return { app, marcados };
}

const PAGINA_AVALIACAO = {
  _id: new ObjectId(),
  slug: "avaliacao",
  name: "Avaliação gratuita",
  intro: "Escolha o melhor horário.",
  active: 1,
  services: [SERVICO_A],
  professionals: [PRO_A],
};

const publico = (app, caminho, query) =>
  call(app, "get", caminho, { query: { host: "marlon.gofitnow.fit", ...query } });

// ── A listagem ───────────────────────────────────────────────────────────

test("sem apelido, a agenda de sempre — tudo aparece", async () => {
  // É o que mantém `/g` funcionando para quem nunca criou página
  // nenhuma, e o que faz este recurso nascer sem migração.
  const { app } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await publico(app, "/public/booking");

  assert.equal(r.status, 200);
  assert.equal(r.body.professionals.length, 2);
  assert.equal(r.body.services.length, 2);
  assert.equal(r.body.page, undefined);
});

test("com apelido, só o que a página escolheu", async () => {
  const { app } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await publico(app, "/public/booking", { slug: "avaliacao" });

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.services.map((s) => s.name), ["Avaliação"]);
  assert.deepEqual(r.body.professionals.map((p) => p.name), ["Ana"]);
});

test("o nome e o texto da página vão junto — quem chegou pelo anúncio se reconhece", async () => {
  const { app } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await publico(app, "/public/booking", { slug: "avaliacao" });

  assert.equal(r.body.page.name, "Avaliação gratuita");
  assert.equal(r.body.page.intro, "Escolha o melhor horário.");
});

test("apelido que não existe é 404 — não a agenda inteira", async () => {
  // Cair na agenda completa seria pior que o erro: o link errado mostraria
  // tudo o que a pessoa queria esconder.
  const { app } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await publico(app, "/public/booking", { slug: "nao-existe" });

  assert.equal(r.status, 404);
});

test("página PAUSADA responde como página que não existe", async () => {
  const pausada = { ...PAGINA_AVALIACAO, slug: "pausada", active: 0 };
  const { app } = monta({ paginas: [pausada] });

  const r = await publico(app, "/public/booking", { slug: "pausada" });

  assert.equal(r.status, 404);
});

test("página sem escolha nenhuma mostra tudo — lista vazia quer dizer TUDO", async () => {
  const aberta = { ...PAGINA_AVALIACAO, slug: "geral", services: [], professionals: [] };
  const { app } = monta({ paginas: [aberta] });

  const r = await publico(app, "/public/booking", { slug: "geral" });

  assert.equal(r.body.services.length, 2);
  assert.equal(r.body.professionals.length, 2);
});

// ── Os horários ──────────────────────────────────────────────────────────

test("pedir horário de serviço fora da página não devolve nada", async () => {
  // Sem esta checagem, bastaria trocar um id na URL para ver a agenda de um
  // serviço que a página não oferece.
  const { app } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await publico(app, "/public/booking/slots", {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_B),
    from: "2026-09-01",
  });

  assert.deepEqual(r.body.days, []);
});

test("pedir horário de profissional fora da página não devolve nada", async () => {
  const { app } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await publico(app, "/public/booking/slots", {
    slug: "avaliacao",
    professional: String(PRO_B),
    service: String(SERVICO_A),
    from: "2026-09-01",
  });

  assert.deepEqual(r.body.days, []);
});

// ── A marcação: a checagem que de fato protege ───────────────────────────

const marcar = (app, body) => {
  // O teto é por IP e vale 10 por minuto; sem zerar, um caso levaria o outro a
  // 429 e o teste passaria pelo motivo errado.
  rateLimit.reset();

  return call(app, "post", "/public/booking", {
    query: { host: "marlon.gofitnow.fit" },
    body: { name: "Ana", email: "ana@x.com", date: "2026-09-01T10:00:00.000Z", ...body },
  });
};

test("marcar pela página, no que ela oferece, funciona", async () => {
  // Este caso existe porque o teto de chamadas estava lendo `limite.ok`, campo
  // que `check` nunca devolveu: a rota respondia 429 a TODO MUNDO e a agenda
  // pública não marcava nada. Os testes de recusa abaixo passariam felizes.
  const quando = daquiUmaSemana();
  const { app, marcados } = monta({
    paginas: [PAGINA_AVALIACAO],
    semana: gradeAbertaEm(quando),
  });

  const r = await marcar(app, {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_A),
    date: quando.toISOString(),
  });

  assert.notEqual(r.status, 429);
  assert.equal(marcados.length, 1);
});

test("MARCAR serviço fora da página é recusado", async () => {
  // Aqui é onde o horário vira compromisso. Filtrar só a tela seria enfeite.
  const { app, marcados } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await marcar(app, {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_B),
  });

  assert.equal(r.body.erro || r.body.msg, "unavailable");
  assert.equal(marcados.length, 0, "não pode nem chegar ao banco");
});

test("MARCAR com profissional fora da página é recusado", async () => {
  const { app, marcados } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await marcar(app, {
    slug: "avaliacao",
    professional: String(PRO_B),
    service: String(SERVICO_A),
  });

  assert.equal(r.body.erro || r.body.msg, "unavailable");
  assert.equal(marcados.length, 0);
});

// ── O horário da página ──────────────────────────────────────────────────
//
// A página é DONA do calendário dela: a campanha de avaliação só à noite, a
// turma só de manhã. Quem ela escolheu atende no horário dela — a grade por
// profissional saiu da tela, e por isso não manda mais em página nenhuma.
//
// O horário vale nas TRÊS rotas, e é na marcação que ele deixa de ser enfeite.

function paginaComHorario(quando, faixa) {
  return {
    ...PAGINA_AVALIACAO,
    hours: { [DIAS[quando.getDay()]]: [faixa] },
  };
}

test("o horário da página manda, mesmo fora da grade guardada da conta", async () => {
  // A grade da conta vai das 08h às 18h; a página oferece das 18h às 20h. Antes
  // isto não daria horário nenhum — hoje a página é que decide.
  const quando = daquiUmaSemana();
  const { app } = monta({
    paginas: [paginaComHorario(quando, { from: "18:00", to: "20:00" })],
    semana: gradeAbertaEm(quando),
  });

  const r = await publico(app, "/public/booking/slots", {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_A),
    from: quando.toISOString(),
  });

  const horas = (r.body.days[0]?.slots || []).map((s) => new Date(s.start).getHours());
  assert.deepEqual(horas, [18, 18, 19]);
});

test("página com horário próprio nem precisa de grade guardada", async () => {
  // Quem nunca abriu a configuração de agenda não tem documento de grade
  // nenhum. Com a grade fora da tela, exigir um seria exigir algo que ninguém
  // consegue mais criar.
  const quando = daquiUmaSemana();
  const { app } = monta({
    paginas: [paginaComHorario(quando, { from: "10:00", to: "12:00" })],
    semana: gradeAbertaEm(quando),
    semGrade: true,
  });

  const r = await publico(app, "/public/booking/slots", {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_A),
    from: quando.toISOString(),
  });

  assert.equal(r.body.days.length, 1);
});

test("dentro do horário da página, os horários aparecem", async () => {
  const quando = daquiUmaSemana();
  const pagina = {
    ...PAGINA_AVALIACAO,
    hours: { [DIAS[quando.getDay()]]: [{ from: "10:00", to: "12:00" }] },
  };

  const { app } = monta({ paginas: [pagina], semana: gradeAbertaEm(quando) });

  const r = await publico(app, "/public/booking/slots", {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_A),
    from: quando.toISOString(),
  });

  // Passo de 30 min, serviço de 60: 10:00, 10:30 e 11:00 — o de 11:30
  // terminaria depois das 12h, e não cabe.
  const horas = (r.body.days[0]?.slots || []).map((s) => {
    const d = new Date(s.start);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  });

  assert.deepEqual(horas, ["10:00", "10:30", "11:00"]);
});

test("MARCAR fora do horário da página é recusado", async () => {
  // O cliente viu 10h e 11h. Mandar 8h no corpo do pedido — que a grade do
  // profissional aceita — não pode marcar: senão o horário da página seria
  // enfeite, e bastaria trocar a hora no pedido para furá-lo.
  const quando = daquiUmaSemana();
  const pagina = {
    ...PAGINA_AVALIACAO,
    hours: { [DIAS[quando.getDay()]]: [{ from: "10:00", to: "12:00" }] },
  };

  const { app, marcados } = monta({ paginas: [pagina], semana: gradeAbertaEm(quando) });

  const cedo = new Date(quando);
  cedo.setHours(8, 0, 0, 0);

  const r = await marcar(app, {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_A),
    date: cedo.toISOString(),
  });

  assert.equal(r.body.erro || r.body.msg, "taken");
  assert.equal(marcados.length, 0, "não pode nem chegar ao banco");
});

test("marcar no horário da página funciona mesmo fora da grade da conta", async () => {
  // O outro lado da mesma moeda: se a página manda na listagem e não na
  // marcação, o cliente vê um horário que não consegue marcar.
  const quando = daquiUmaSemana();
  const pagina = paginaComHorario(quando, { from: "18:00", to: "20:00" });

  const { app, marcados } = monta({ paginas: [pagina], semana: gradeAbertaEm(quando) });

  const aNoite = new Date(quando);
  aNoite.setHours(18, 0, 0, 0);

  const r = await marcar(app, {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_A),
    date: aNoite.toISOString(),
  });

  assert.notEqual(r.status, 429);
  assert.equal(marcados.length, 1);
});

test("sem horário próprio, a página usa o do profissional", async () => {
  const quando = daquiUmaSemana();
  const { app, marcados } = monta({
    paginas: [PAGINA_AVALIACAO],
    semana: gradeAbertaEm(quando),
  });

  const r = await marcar(app, {
    slug: "avaliacao",
    professional: String(PRO_A),
    service: String(SERVICO_A),
    date: quando.toISOString(),
  });

  assert.notEqual(r.status, 429);
  assert.equal(marcados.length, 1);
});

test("numa página com horário próprio, quem ela escolheu aparece — sem grade ligada", async () => {
  // A lista de quem atende deixa de sair das grades ligadas e passa a sair de
  // quem a página escolheu. Sem isto, um profissional que nunca abriu a
  // configuração de agenda não poderia ser marcado em página nenhuma — e a tela
  // que ligava aquilo já não existe.
  const quando = daquiUmaSemana();
  const pagina = paginaComHorario(quando, { from: "10:00", to: "12:00" });

  const { app } = monta({ paginas: [pagina], semGrade: true });

  const r = await publico(app, "/public/booking", { slug: "avaliacao" });

  assert.deepEqual(r.body.professionals.map((p) => p.name), ["Ana"]);
});

test("página sem escolha de profissional mostra todo mundo que atende", async () => {
  const quando = daquiUmaSemana();
  const pagina = {
    ...paginaComHorario(quando, { from: "10:00", to: "12:00" }),
    professionals: [],
  };

  const { app } = monta({ paginas: [pagina], semGrade: true });

  const r = await publico(app, "/public/booking", { slug: "avaliacao" });

  assert.deepEqual(r.body.professionals.map((p) => p.name), ["Ana", "Bruno"]);
});

test("MARCAR por uma página que não existe é recusado", async () => {
  const { app, marcados } = monta({ paginas: [PAGINA_AVALIACAO] });

  const r = await marcar(app, {
    slug: "inventada",
    professional: String(PRO_A),
    service: String(SERVICO_A),
  });

  assert.equal(r.body.erro || r.body.msg, "unavailable");
  assert.equal(marcados.length, 0);
});
