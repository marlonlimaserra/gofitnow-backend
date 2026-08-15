const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const BookingPage_model = require("../../model/BookingPage_model.js");

// As páginas de agendamento.
//
// Antes existia UMA agenda pública: `/g` mostrava todo mundo com grade
// ligada e todo serviço ativo. Uma página é um RECORTE com endereço próprio —
// um apelido na URL, e a escolha do que aparece nela.
const model = new BookingPage_model({});

// ── O apelido que vai para a URL ─────────────────────────────────────────
//
// Ele é público e digitado por gente: vai em cartão, em story, em mensagem de
// WhatsApp. Por isso a régua é apertada.

test("o nome vira apelido sozinho", () => {
  assert.equal(model.apelido("Avaliação Gratuita"), "avaliacao-gratuita");
});

test("acento some — ele se perde no copiar e colar de alguns aplicativos", () => {
  assert.equal(model.apelido("Sessão de avaliação"), "sessao-de-avaliacao");
});

test("barra não passa — partiria a rota em duas", () => {
  assert.equal(model.apelido("personal/online"), "personal-online");
});

test("pontuação e espaço viram hífen, e hífen sobrando é aparado", () => {
  assert.equal(model.apelido("  Turmas!! de   manhã  "), "turmas-de-manha");
});

test("apelido comprido é cortado — endereço não é texto", () => {
  const longo = model.apelido("a".repeat(80));
  assert.equal(longo.length, 40);
});

test("apelido vazio é recusado, não inventado", () => {
  const r = model.conferirApelido("!!!");
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "errors.bookingPageSlugRequired");
});

test("uma letra só não serve", () => {
  assert.equal(model.conferirApelido("a").ok, false);
});

test("apelido reservado é recusado — ele já tem dono no sistema", () => {
  // `/g/novo` conflitaria com a própria tela de criar.
  assert.equal(model.conferirApelido("novo").ok, false);
  assert.equal(model.conferirApelido("admin").motivo, "errors.bookingPageSlugReserved");
});

test("apelido bom volta limpo, pronto para gravar", () => {
  assert.deepEqual(model.conferirApelido("Avaliação Gratuita"), {
    ok: true,
    slug: "avaliacao-gratuita",
  });
});

// ── O recorte ────────────────────────────────────────────────────────────
//
// Lista vazia quer dizer TUDO, não "nada". É o que faz a página nascer
// funcionando: quem cria e não mexe em mais nada tem a agenda de sempre, com
// endereço próprio.

const s1 = new ObjectId();
const s2 = new ObjectId();
const p1 = new ObjectId();
const p2 = new ObjectId();

test("página sem escolha nenhuma oferece tudo", () => {
  const pagina = { services: [], professionals: [] };

  assert.equal(model.ofereceServico(pagina, s1), true);
  assert.equal(model.ofereceProfissional(pagina, p1), true);
});

test("escolhendo serviços, o que ficou de fora não é oferecido", () => {
  const pagina = { services: [s1], professionals: [] };

  assert.equal(model.ofereceServico(pagina, s1), true);
  assert.equal(model.ofereceServico(pagina, s2), false);
});

test("escolhendo profissionais, quem ficou de fora não aparece", () => {
  const pagina = { services: [], professionals: [p2] };

  assert.equal(model.ofereceProfissional(pagina, p2), true);
  assert.equal(model.ofereceProfissional(pagina, p1), false);
});

test("sem página nenhuma, tudo é oferecido — é a agenda de sempre", () => {
  // `/g` sem apelido continua funcionando para quem nunca criou página.
  assert.equal(model.ofereceServico(null, s1), true);
  assert.equal(model.ofereceProfissional(null, p1), true);
});

// ── O que é gravado ──────────────────────────────────────────────────────

function fakeModel({ existente = null } = {}) {
  const gravados = [];
  const m = new BookingPage_model({});

  m.collection = async () => ({
    async insertOne(doc) {
      gravados.push(doc);
      return { insertedId: new ObjectId() };
    },
    async updateOne(filtro, mudanca) {
      gravados.push(mudanca.$set);
      return { matchedCount: 1 };
    },
    async findOne() {
      return existente;
    },
  });

  return { model: m, gravados };
}

