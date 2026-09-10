const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = require("../../database/schema.js");

// QUANTO TEMPO CADA COISA FICA — e as duas armadilhas de mexer nisso.
//
// *"Pode 6 meses, limpe o que for antigo"* (07/09/2026), primeiro para o
// histórico de ações e depois para as conversas de IA.
//
// TTL é a única configuração deste projeto que APAGA DADO sozinha, e ela apaga em
// silêncio: não há erro, não há log, o número simplesmente fica menor. Os dois
// casos abaixo guardam as duas formas de errar que eu já quase cometi hoje.
const RAIZ = path.join(__dirname, "..", "..");
const fonte = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

test("as duas retenções existem, em dias inteiros", () => {
  for (const nome of ["PODA_HISTORICO_DIAS", "PODA_CONVERSAS_IA_DIAS"]) {
    const v = schema[nome];
    assert.ok(Number.isInteger(v) && v > 0, `${nome} = ${v}`);
  }
});

// ── ARMADILHA 1: O CAMPO ERRADO MATA CONVERSA VIVA ─────────────────────────
//
// O TTL de `ai_sessions` é por `updatedAt`. Por `createdAt`, uma conversa aberta
// em janeiro e retomada toda semana morreria em julho NO MEIO DO USO — e o
// único sintoma seria a pessoa dizendo "sumiu meu histórico".
//
// Os dois campos existem no documento, os dois são `Date`, e trocar um pelo
// outro é uma letra. Nenhum teste de comportamento pegaria: só o tempo pega.
test("a poda das conversas de IA é por updatedAt, NUNCA por createdAt", () => {
  const s = fonte("database/schema.js");

  // O bloco do índice de poda de `ai_sessions`, do nome da collection até o
  // fecho da chamada.
  const bloco = s.match(/collection\("ai_sessions"\)\s*\.createIndex\(\s*\{([^}]*)\}[^;]*expireAfterSeconds[^;]*;/);
  assert.ok(bloco, "não achei o índice de TTL de ai_sessions");

  assert.match(bloco[1], /updatedAt/, "o TTL tem de ser por updatedAt");
  assert.doesNotMatch(
    bloco[1],
    /createdAt/,
    "TTL por createdAt apaga conversa que a pessoa está usando"
  );
});

// ── ARMADILHA 2: O RELATÓRIO PROMETENDO MAIS DO QUE SE GUARDA ──────────────
//
// `/ai/usage` aceitava até 365 dias e soma `ai_sessions`, que agora se apaga em
// 180. A pergunta de "último ano" continuaria respondendo — com um número que
// encolhe sozinho e se lê como "o cliente usou menos IA".
//
// O teste é na FONTE porque o defeito é na fonte: alguém escrever `365` de novo,
// ou trocar a retenção e esquecer da janela. Nenhuma resposta de rota estaria
// errada hoje; ela ficaria errada em fevereiro.
test("a janela do relatório de IA vem da retenção, e não de um número solto", () => {
  const s = fonte("controllers/Ai.js");

  const linha = s.match(/const dias = Math\.min\([^;]*\);/);
  assert.ok(linha, "não achei o cálculo da janela em /ai/usage");

  assert.match(
    linha[0],
    /PODA_CONVERSAS_IA_DIAS/,
    "o teto tem de ser a constante da retenção, senão os dois números divergem"
  );
  assert.doesNotMatch(linha[0], /\b365\b/, "365 dias sobre 180 de retenção é um relatório que mente");
});

// ── E O QUE NÃO PODE GANHAR TTL POR DESCUIDO ───────────────────────────────
//
// Uma varredura, e ela é de propósito grosseira: qualquer `expireAfterSeconds`
// novo no schema tem de estar nesta lista. É a única configuração do projeto que
// apaga dado sozinha, e a lista existe para a próxima ser uma DECISÃO, e não uma
// linha que entrou junto com outra coisa.
test("só as collections combinadas têm TTL", () => {
  // OS COMENTÁRIOS SAEM ANTES DA VARREDURA.
  //
  // A primeira versão deste caso reprovou por um `expireAfterSeconds` escrito
  // num comentário meu, no topo do arquivo, longe de qualquer `collection(...)`.
  // Varredura de fonte lê comentário como código — e aqui isso não é ruído
  // inofensivo: ela procurava a collection mais próxima ANTES da palavra, e a
  // resposta era "nenhuma".
  const s = fonte("database/schema.js").replace(/\/\/[^\n]*/g, "");

  const PREVISTAS = new Set([
    "user_tokens",
    "password_resets",
    "anamnesis_links",
    "api_calls",
    // As duas de 07/09/2026.
    "user_action_history",
    "ai_sessions",
  ]);

  const achadas = new Set();
  // Cada `expireAfterSeconds` e a collection mais próxima ANTES dele.
  for (const m of s.matchAll(/expireAfterSeconds/g)) {
    const antes = s.slice(0, m.index);
    const col = [...antes.matchAll(/collection\("([a-z_]+)"\)/g)].pop();
    assert.ok(col, "expireAfterSeconds sem collection antes");
    achadas.add(col[1]);
  }

  assert.ok(achadas.size > 0, "um teste que não vê nenhum TTL passaria calado");

  const novas = [...achadas].filter((c) => !PREVISTAS.has(c));
  assert.deepEqual(novas, [], "TTL numa collection que ninguém combinou de podar");
});
