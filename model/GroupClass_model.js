const { ObjectId } = require("mongodb");
const tempo = require("../lib/tempo.js");

// AS AULAS COLETIVAS — a grade que se repete toda semana.
//
// Pedido do Marlon em 18/09/2026: *"crie aqui em configuração 'Aula coletiva',
// vai ser parecido com o aulões, a diferença é que vai resetar todo o dia,
// coloque para configurar horário mínimo para check-in etc, e em qual unidade
// aquela aula vai estar disponível"*.
//
// ── A DIFERENÇA PARA O AULÃO É O TEMPO, e ela arrasta tudo ──────────────
//
// O aulão é um EVENTO: "27/09 às 08:00, Parque Ibirapuera, 30 vagas". Tem
// data, acaba, e a lista de inscritos fecha. Por isso ele guarda `startsAt`
// como INSTANTE, tem foto, endereço próprio e preço.
//
// A aula coletiva é uma GRADE: "Spinning, seg/qua/sex às 07:00". Ela não
// acaba, não tem data, e a lista dela zera à meia-noite.
//
// ── E POR ISSO A HORA AQUI É RELÓGIO DE PAREDE, e não um instante ──────
//
// Minutos desde a meia-noite, no fuso da conta. Um instante seria a modelagem
// errada: 07:00 de segunda é 07:00 também no domingo de horário de verão, e
// guardar um instante faria a aula andar uma hora sozinha duas vezes por ano —
// a academia não muda a grade porque o relógio mudou.
//
// É a mesma escolha da agenda semanal (`lib/slots.js`).
//
// ── VÁRIOS HORÁRIOS, com INÍCIO e FIM ──────────────────────────────────
//
// *"permita escolher os horários manualmente início e fim, aí posso ir
// adicionando vários"*.
//
// A primeira versão tinha um horário e uma DURAÇÃO. Duas coisas erradas nela,
// e ele apontou as duas numa frase:
//
//   1. UMA aula acontece várias vezes por dia. Spinning às 07:00 e às 18:00 é
//      a mesma aula, e obrigar a cadastrar duas daria dois nomes, duas
//      descrições e duas salas para manter iguais.
//   2. DURAÇÃO é uma conta que a pessoa faz de cabeça para saber a que horas
//      acaba. Quem monta grade pensa "das 7 às 7h50", não "50 minutos".
//
// Os DIAS continuam da aula, e não de cada horário: "Spinning, seg/qua/sex,
// 07:00 e 18:00" é uma linha de grade. Quem tiver horário diferente por dia
// cadastra outra aula — que é como a grade se lê na parede também.
//
// ── "RESETAR TODO O DIA" É NÃO GUARDAR NADA AQUI ───────────────────────
//
// Esta collection guarda a AULA, que é permanente. Quem entrou na aula de hoje
// mora em `group_class_checkins`, uma linha por (aula, dia, pessoa).
//
// O reset não é uma rotina que roda à meia-noite — é consequência da chave. A
// aula de amanhã nasce vazia porque ninguém escreveu a linha de amanhã ainda.
// Uma rotina que apaga seria uma coisa a mais para falhar, e no dia em que
// falhasse a aula apareceria cheia de gente do dia anterior.
function GroupClass_model(app) {
  this.app = app;
}

GroupClass_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("group_classes");
};

const MINUTOS_NO_DIA = 24 * 60;

// "07:00" → 420. O que não for hora vira `null`, e sem hora não há aula.
function minutosDaHora(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;

  return h * 60 + min;
}

