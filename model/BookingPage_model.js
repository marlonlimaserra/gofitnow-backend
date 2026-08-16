const { ObjectId } = require("mongodb");

// A collection `booking_pages` — as páginas de agendamento.
//
// Antes existia UMA agenda pública por cliente: `/g` mostrava todo mundo
// com grade ligada e todo serviço ativo. Serve para quem tem uma oferta só, e
// atrapalha em tudo o mais: a campanha de avaliação gratuita não quer mostrar o
// pacote fechado, a turma de manhã não quer aparecer para quem veio pelo
// anúncio do personal, e o link mandado no story não deveria abrir um cardápio
// inteiro.
//
// Uma página é um RECORTE com endereço próprio: um apelido na URL
// (`/g/avaliacao`), um nome, e a escolha de quais serviços e quais
// profissionais aparecem nela. Nada aqui cria horário — quem define quando cada
// um atende continua sendo a grade de disponibilidade dele. A página só decide
// o que é OFERECIDO.
//
// Lista vazia quer dizer TUDO, não "nada". É a escolha que faz a página nascer
// funcionando: quem cria e não mexe em mais nada tem a agenda de sempre, com
// endereço próprio.
function BookingPage_model(app) {
  this.app = app;
}

BookingPage_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("booking_pages");
};

// O apelido que vai para a URL.
//
// Ele é público e é digitado por gente — vai em cartão, em story, em mensagem
// de WhatsApp. Por isso a régua é apertada: minúsculas, números e hífen. Sem
// acento (some no copiar e colar de alguns aplicativos), sem barra (partiria a
// rota), sem espaço.
//
// "Avaliação Gratuita!" vira "avaliacao-gratuita".
const RESERVADOS = ["novo", "nova", "admin", "api", "config", "configuracao"];

function apelido(bruto) {
  const limpo = String(bruto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return limpo;
}

// O apelido serve? Devolve o motivo quando não.
//
// Recusar é melhor que corrigir em silêncio: quem escreveu "Avaliação" espera
// ver o que vai virar antes de sair divulgando.
function conferirApelido(bruto) {
  const slug = apelido(bruto);

  if (!slug) return { ok: false, motivo: "errors.bookingPageSlugRequired" };
  if (slug.length < 2) return { ok: false, motivo: "errors.bookingPageSlugShort" };
  if (RESERVADOS.includes(slug)) return { ok: false, motivo: "errors.bookingPageSlugReserved" };

  return { ok: true, slug };
}

// O horário da página: quando ela atende.
//
// Forma de grade semanal — `{ mon: [{from, to}] }` — a mesma que a conta do
// profissional usa, porque é a mesma ideia. A diferença é quem manda: quem a
// página escolheu atende no horário DELA, e a grade por profissional saiu da
// tela.
//
// Vazio só acontece em página criada antes disto existir; nesse caso a rota
// pública cai na grade guardada da conta, que é como o `/g` sem apelido
// funciona até hoje.
const DIAS_DA_SEMANA = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Quantas faixas por dia. "manhã, tarde e noite" são três; um dia com dezenas
// de faixas é engano de tela ou pedido forjado, não uma agenda.
const MAX_FAIXAS = 6;

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

function horarioLimpo(bruto) {
  const saida = {};
  if (!bruto || typeof bruto !== "object") return saida;

  for (const dia of DIAS_DA_SEMANA) {
    const faixas = Array.isArray(bruto[dia]) ? bruto[dia] : [];

    const boas = faixas
      .map((f) => ({ from: String(f?.from || "").trim(), to: String(f?.to || "").trim() }))
      // Faixa incompleta, com hora impossível ou invertida é engano de
      // cadastro. Descartar é melhor que gravar um horário que nunca abre e
      // deixar alguém procurando o motivo na tela pública.
      .filter((f) => HORA.test(f.from) && HORA.test(f.to) && f.to > f.from)
      .slice(0, MAX_FAIXAS);

    if (boas.length) saida[dia] = boas;
  }

  return saida;
}

function inteiroOuPadrao(valor, padrao, { min, max }) {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) && n >= min && n <= max ? n : padrao;
}

function idsValidos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
}

