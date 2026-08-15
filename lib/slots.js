// Os horários livres de um profissional.
//
// Esta é a peça central da agenda pública, e está fora do modelo de propósito:
// é conta pura, sem banco, e é a única parte do módulo em que um erro não
// aparece na tela — aparece como duas pessoas no mesmo horário, ou como um
// horário livre que o cliente não consegue marcar.
//
// Tudo aqui trabalha com INSTANTES (Date). A disponibilidade é escrita em
// "07:00" porque é assim que se pensa uma agenda semanal, mas ela vira instante
// antes de qualquer comparação: texto não se ordena por tempo e não se compara
// com "agora".

const DIAS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// "07:30" → 450 minutos desde a meia-noite. Devolve `null` para o que não for
// hora — um campo digitado errado não pode virar meia-noite silenciosamente.
function minutos(texto) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(texto || "").trim());
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;

  return h * 60 + min;
}

function comMinutos(dia, desdeMeiaNoite) {
  const d = new Date(dia);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(desdeMeiaNoite);
  return d;
}

// As janelas de um dia da semana, em minutos, já limpas.
function janelas(brutas) {
  return (Array.isArray(brutas) ? brutas : [])
    .map((j) => ({ de: minutos(j.from), ate: minutos(j.to) }))
    // Janela invertida ou incompleta é engano de cadastro, não uma janela de
    // duração negativa: descartar é melhor que gerar horários impossíveis.
    .filter((j) => j.de !== null && j.ate !== null && j.ate > j.de);
}

// As janelas de atendimento de um DIA, lidas da grade semanal.
function janelasDoDia(semana, dia) {
  const chave = DIAS[new Date(dia).getDay()];
  return janelas(semana?.[chave]);
}

// A grade tem ALGUM horário?
//
// É como a rota pública decide de quem é o calendário: página com horário manda
// nela; página sem horário cai na grade da conta. Perguntar isso sem varrer os
// sete dias na mão, e sem contar como horário uma faixa impossível.
function temHorario(semana) {
  return DIAS.some((d) => janelas(semana?.[d]).length > 0);
}

// Os horários que a grade OFERECE num dia, antes de descontar o que está
// ocupado.
//
// O passo é de quando em quando um horário começa (de 30 em 30, por exemplo); a
// duração é do serviço. O horário só entra se couber INTEIRO na janela — um
// treino de 60 min às 11h30 numa janela que fecha às 12h terminaria depois do
// expediente.
function horariosDoDia({ dia, semana, passo = 30, duracao = 60 }) {
  const saida = [];

  for (const janela of janelasDoDia(semana, dia)) {
    for (let m = janela.de; m + duracao <= janela.ate; m += passo) {
      saida.push(comMinutos(dia, m));
    }
  }

  return saida;
}

// Um instante cai dentro de algum bloqueio?
//
// Bloqueio é a exceção da semana: férias, feriado, uma tarde de congresso. Ele
// vence a grade — quem bloqueou a tarde não quer explicar por que ela continua
// aparecendo.
function bloqueado(inicio, fim, bloqueios) {
  return (bloqueios || []).some((b) => {
    const de = new Date(b.from);
    const ate = new Date(b.to);
    if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) return false;

    // Dois intervalos se cruzam quando cada um começa antes de o outro terminar.
    return de < fim && ate > inicio;
  });
}

// Quantas vagas AINDA existem num horário.
//
// A regra tem duas partes, e a segunda é a que costuma ser esquecida:
//
//   1. o profissional só está livre se não houver OUTRO atendimento cruzando —
//      uma consulta às 10h30 impede um treino às 10h, mesmo que a turma das 10h
//      tenha vaga;
//   2. dentro do mesmo serviço e do mesmo horário, cabem tantos quanto a
//      capacidade — é o que faz aula de grupo existir.
//
// `canceled` não ocupa: foi desmarcado justamente para liberar o horário.
function vagasEm({ inicio, duracao, compromissos, serviceId, capacidade = 1 }) {
  const fim = new Date(inicio.getTime() + duracao * 60000);

  let mesmaTurma = 0;

  for (const c of compromissos || []) {
    if (c.status === "canceled") continue;

    const cInicio = new Date(c.date);
    const cFim = new Date(cInicio.getTime() + (c.minutes || 60) * 60000);
    if (!(cInicio < fim && cFim > inicio)) continue;

    const mesmoServico = serviceId && String(c.service || "") === String(serviceId);
    const mesmoComeco = cInicio.getTime() === inicio.getTime();

    // Qualquer coisa que cruze e NÃO seja a mesma turma ocupa o profissional
    // por inteiro.
    if (!mesmoServico || !mesmoComeco) return 0;

    mesmaTurma += 1;
  }

  return Math.max(0, capacidade - mesmaTurma);
}

// Os horários que o cliente pode escolher, de um dia.
//
// `agora` e os limites entram como argumento em vez de serem lidos do relógio
// aqui: é o que torna esta função testável sem congelar o tempo, e o que
// permite ao servidor usar o mesmo instante para o dia inteiro.
function livresDoDia({
  dia,
  semana,
  passo,
  duracao,
  compromissos,
  bloqueios,
  serviceId,
  capacidade = 1,
  agora = new Date(),
  antecedenciaHoras = 0,
  horizonteDias = 60,
}) {
  const minimo = new Date(agora.getTime() + antecedenciaHoras * 3600000);
  const maximo = new Date(agora.getTime() + horizonteDias * 86400000);

  return horariosDoDia({ dia, semana, passo, duracao })
    .filter((inicio) => {
      // Antecedência mínima: ninguém quer receber uma marcação para daqui a dez
      // minutos e descobrir depois de a pessoa chegar.
      if (inicio < minimo) return false;
      if (inicio > maximo) return false;

      const fim = new Date(inicio.getTime() + duracao * 60000);
      if (bloqueado(inicio, fim, bloqueios)) return false;

      return true;
    })
    .map((inicio) => ({
      start: inicio,
      seats: vagasEm({ inicio, duracao, compromissos, serviceId, capacidade }),
    }))
    .filter((h) => h.seats > 0);
}

module.exports = {
  DIAS,
  minutos,
  temHorario,
  janelasDoDia,
  horariosDoDia,
  bloqueado,
  vagasEm,
  livresDoDia,
};