function horaDeMinutos(n) {
  const h = Math.floor(n / 60);
  return `${String(h).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

function inteiro(v, padrao, { min, max }) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(n, min), max);
}

// ── OS HORÁRIOS: uma lista de { inicio, fim } em minutos ────────────────
//
// Ordenados pelo início, porque uma grade fora de ordem de relógio não é uma
// grade. Duplicados saem: dois "07:00 às 07:50" na mesma aula seriam duas
// linhas idênticas que ninguém consegue distinguir para apagar.
//
// O que não tem início e fim válidos não entra — e um fim ANTES do início
// também não: ele viraria uma janela negativa, e a aula nunca estaria aberta.
const MAX_HORARIOS = 24;

function horarios(v) {
  if (!Array.isArray(v)) return [];

  const vistos = new Set();
  const saida = [];

  for (const x of v) {
    const inicio = minutosDe(x?.inicio);
    const fim = minutosDe(x?.fim);
    if (inicio === null || fim === null || fim <= inicio) continue;

    const chave = `${inicio}-${fim}`;
    if (vistos.has(chave)) continue;

    vistos.add(chave);
    saida.push({ inicio, fim });
    if (saida.length >= MAX_HORARIOS) break;
  }

  return saida.sort((a, b) => a.inicio - b.inicio);
}

// Aceita "07:30" e 450: a tela manda relógio, e uma chamada de API pode mandar
// minutos. Converter nos dois sentidos num lugar só é o que impede a terceira
// tela de converter errado.
function minutosDe(v) {
  if (typeof v === "number") {
    const n = Math.round(v);
    return Number.isFinite(n) && n >= 0 && n < MINUTOS_NO_DIA ? n : null;
  }
  return minutosDaHora(v);
}

// Os dias da semana, 0 (domingo) a 6. Sem dia não há grade — e uma aula sem
// dia nenhum nunca aconteceria, então ela é recusada na gravação.
function dias(v) {
  if (!Array.isArray(v)) return [];

  const vistos = new Set();
  for (const x of v) {
    const n = Number(x);
    if (Number.isInteger(n) && n >= 0 && n <= 6) vistos.add(n);
  }

  return [...vistos].sort((a, b) => a - b);
}

// As unidades em que a aula acontece. Vazio quer dizer TODAS, como no plano e
// no usuário — é a leitura que não estraga nada.
function unidades(v) {
  if (!Array.isArray(v)) return [];

  const vistas = new Set();
  const saida = [];

  for (const x of v) {
    const id = String(x || "");
    if (!ObjectId.isValid(id) || vistas.has(id)) continue;
    vistas.add(id);
    saida.push(new ObjectId(id));
    if (saida.length >= 50) break;
  }

  return saida;
}

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 140),
  description: (v) => String(v || "").trim().slice(0, 600),
  // Onde ela acontece DENTRO da unidade: "Sala 2", "Piscina". Não é endereço —
  // o endereço é da unidade, e repeti-lo aqui criaria dois que divergem.
  sala: (v) => String(v || "").trim().slice(0, 80),
  dias,
  units: unidades,
  horarios,

  // ── AS VAGAS ─────────────────────────────────────────────────────────────
  //
  // Zero é SEM LIMITE, como no aulão. Numa aula ao ar livre "quantas vagas?"
  // nem sempre tem resposta, e um `null` seria um terceiro estado para a mesma
  // coisa.
  seats: (v) => inteiro(v, 0, { min: 0, max: 100000 }),

  // ── A JANELA DE CHECK-IN ─────────────────────────────────────────────────
  //
  // *"coloque para configurar horário mínimo para check-in"*.
  //
  // Dois números, e os dois são MINUTOS RELATIVOS ao início da aula — nunca um
  // horário absoluto. "Abre 30 minutos antes" continua valendo quando a aula
  // muda de 07:00 para 08:00; "abre às 06:30" vira uma janela errada calada.
  //
  // `checkinAbre` é o "mínimo" que ele pediu: quanto antes a pessoa já pode
  // confirmar. `checkinFecha` é o atraso tolerado — depois dele a aula começou
  // e quem chegou não é mais presença, é visita.
  checkinAbre: (v) => inteiro(v, 30, { min: 0, max: MINUTOS_NO_DIA }),
  checkinFecha: (v) => inteiro(v, 15, { min: 0, max: MINUTOS_NO_DIA }),

  active: (v) => v !== false,
};

GroupClass_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}).sort({ order: 1, createdAt: 1 }).toArray();
};

GroupClass_model.prototype.listActive = async function () {
  const col = await this.collection();
  return col.find({ active: true }).sort({ order: 1, createdAt: 1 }).toArray();
};

GroupClass_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

GroupClass_model.prototype.insert = async function (obj) {
  const col = await this.collection();
  const doc = { order: await col.countDocuments({}), createdAt: new Date(), updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS)) doc[campo] = limpar(obj[campo]);

  // Sem nome, sem horário ou sem dia não existe aula: ela nunca aconteceria, e
  // uma linha assim na grade é só confusão.
  if (!doc.name || !doc.horarios.length || !doc.dias.length) return null;

  const r = await col.insertOne(doc);
  return r.insertedId;
};

// Mescla, como em todo o resto desta casa: o que a chamada não menciona, ela
// não toca.
GroupClass_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }

  // Uma edição não pode deixar a aula sem horário nem sem dia — seria apagá-la
  // pela metade, e ela continuaria na lista sem nunca acontecer.
  if (mudanca.horarios && !mudanca.horarios.length) return false;
  if (mudanca.dias && !mudanca.dias.length) return false;

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  return r.matchedCount > 0;
};

GroupClass_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

GroupClass_model.prototype.reorder = async function (ids) {
  if (!Array.isArray(ids)) return false;
  const col = await this.collection();

  const validos = ids.filter((id) => ObjectId.isValid(id));
  if (validos.length !== ids.length) return false;

  await Promise.all(
    validos.map((id, i) => col.updateOne({ _id: new ObjectId(id) }, { $set: { order: i } }))
  );

  return true;
};

// ── A AULA DE HOJE ────────────────────────────────────────────────────────
//
// O estado que a tela de check-in precisa: a aula acontece hoje? a janela está
// aberta? quanto falta?
//
// Calculado a partir do RELÓGIO DA CONTA, e não do servidor. Sem isso, uma
// academia em Manaus veria a janela abrir uma hora adiantada — e o defeito
// apareceria só para ela, o que é o pior tipo.
GroupClass_model.prototype.estadoAgora = function (aula, agora, fuso) {
  const parede = tempo.paredeDe(agora || new Date(), fuso);
  const hoje = aula.dias?.includes(parede.diaDaSemana);
  if (!hoje) return { hoje: false, aberta: false, data: parede.data, horarios: [] };

  const minutosAgora = parede.hora * 60 + parede.minuto;

  // CADA horário tem a sua janela. A aula das 07:00 e das 18:00 é a mesma
  // aula, mas às 07:10 só a primeira está aberta — e é ela que a tela precisa
  // nomear, senão "Spinning, aberta" às 18h confirmaria presença na aula da
  // manhã.
  const janelas = (aula.horarios || []).map((h) => {
    const abre = h.inicio - (aula.checkinAbre ?? 0);
    const fecha = h.inicio + (aula.checkinFecha ?? 0);

    return {
      inicio: horaDeMinutos(h.inicio),
      fim: horaDeMinutos(h.fim),
      // A JANELA não atravessa a meia-noite de propósito: uma aula às 00:30
      // com 60 minutos de antecedência abriria "ontem às 23:30", e o dia da
      // lista passaria a ser outro.
      aberta: minutosAgora >= abre && minutosAgora <= fecha,
      abreEm: horaDeMinutos(Math.max(abre, 0)),
      fechaEm: horaDeMinutos(Math.min(fecha, MINUTOS_NO_DIA - 1)),
    };
  });

  return {
    hoje: true,
    // A aula está aberta se ALGUM horário dela está.
    aberta: janelas.some((j) => j.aberta),
    horarios: janelas,
    data: parede.data,
  };
};

module.exports = GroupClass_model;
module.exports.minutosDaHora = minutosDaHora;
module.exports.horaDeMinutos = horaDeMinutos;
