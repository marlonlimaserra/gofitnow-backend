const test = require("node:test");
const assert = require("node:assert/strict");

const slots = require("../../lib/slots.js");

// ── O INTERVALO ENTRE ATENDIMENTOS (16/09/2026) ───────────────────────────
//
// "a duração seria 45 minutos, com intervalo de 15 minutos; esse intervalo é
// para mim, e não para o cliente."
//
// O mecanismo já existia dividido em dois: a DURAÇÃO é do serviço e a PASSADA é
// da página. O que faltava era o nome — com passada fixa, o respiro entre
// atendimentos é implícito e sai DIFERENTE por serviço.
//
// Estes casos exercitam `lib/slots.js` direto, que é onde a conta mora. O
// controller só decide qual passada entregar (`duração + intervalo`), e é o
// resultado dessa soma que se prova aqui.
const SEMANA = { thu: [{ from: "08:00", to: "12:00" }] };
const QUINTA = new Date("2026-09-17T12:00:00Z");

function horarios({ passo, duracao }) {
  return slots
    .livresDoDia({
      dia: QUINTA,
      semana: SEMANA,
      passo,
      duracao,
      compromissos: [],
      bloqueios: [],
      agora: new Date("2026-09-01T00:00:00Z"),
      antecedenciaHoras: 0,
      horizonteDias: 365,
      fuso: "UTC",
    })
    // `livresDoDia` devolve só o INÍCIO e as vagas — o fim é conta de quem
    // desenha, a partir da duração. Recompor aqui é o que deixa o teste falar
    // na mesma língua do pedido ("08:00–08:45").
    .map((l) => {
      const h = (d) => String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
      const fim = new Date(l.start.getTime() + duracao * 60000);
      return `${h(l.start)}-${h(fim)}`;
    });
}

test("45 de duração com 15 de intervalo dá 08:00-08:45, 09:00-09:45", async () => {
  // O pedido, ao pé da letra. A passada é 45 + 15 = 60, e o que o cliente lê é
  // o FIM em 08:45 — o quarto de hora seguinte não aparece como horário, que é
  // o ponto: "esse intervalo é para mim, e não para o cliente".
  assert.deepEqual(horarios({ passo: 60, duracao: 45 }), [
    "08:00-08:45",
    "09:00-09:45",
    "10:00-10:45",
    "11:00-11:45",
  ]);
});

test("sem intervalo (passada igual à duração) os atendimentos se encostam", async () => {
  assert.deepEqual(horarios({ passo: 45, duracao: 45 }), [
    "08:00-08:45",
    "08:45-09:30",
    "09:30-10:15",
    "10:15-11:00",
    "11:00-11:45",
  ]);
});

test("o intervalo NÃO estica o último horário além da janela", async () => {
  // A janela fecha às 12:00. Um atendimento de 45 começando 11:30 terminaria
  // 12:15, e o laço de `slots.js` corta por `m + duracao <= janela.ate`.
  //
  // O que se prova aqui é que o corte olha a DURAÇÃO e não a passada: se
  // olhasse a passada, o horário das 11:00 (que termina 11:45, dentro) sumiria
  // por causa de um intervalo que acontece depois do expediente.
  const r = horarios({ passo: 60, duracao: 45 });
  assert.equal(r[r.length - 1], "11:00-11:45");
});

test("duração maior que a passada é o caso do passo antigo, e continua valendo", async () => {
  // Página que nunca configurou intervalo cai no `slotStep`, e nada garante que
  // ele seja maior que a duração. Com passo 30 e duração 60 os horários se
  // SOBREPÕEM de propósito: é oferta densa, e marcar um derruba o vizinho por
  // conflito (ver `vagasEm`). Não é defeito — é o comportamento que as duas
  // páginas no ar têm hoje, e trocá-lo sem pedir mudaria o calendário de uma
  // cliente.
  assert.deepEqual(horarios({ passo: 30, duracao: 60 }), [
    "08:00-09:00",
    "08:30-09:30",
    "09:00-10:00",
    "09:30-10:30",
    "10:00-11:00",
    "10:30-11:30",
    "11:00-12:00",
  ]);
});
