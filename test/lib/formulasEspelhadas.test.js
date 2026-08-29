const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const calculos = require("../../lib/calculos.mjs");

// AS FÓRMULAS DA AVALIAÇÃO SÃO ESPELHADAS DO SITE.
//
// `lib/calculos.mjs` é cópia byte a byte de
// `gofitnow-frontend/src/views/student/assessments/calculos.js`, feita por
// `scripts/formulasDoSite.mjs`.
//
// Elas vieram para cá porque o DOCUMENTO da avaliação (folha, PDF, e-mail) passa
// a ser montado no backend — para o web e o app mostrarem exatamente a mesma
// coisa. Sem o espelho, seria a terceira escrita da mesma matemática, e a
// divergência entre elas é MUDA: três lados mostrando gorduras diferentes para a
// mesma dobra, sem erro e sem log.
test("a cópia é idêntica à fonte, tirando o aviso", () => {
  const daqui = path.join(__dirname, "..", "..", "lib", "calculos.mjs");
  const doSite = path.join(
    __dirname, "..", "..", "..",
    "gofitnow-frontend", "src", "views", "student", "assessments", "calculos.js"
  );

  // Fora do monorepo do dev (CI do backend sozinho) o teste não se aplica.
  if (!fs.existsSync(doSite)) return;

  const copia = fs.readFileSync(daqui, "utf8");
  const fonte = fs.readFileSync(doSite, "utf8");

  // Igualdade, e não "contém": uma linha a mais no meio de uma fórmula passaria
  // por um `contains`.
  assert.equal(copia.slice(copia.indexOf("\n\n") + 2), fonte);
});

test("o aviso está no arquivo — quem abrir para consertar precisa ver", () => {
  const copia = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "calculos.mjs"), "utf8");
  assert.match(copia, /NÃO EDITE AQUI/);
  assert.match(copia, /scripts\/formulasDoSite\.mjs/);
});

// ── A PROVA DE QUE ELE CARREGA AQUI ───────────────────────────────────────
//
// `calculos` é ESM e este backend é CommonJS. `require()` de um ESM só existe a
// partir do Node 22.12 — a máquina rodava o 18 até 28/08/2026, e é o upgrade
// daquele dia que torna isto possível sem shim e sem build.
//
// Este teste é o que avisa se alguém baixar a versão do Node: ele para de passar
// com "require() of ES Module not supported", em vez de a folha da avaliação
// quebrar em produção.
test("o backend consegue REQUERER o módulo ESM", () => {
  assert.equal(typeof calculos.calcular, "function");
  assert.equal(typeof calculos.imc, "function");
});

test("as contas batem com valores conferidos à mão", () => {
  const r = calculos.calcular(
    {
      date: "2026-08-20",
      weight: 78.4,
      height: 1.78,
      method: "skinfolds",
      protocol: "pollock3",
      // Os três pontos de MULHER no Pollock de 3 dobras: tríceps, supra-ilíaca e
      // coxa. Usar os pontos de homem devolve `null` — não é defeito, é protocolo.
      skinfolds: { triceps: 18, suprailiac: 20, thigh: 26 },
      circumferences: { waist: 82, hip: 98 },
    },
    { sex: "female", birthDate: "1994-02-01" }
  );

  assert.equal(r.imc, 24.74);
  assert.equal(r.imcClass, "normal");
  assert.equal(r.rcq, 0.84);
  assert.equal(r.referencia, 25.54);
  assert.equal(r.composicao.leanMass, 58.4);
});