test("id inválido na lista de serviços é descartado, não grava lixo", async () => {
  const { model: m, gravados } = fakeModel();

  await m.insert({ name: "Avaliação", slug: "aval", services: [String(s1), "não-é-id"] }, null);

  assert.equal(gravados[0].services.length, 1);
  assert.equal(String(gravados[0].services[0]), String(s1));
});

test("a página nasce ATIVA — criar e não aparecer seria armadilha", async () => {
  const { model: m, gravados } = fakeModel();

  await m.insert({ name: "Avaliação", slug: "aval" }, null);

  assert.equal(gravados[0].active, 1);
});

test("o apelido não muda quando não é mandado — o endereço já está divulgado", async () => {
  const { model: m, gravados } = fakeModel();

  await m.update(new ObjectId(), { name: "Outro nome" });

  assert.equal(gravados[0].slug, undefined);
  assert.equal(gravados[0].name, "Outro nome");
});

test("mandando o apelido, ele é limpo antes de gravar", async () => {
  const { model: m, gravados } = fakeModel();

  await m.update(new ObjectId(), { name: "x", slug: "Avaliação Gratuita" });

  assert.equal(gravados[0].slug, "avaliacao-gratuita");
});

// ── O horário próprio ────────────────────────────────────────────────────
//
// Mesma forma da grade do profissional, de propósito: é a mesma coisa dita por
// outra boca, e a rota pública cruza as duas. Vazio significa HERDAR o horário
// de cada um — e é o padrão.

test("o horário é gravado no formato da grade", async () => {
  const { model: m, gravados } = fakeModel();

  await m.insert(
    { name: "Avaliação", slug: "aval", hours: { tue: [{ from: "18:00", to: "20:00" }] } },
    null
  );

  assert.deepEqual(gravados[0].hours, { tue: [{ from: "18:00", to: "20:00" }] });
});

test("sem horário, o campo nasce vazio — a página herda o de quem atende", async () => {
  const { model: m, gravados } = fakeModel();

  await m.insert({ name: "Avaliação", slug: "aval" }, null);

  assert.deepEqual(gravados[0].hours, {});
});

test("hora impossível é descartada, não corrigida", async () => {
  // "25:00" virando 01:00 abriria a agenda de madrugada sem ninguém pedir.
  const { model: m, gravados } = fakeModel();

  await m.insert(
    {
      name: "x",
      slug: "x1",
      hours: { tue: [{ from: "25:00", to: "26:00" }, { from: "18:00", to: "20:00" }] },
    },
    null
  );

  assert.deepEqual(gravados[0].hours, { tue: [{ from: "18:00", to: "20:00" }] });
});

test("faixa invertida é descartada", async () => {
  const { model: m, gravados } = fakeModel();

  await m.insert({ name: "x", slug: "x1", hours: { tue: [{ from: "20:00", to: "18:00" }] } }, null);

  assert.deepEqual(gravados[0].hours, {});
});

test("chave que não é dia da semana não entra", async () => {
  const { model: m, gravados } = fakeModel();

  await m.insert(
    { name: "x", slug: "x1", hours: { segunda: [{ from: "08:00", to: "09:00" }] } },
    null
  );

  assert.deepEqual(gravados[0].hours, {});
});

test("um dia não vira uma lista sem fim de faixas", async () => {
  const { model: m, gravados } = fakeModel();
  const muitas = Array.from({ length: 40 }, () => ({ from: "08:00", to: "09:00" }));

  await m.insert({ name: "x", slug: "x1", hours: { tue: muitas } }, null);

  assert.equal(gravados[0].hours.tue.length, 6);
});

test("apelido ocupado por OUTRA página não está livre", async () => {
  const outra = { _id: new ObjectId(), slug: "aval" };
  const { model: m } = fakeModel({ existente: outra });

  assert.equal(await m.slugLivre("aval"), false);
  // O da própria página não conta como ocupado — senão não dava para salvar
  // uma página sem trocar o endereço dela.
  assert.equal(await m.slugLivre("aval", outra._id), true);
});

test("página PAUSADA responde como página que não existe", async () => {
  // `bySlug` filtra por `active: 1`. Sem isso, pausar não pausaria nada.
  const { model: m } = fakeModel({ existente: null });

  assert.equal(await m.bySlug("aval"), undefined);
});
