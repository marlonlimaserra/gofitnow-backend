const { ObjectId } = require("mongodb");

// A FOLHA DE PONTO — um documento por funcionário, por dia.
//
// *"ver folha de ponto"*.
//
// ── O DIA É UMA STRING, "2026-09-19", e não uma Date ────────────────────
//
// Esta é a decisão mais importante do arquivo, e ela é sobre fuso.
//
// Ponto é o dia LOCAL da academia. "Segunda-feira" para quem abriu a porta às
// seis da manhã é segunda-feira, independentemente de o servidor estar em UTC.
// Guardado como `Date`, o dia 19 às 00:00 local vira dia 18 às 21:00 UTC — e a
// folha de setembro passa a começar em 31 de agosto.
//
// Com a string não há conversão para errar: o que a recepção digitou é o que
// está gravado, e a consulta do mês é `{ $gte: "2026-09-01", $lte: "2026-09-30" }`,
// que funciona porque ISO ordena como texto.
//
// As BATIDAS seguem a mesma regra: "08:00" e não um instante. A pergunta que se
// faz na folha é "que horas ele chegou", nunca "em que ponto da linha do tempo
// universal".
//
// ── POR QUE UM DOCUMENTO POR DIA, e não um por batida ───────────────────
//
// Porque o dia é a unidade que se corrige. "Esqueci de bater a saída de ontem"
// é uma edição num documento; com uma batida por documento seria achar duas
// linhas soltas e decidir qual delas é o par da outra.
//
// E porque é assim que a folha é usada numa casa pequena: alguém abre o mês,
// olha a linha do dia 12 e conserta.
function EmployeeTime_model(app) {
  this.app = app;
}

EmployeeTime_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("employee_time");
};

