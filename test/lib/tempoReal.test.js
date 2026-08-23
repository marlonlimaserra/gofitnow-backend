const test = require("node:test");
const assert = require("node:assert/strict");

const tempoReal = require("../../lib/tempoReal.js");

// O canal de tempo real.
//
// O que estes casos guardam é o ENDEREÇAMENTO, que é onde um erro custa caro:
// um aviso que sai para a sala errada mostra a tela de uma pessoa mexendo
// sozinha por causa do que outra pediu — e numa academia com cinco professores
// isso acontece no primeiro dia.
//
// A conexão em si (WebSocket, aperto de mão, CORS) não é testada aqui: subir um
// servidor de verdade num teste de unidade testaria o socket.io, não a nossa
// regra.

test("a sala é da PESSOA, dentro da instância dela", () => {
  // O banco já é por cliente, mas dentro dele há vários profissionais. Uma sala
  // por instância faria todo mundo ver a tela pular junto.
  assert.equal(tempoReal.sala("marlon", "abc"), "u:marlon:abc");
  assert.notEqual(tempoReal.sala("marlon", "abc"), tempoReal.sala("marlon", "xyz"));
});

test("instâncias diferentes NUNCA compartilham sala", () => {
  // Dois bancos podem, em tese, ter o mesmo id — o nome da instância no meio é
  // o que impede o cruzamento.
  assert.notEqual(tempoReal.sala("marlon", "abc"), tempoReal.sala("bruna", "abc"));
});

test("sem canal de pé, avisar não estoura — só não avisa", () => {
  // Isto é enfeite de tela. Uma ferramenta que falhasse porque o aviso não saiu
  // seria uma ferramenta que depende do navegador estar aberto.
  tempoReal.parar();

  assert.equal(tempoReal.ativo(), false);
  assert.equal(tempoReal.avisar("marlon", "abc", "x", {}), false);
});

test("sem pessoa, não sai aviso nenhum", () => {
  // Um `undefined` no nome da sala viraria a string "u:marlon:undefined" — uma
  // sala que ninguém escuta hoje, e que amanhã alguém pode escutar por engano.
  tempoReal.parar();

  assert.equal(tempoReal.avisar("marlon", null, "x", {}), false);
  assert.equal(tempoReal.avisar(null, "abc", "x", {}), false);
});

// ── A ANAMNESE AO VIVO ──────────────────────────────────────────────────────
//
// A pessoa digita no celular e o profissional vê. O que estes casos guardam é o
// que impede isso de virar um problema: campo fora da lista não passa, e uma aba
// com defeito não inunda a tela de ninguém.

test("só os campos da anamnese atravessam o canal", () => {
  // Uma chave inventada chegando à tela do profissional é, no melhor caso, um
  // campo que não existe; no pior, um jeito de escrever onde não devia.
  assert.equal(tempoReal.CAMPOS_AO_VIVO.has("medications"), true);
  assert.equal(tempoReal.CAMPOS_AO_VIVO.has("sleepHours"), true);
  assert.equal(tempoReal.CAMPOS_AO_VIVO.has("smoking"), true);

  assert.equal(tempoReal.CAMPOS_AO_VIVO.has("password"), false);
  assert.equal(tempoReal.CAMPOS_AO_VIVO.has("__proto__"), false);
  assert.equal(tempoReal.CAMPOS_AO_VIVO.has("answeredByPersonAt"), false);
});

test("o limite por segundo deixa passar quem digita e corta o laço", () => {
  // Um humano rápido faz oito toques por segundo, e a tela ainda junta as teclas
  // antes de mandar. Vinte é folgado para ela e apertado para uma aba em laço.
  const socket = { data: {} };

  let passaram = 0;
  for (let i = 0; i < 100; i += 1) if (tempoReal.podeFalar(socket)) passaram += 1;

  assert.equal(passaram, tempoReal.POR_SEGUNDO);
});

test("a janela do limite VIRA — quem esperou um segundo fala de novo", () => {
  // Sem isto, a primeira rajada calaria a pessoa até ela recarregar a página.
  const socket = { data: {} };

  for (let i = 0; i < 100; i += 1) tempoReal.podeFalar(socket);
  assert.equal(tempoReal.podeFalar(socket), false);

  // Um segundo atrás: é o que o relógio dela diria depois de uma pausa.
  socket.data.janela.desde = Date.now() - 1500;
  assert.equal(tempoReal.podeFalar(socket), true);
});
