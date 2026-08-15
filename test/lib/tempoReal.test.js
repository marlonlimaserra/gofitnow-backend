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