// "2026-09-19", ou nada. Um dia inválido não vira "hoje" por conta própria:
// gravar o ponto no dia errado é pior que recusar.
function dia(v) {
  const t = String(v || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

// "08:00", "8:5" vira "08:05", ">24h" some. Aceitar o que a pessoa digitou e
// normalizar é o que impede "8:00" e "08:00" de virarem dois formatos na mesma
// coluna.
function hora(v) {
  const m = String(v || "").trim().match(/^(\d{1,2}):(\d{1,2})$|^(\d{2})(\d{2})$/);
  if (!m) return "";
  const h = Number(m[1] ?? m[3]);
  const min = Number(m[2] ?? m[4]);
  if (h > 23 || min > 59) return "";
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

function minutosDe(h) {
  if (!h) return null;
  const [a, b] = h.split(":").map(Number);
  return a * 60 + b;
}

// ── O PAR VIRADO ATRAVESSA A MEIA-NOITE ───────────────────────────────────
//
// Entrada 22:00, saída 06:00 é o plantão da madrugada, e não um erro de
// digitação: academia 24h existe, e o vigia noturno também. Oito horas, e não
// menos dezesseis.
function duracao(entrada, saida) {
  const a = minutosDe(entrada);
  const b = minutosDe(saida);
  if (a === null || b === null) return 0;
  return b >= a ? b - a : 24 * 60 - a + b;
}

const MAX_BATIDAS = 6;

function batidas(v) {
  return (Array.isArray(v) ? v : [])
    .map((b) => ({ entrada: hora(b?.entrada), saida: hora(b?.saida) }))
    // A batida sem nenhuma das duas horas é linha vazia do formulário, e não um
    // registro. A que tem só a entrada FICA: é quem está trabalhando agora.
    .filter((b) => b.entrada || b.saida)
    .slice(0, MAX_BATIDAS);
}

// Os minutos do dia — só os pares COMPLETOS. Quem entrou e ainda não saiu conta
// zero, porque contar até "agora" faria o total do mês mudar sozinho a cada
// vez que alguém abrisse a tela.
function totalDe(lista) {
  return lista.reduce((n, b) => n + (b.entrada && b.saida ? duracao(b.entrada, b.saida) : 0), 0);
}

const CAMPOS = {
  dia,
  batidas,
  // Dia sem trabalho, com o motivo escrito na linha do tempo. A folha precisa
  // da linha mesmo assim: um mês com dias faltando parece um mês mal preenchido.
  falta: (v) => v === true,
  // Feriado, folga, compensação — o que faz o dia não contar contra ninguém.
  abonado: (v) => v === true,
  observacao: (v) => String(v || "").trim().slice(0, 240),
};

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);
  saida.minutos = saida.falta ? 0 : totalDe(saida.batidas);
  return saida;
}

// ── GRAVAR O DIA ──────────────────────────────────────────────────────────
//
// Upsert pelo par (funcionário, dia): o índice único é o que impede o mesmo dia
// aparecer duas vezes na folha quando alguém clica em salvar duas vezes.
EmployeeTime_model.prototype.gravar = async function (employee, obj, quem) {
  if (!ObjectId.isValid(employee)) return null;

  const doc = limpar(obj);
  if (!doc.dia) return null;

  const col = await this.collection();
  const chave = { employee: new ObjectId(employee), dia: doc.dia };

  // Dia SEM batida, sem falta e sem observação é um dia que a pessoa limpou.
  // Deixar o documento vazio encheria a collection de linhas que não dizem
  // nada e ainda contariam como "dia registrado" no resumo.
  if (!doc.batidas.length && !doc.falta && !doc.abonado && !doc.observacao) {
    await col.deleteOne(chave);
    return { dia: doc.dia, apagado: true };
  }

  await col.updateOne(
    chave,
    {
      $set: {
        ...doc,
        ...chave,
        lancadoPor: quem?._id ? new ObjectId(String(quem._id)) : null,
        lancadoPorNome: String(quem?.name || "").slice(0, 120),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return { dia: doc.dia, minutos: doc.minutos };
};

EmployeeTime_model.prototype.remover = async function (employee, umDia) {
  if (!ObjectId.isValid(employee) || !dia(umDia)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ employee: new ObjectId(employee), dia: dia(umDia) });
  return r.deletedCount > 0;
};

// ── O ESPELHO DO MÊS ──────────────────────────────────────────────────────
//
// Devolve TODOS os dias do período, inclusive os vazios. É o que faz a tela ser
// uma folha e não uma lista: o dia 7 sem registro precisa aparecer como linha
// em branco, porque é ele que se vai preencher.
EmployeeTime_model.prototype.espelho = async function ({ employee, de, ate, jornadaSemanal } = {}) {
  if (!ObjectId.isValid(employee)) return { dias: [], resumo: {} };

  const inicio = dia(de);
  const fim = dia(ate);
  if (!inicio || !fim || fim < inicio) return { dias: [], resumo: {} };

  const col = await this.collection();
  const gravados = await col
    .find({ employee: new ObjectId(employee), dia: { $gte: inicio, $lte: fim } })
    .sort({ dia: 1 })
    .toArray();

  const porDia = new Map(gravados.map((g) => [g.dia, g]));

  const dias = [];
  for (const d of cadaDia(inicio, fim)) {
    const g = porDia.get(d);
    dias.push({
      dia: d,
      // O dia da semana sai daqui e não da tela: `new Date("2026-09-19")` é
      // meia-noite UTC, e no Brasil isso é o dia 18 — a coluna mostraria o
      // nome do dia anterior a folha inteira.
      semana: diaDaSemana(d),
      batidas: g?.batidas || [],
      minutos: g?.minutos || 0,
      falta: !!g?.falta,
      abonado: !!g?.abonado,
      observacao: g?.observacao || "",
      // Uma batida aberta é alguém que está trabalhando agora — ou que esqueceu
      // de bater a saída. A tela precisa saber para marcar a linha.
      aberto: (g?.batidas || []).some((b) => b.entrada && !b.saida),
    });
  }

  const trabalhados = dias.reduce((n, d) => n + d.minutos, 0);
  const quantosDias = dias.length;

  // ── O PREVISTO É REGRA DE TRÊS, e é por isso que ele é REFERÊNCIA ──────
  //
  // `jornada semanal ÷ 7 × dias do período`. Ele não sabe de feriado, de escala
  // 12x36 nem de domingo — e não pode saber: a escala real mora na cabeça de
  // quem monta o quadro da parede, e inventá-la aqui daria um saldo com cara
  // de oficial que estaria errado.
  //
  // O que este número serve para responder é "estamos perto ou longe?", que é a
  // pergunta que se faz olhando a folha. Fechamento de banco de horas é conta
  // da contabilidade.
  const previsto = jornadaSemanal ? Math.round((jornadaSemanal * 60 * quantosDias) / 7) : 0;

  return {
    dias,
    resumo: {
      minutos: trabalhados,
      previsto,
      saldo: previsto ? trabalhados - previsto : 0,
      diasComRegistro: dias.filter((d) => d.minutos > 0 || d.falta || d.abonado).length,
      faltas: dias.filter((d) => d.falta).length,
      abonados: dias.filter((d) => d.abonado).length,
      abertos: dias.filter((d) => d.aberto).length,
    },
  };
};

// Do primeiro ao último, inclusive. Em UTC de propósito: aqui a data é só um
// contador de dias, e o fuso local faria o laço pular ou repetir um dia na
// virada do horário de verão.
function* cadaDia(de, ate) {
  const d = new Date(de + "T00:00:00Z");
  const fim = new Date(ate + "T00:00:00Z");
  // Teto de segurança: um período de dez anos pedido pela URL não pode virar
  // uma resposta de 3.650 linhas.
  let guarda = 0;
  while (d <= fim && guarda++ < 400) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function diaDaSemana(d) {
  return new Date(d + "T00:00:00Z").getUTCDay();
}

// ── QUEM ESTÁ COM O PONTO ABERTO AGORA ────────────────────────────────────
//
// A pergunta do balcão: "quem está aqui?". Uma batida com entrada e sem saída,
// hoje.
EmployeeTime_model.prototype.abertosNoDia = async function (umDia) {
  const d = dia(umDia);
  if (!d) return [];

  const col = await this.collection();
  return col
    .find({ dia: d, batidas: { $elemMatch: { entrada: { $ne: "" }, saida: "" } } })
    .project({ employee: 1, dia: 1, batidas: 1 })
    .toArray();
};

module.exports = EmployeeTime_model;
module.exports.hora = hora;
module.exports.duracao = duracao;
module.exports.totalDe = totalDe;
module.exports.dia = dia;
