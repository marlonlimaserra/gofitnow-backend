const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// TODA CHAVE QUE O CÓDIGO PEDE EXISTE NA TRADUÇÃO?
//
// ── O defeito que este arquivo procura ────────────────────────────────────
//
// `req.t("errors.bookingName")` com a chave ausente não estoura: devolve a
// PRÓPRIA CHAVE. A rota responde `{"msg":"errors.bookingName"}`, e quem vê é o
// visitante da página pública do aulão.
//
// Ficou assim desde que o módulo nasceu. O `i18n:check` passava — ele confere se
// os quatro idiomas têm as MESMAS chaves, e quatro arquivos igualmente
// incompletos passam nesse teste. Faltava a outra metade da pergunta: as chaves
// que o CÓDIGO usa existem?
//
// Descobri porque a prova de ponta a ponta da inscrição imprimiu a chave crua na
// resposta. Quatro chaves estavam faltando — três minhas, do aulão, e
// `errors.invalidFile`, do suporte.
//
// O `gofitnow-frontend` já tinha este teste (`chavesUsadas.test.js`), e ele me
// pegou no mesmo dia usando `common.home`. Este é o par dele aqui.
//
// ── O QUE FICA DE FORA, e por quê ─────────────────────────────────────────
//
// OUTRO CATÁLOGO: os geradores de documento (dieta, avaliação, receita) usam
// `lib/rotulosDeDocumento.js`, que é um catálogo separado com as próprias
// chaves. Conferi-los contra este arquivo acusaria vinte chaves que existem —
// no lugar certo.
//
// PREFIXO DE CONCATENAÇÃO: `req.t("errors." + codigo)` aparece na varredura como
// a chave `"errors."`. Não é chave, é metade de uma — e a outra metade só existe
// em tempo de execução. Chave terminada em ponto é ignorada.
//
// Isto deixa um vão conhecido: uma chave montada em tempo de execução pode não
// existir e este teste não vê. Os dois lugares que fazem isso (`lib/limiteDoPlano.js`
// e o `motivoDoErro` do aulão) mapeiam de listas fechadas, e são pequenos o
// bastante para ler.
const RAIZ = path.join(__dirname, "..", "..");

const OUTRO_CATALOGO = new Set([
  "lib/documentoDieta.js",
  "lib/documentoAvaliacao.js",
  "lib/documentoReceita.js",
  // O extrato financeiro da ficha (17/09/2026). Mesma razão dos três de cima:
  // os rótulos dele são os da TELA ("Cobrado", "Vence", "Pix"), espelhados em
  // `lib/i18n/documentos` — não o catálogo de mensagens do backend.
  "lib/documentoFinanceiro.js",
  // A folha de ponto e a planilha dela (21/09/2026). Os rótulos são os da TELA
  // de funcionários ("Batidas", "Falta justificada", "Assinatura do
  // funcionário"), espelhados do site pelo `scripts/traducaoDoSite.mjs`.
  "lib/documentoPonto.js",
  "lib/planilhaDoPonto.js",
  // A lista de inscritos de um aulão, em papel e em planilha (23/09/2026). Os
  // rótulos são os da TELA de aulões ("Assinatura", "Pagou"), espelhados do
  // site — e o app pede as duas ao servidor porque no celular não há Ctrl+P
  // nem pasta de downloads.
  "lib/documentoInscritos.js",
  // O registro das listas que se levam embora (23/09/2026): os rótulos são os
  // das TELAS ("Acesso", "Situação", "Unidade"), espelhados do site. Uma
  // definição para todos os clientes — ver o cabeçalho de lá.
  "lib/listasExportaveis.js",
  "lib/rotulosDeDocumento.js",
]);

const IGNORAR_PASTAS = new Set(["node_modules", ".git", "test", "assets"]);

function arquivosJs(dir) {
  const saida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR_PASTAS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...arquivosJs(p));
    else if (e.name.endsWith(".js")) saida.push(p);
  }
  return saida;
}

// A tradução é repartida por ÁREA desde 26/09/2026 — o carregador junta a
// pasta. Ler um arquivo só aqui passaria a conferir um pedaço do catálogo e
// acusaria como "faltando" toda chave que mora noutra área.
function catalogo() {
  return require("../../lib/i18n/index.js").carregarIdioma("pt-BR");
}

function existe(dados, chave) {
  return chave.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dados) !== undefined;
}

test("nenhuma chave literal usada no código está ausente na tradução", () => {
  const dados = catalogo();
  const faltando = [];

  for (const arquivo of arquivosJs(RAIZ)) {
    const rel = path.relative(RAIZ, arquivo);
    if (OUTRO_CATALOGO.has(rel)) continue;

    const texto = fs.readFileSync(arquivo, "utf8");

    // `t("chave")`, `req.t("chave")`, `traduzir("chave")` — a chamada com
    // literal. Interpolação e variável não são alcançáveis daqui.
    for (const m of texto.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
      const chave = m[1];
      if (!chave.includes(".")) continue;
      // Prefixo de concatenação: ver o cabeçalho.
      if (chave.endsWith(".")) continue;

      if (!existe(dados, chave)) faltando.push(`${rel}: ${chave}`);
    }
  }

  // A mensagem lista os culpados: "esperava 0, recebeu 4" mandaria alguém
  // procurar em cento e poucos arquivos.
  assert.deepEqual(
    faltando,
    [],
    "chave(s) usada(s) no código e ausente(s) na tradução — a rota devolveria a chave crua:\n  " +
      faltando.join("\n  ")
  );
});

test("o teste consegue reprovar — uma chave inventada é detectada", () => {
  // Sem isto, um regex que deixasse de casar transformaria o teste em enfeite:
  // ele varreria cento e poucos arquivos e devolveria zero para sempre. É a
  // mesma lição do `idsConferir`, que não podia falhar e devolvia zero.
  const dados = catalogo();
  assert.equal(existe(dados, "errors.internal"), true, "a âncora sumiu do catálogo");
  assert.equal(existe(dados, "errors.chaveQueNaoExiste"), false);
});