function limpar(obj) {
  return {
    name: String(obj.name || "").trim().slice(0, 120),
    // O texto que abre a página. Serve para dizer "escolha o melhor horário
    // para sua avaliação" sem precisar de uma tela de edição de conteúdo.
    intro: String(obj.intro || "").trim().slice(0, 500),
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,

    // Mostrar a FOTO e a APRESENTAÇÃO de quem atende.
    //
    // Desligado por padrão, e não por timidez: a página é aberta a qualquer um
    // com o link, e publicar o rosto de alguém é decisão de quem publica, não
    // um efeito colateral de criar uma página. Numa página de campanha, onde a
    // pessoa escolhe entre três profissionais, ver a cara e ler duas linhas
    // sobre cada um é o que faz escolher — numa página de um serviço só, é
    // ruído.
    showProfessional: obj.showProfessional === true || Number(obj.showProfessional) === 1,
    services: idsValidos(obj.services),
    professionals: idsValidos(obj.professionals),
    hours: horarioLimpo(obj.hours),

    // O ritmo desta página. Saiu da conta do profissional e veio para cá junto
    // com o horário: quem é dono do calendário é dono do calendário inteiro.
    //
    // De quantos em quantos minutos um horário começa.
    slotStep: inteiroOuPadrao(obj.slotStep, 30, { min: 5, max: 240 }),

    // Antecedência mínima: ninguém quer receber marcação para daqui a dez
    // minutos e descobrir depois de a pessoa chegar.
    minNoticeHours: inteiroOuPadrao(obj.minNoticeHours, 12, { min: 0, max: 720 }),

    // Até quando dá para marcar. Sem teto, um cliente marcaria para o ano que
    // vem e o profissional só descobriria em dezembro.
    horizonDays: inteiroOuPadrao(obj.horizonDays, 30, { min: 1, max: 365 }),
  };
}

BookingPage_model.prototype.list = async function () {
  const col = await this.collection();
  return await col.find({}).sort({ name: 1 }).toArray();
};

BookingPage_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// A página que atende por um apelido. É por aqui que a rota pública entra.
//
// Só as ATIVAS: uma página pausada tem de responder como página que não existe,
// senão pausar não pausaria nada.
BookingPage_model.prototype.bySlug = async function (slug) {
  const limpo = apelido(slug);
  if (!limpo) return undefined;

  const col = await this.collection();
  const doc = await col.findOne({ slug: limpo, active: 1 });
  return doc || undefined;
};

// Este apelido já é de outra página? O índice único é quem garante — esta
// checagem existe para a MENSAGEM ser boa, não para a garantia.
BookingPage_model.prototype.slugLivre = async function (slug, exceto) {
  const col = await this.collection();
  const doc = await col.findOne({ slug: apelido(slug) });

  if (!doc) return true;
  return Boolean(exceto) && String(doc._id) === String(exceto);
};

BookingPage_model.prototype.insert = async function (obj, criadoPor) {
  const col = await this.collection();

  const r = await col.insertOne({
    slug: apelido(obj.slug),
    ...limpar(obj),
    createdBy: criadoPor ? new ObjectId(criadoPor) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

BookingPage_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { ...limpar(obj), updatedAt: new Date() };
  // O apelido só muda quando é mandado: um PUT parcial não pode zerar o
  // endereço que já está divulgado por aí.
  if (obj.slug !== undefined) set.slug = apelido(obj.slug);

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
  return r.matchedCount > 0;
};

BookingPage_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

// ── O recorte ─────────────────────────────────────────────────────────────
//
// As duas perguntas que a rota pública faz a uma página, e que precisam da
// MESMA resposta na listagem e na hora de marcar. Se a listagem filtrar e a
// marcação não conferir, o filtro é enfeite: basta trocar um id no pedido para
// marcar um serviço que a página não oferece.

BookingPage_model.prototype.ofereceServico = function (pagina, servicoId) {
  if (!pagina || !pagina.services?.length) return true;
  return pagina.services.some((s) => String(s) === String(servicoId));
};

BookingPage_model.prototype.ofereceProfissional = function (pagina, profissionalId) {
  if (!pagina || !pagina.professionals?.length) return true;
  return pagina.professionals.some((p) => String(p) === String(profissionalId));
};

BookingPage_model.prototype.apelido = apelido;
BookingPage_model.prototype.conferirApelido = conferirApelido;

module.exports = BookingPage_model;
