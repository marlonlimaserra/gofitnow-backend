// A hora do RELÓGIO de quem atende, e o instante que o banco guarda.
//
// São duas coisas, e confundi-las é o defeito que trouxe este arquivo:
//
//   • "08:00" na grade da semana é hora de PAREDE — o relógio do estúdio;
//   • o que fica gravado num compromisso é um INSTANTE, o mesmo em qualquer
//     lugar do mundo.
//
// O código antigo transformava um no outro com `d.setHours(0,0,0,0)`, que usa o
// fuso do PROCESSO. O servidor roda em UTC, então "08:00" virava 08:00Z — e o
// navegador, em Brasília, desenhava 05:00. Três horas somem entre digitar e
// olhar, sem ninguém tocar em nada.
//
// O servidor continua em UTC de propósito: assim ele pode ser movido de máquina
// sem reescrever a agenda de ninguém. Quem diz que horas são "08:00" é o FUSO DA
// CONTA, configurado no sistema.
//
// Sem biblioteca: o `Intl` do próprio Node sabe todos os fusos e o histórico de
// horário de verão. O que falta nele é o caminho inverso — de hora de parede
// para instante —, e é ele que está escrito aqui.

// O fuso padrão de uma conta que nunca escolheu.
const PADRAO = "America/Sao_Paulo";

// Um nome de fuso serve? Quem responde é o próprio Intl: ele conhece a lista
// inteira do IANA, e ela muda com o tempo — manter uma cópia aqui seria manter
// uma cópia desatualizada.
function valido(fuso) {
  if (!fuso || typeof fuso !== "string") return false;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: fuso });
    return true;
  } catch (error) {
    return false;
  }
}

function normalizar(fuso) {
  return valido(fuso) ? fuso : PADRAO;
}

// Quantos milissegundos o fuso está à frente do UTC NAQUELE instante.
//
// "Naquele instante" é a parte que importa: o mesmo fuso vale -3h em janeiro e
// -2h em novembro onde há horário de verão. Um número fixo por fuso erraria meio
// ano inteiro.
function deslocamento(fuso, instante) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instante);

  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));

  // `hour` volta como "24" à meia-noite em algumas versões do ICU.
  const comoSeFosseUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );

  return comoSeFosseUTC - instante.getTime();
}

// A hora de PAREDE de um fuso, virando instante.
//
// Duas passadas, e a segunda não é preciosismo: o deslocamento depende do
// instante, e o instante é o que se está calculando. A primeira passada chuta
// com o deslocamento do momento errado; a segunda corrige usando o momento quase
// certo. É o que faz a hora seguinte à virada do horário de verão cair no lugar.
function instante({ ano, mes, dia, hora = 0, minuto = 0 }, fuso) {
  const zona = normalizar(fuso);
  const chute = Date.UTC(ano, mes - 1, dia, hora, minuto);

  const primeiro = deslocamento(zona, new Date(chute));
  const segundo = deslocamento(zona, new Date(chute - primeiro));

  return new Date(chute - segundo);
}

// O dia e a hora de parede de um instante, no fuso da conta.
//
// É o inverso de `instante`, e serve para responder "que dia da semana é isto
// para quem atende?" — pergunta que a grade semanal faz o tempo todo, e que o
// `getDay()` do processo responde errado quando o servidor está em outro fuso.
function paredeDe(quando, fuso) {
  const zona = normalizar(fuso);
  const d = quando instanceof Date ? quando : new Date(quando);

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: zona,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);

  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour) % 24,
    minuto: Number(p.minute),
    diaDaSemana: DIAS[p.weekday],
    // "AAAA-MM-DD" no fuso da conta: é a chave que a tela usa para agrupar por
    // dia, e ela não pode sair de `toISOString()` — lá o dia vira o de UTC.
    data: `${p.year}-${p.month}-${p.day}`,
  };
}

// A meia-noite de um dia, no fuso da conta, mais tantos minutos.
//
// É o que a grade semanal precisa: "a janela abre aos 480 minutos de
// segunda-feira" tem de virar 08:00 do relógio de quem atende, não do relógio
// do servidor.
function comMinutos(dia, minutosDesdeMeiaNoite, fuso) {
  const parede = paredeDe(dia, fuso);

  return instante(
    { ano: parede.ano, mes: parede.mes, dia: parede.dia, hora: 0, minuto: minutosDesdeMeiaNoite },
    fuso
  );
}

module.exports = { PADRAO, valido, normalizar, deslocamento, instante, paredeDe, comMinutos };
