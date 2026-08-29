// PUXA as fórmulas da avaliação física do site para dentro do backend.
//
// ── Por que o BACKEND precisa delas agora ─────────────────────────────────
//
// O documento da avaliação (folha para imprimir, PDF, corpo do e-mail) passou a
// ser gerado AQUI, e não em cada tela. A razão é do Marlon, e é boa: *"o ideal
// seria esse PDF ser um HTML gerado direto no backend, assim garantimos que vai
// ser igual no web e no app"*. Com o HTML nascendo num lugar só, não existe
// versão do site e versão do app para divergirem.
//
// Só que a folha mostra IMC, percentual de gordura, massa magra e as
// classificações — e quem calcula isso é `calculos.js`, que mora no site porque
// é lá que o formulário recalcula a cada tecla.
//
// ── Por que ESPELHO, e não uma terceira escrita ───────────────────────────
//
// Reescrever as fórmulas aqui seria a TERCEIRA cópia da mesma matemática (site,
// app, backend). O dia em que uma divergisse, os três lados mostrariam gorduras
// diferentes para a mesma dobra — sem erro, sem log, e a conta certa
// indistinguível da errada.
//
// O app já resolveu isso do mesmo jeito (`gofitnow-expo/scripts/formulasDoSite.mjs`):
// o site é a fonte, este script copia, e um teste quebra se divergirem.
//
// ── E por que isto só é possível desde 28/08/2026 ─────────────────────────
//
// `calculos.js` é ESM (`export function`) e este backend é CommonJS. Carregar um
// do outro exigia Node 22.12+; a máquina rodava o 18. O upgrade para o 24 daquela
// manhã é o que torna `require()` deste arquivo possível — sem shim, sem build.
//
// Rode depois de mexer em calculos.js no site:  node scripts/formulasDoSite.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DO_SITE = path.join(
  AQUI, "..", "..", "gofitnow-frontend", "src", "views", "student", "assessments"
);

// `.mjs` e não `.js`: o `package.json` daqui não declara `type: module`, então um
// `.js` com `export` seria lido como CommonJS e estouraria na primeira linha.
//
// São DOIS arquivos: as fórmulas e a lista de grupos de medidas. `grupos.js` foi
// separado no site justamente para atravessar — `campos.js`, onde ele morava,
// importa `lib/fuso.js` e puxaria uma corrente.
const ARQUIVOS = [
  ["calculos.js", "calculos.mjs"],
  ["grupos.js", "grupos.mjs"],
];

if (!fs.existsSync(DO_SITE)) {
  console.error("site não encontrado em " + DO_SITE);
  process.exit(1);
}

const AVISO = `// ⚠️  ARQUIVO ESPELHADO — NÃO EDITE AQUI.
//
// A fonte é o site:
//   gofitnow-frontend/src/views/student/assessments/calculos.js
//
// Cópia byte a byte, feita por \`node scripts/formulasDoSite.mjs\`, e há teste
// (test/lib/formulasEspelhadas.test.js) que quebra se os dois divergirem.
//
// Por que espelho e não import: são três programas diferentes. O site precisa das
// fórmulas no NAVEGADOR (o formulário recalcula a cada tecla), o app precisa delas
// no aparelho, e o backend precisa delas para montar o documento da avaliação.
// Reescrever seria manter três versões da mesma matemática — e a divergência entre
// elas é MUDA.

`;

for (const [origem, destino] of ARQUIVOS) {
  const original = fs.readFileSync(path.join(DO_SITE, origem), "utf8");
  fs.writeFileSync(path.join(AQUI, "..", "lib", destino), AVISO.replace("calculos.js", origem) + original);
  console.log(`${destino}: ${original.split("\n").length} linhas espelhadas do site`);
}
