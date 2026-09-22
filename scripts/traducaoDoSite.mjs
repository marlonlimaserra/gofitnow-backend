// PUXA os rótulos do DOCUMENTO do site para dentro do backend.
//
// ── Por que o backend precisa deles ───────────────────────────────────────
//
// O documento da avaliação (folha, PDF, e-mail) passou a nascer aqui, para o web
// e o app mostrarem exatamente a mesma coisa. Mas ele é feito de rótulos —
// "Peso", "Dobras cutâneas", "Lado direito" — e esses moram no site, onde as
// telas os usam.
//
// ── Por que num arquivo SEPARADO do catálogo do backend ───────────────────
//
// O backend tem o catálogo dele (`lib/i18n/locales`), com 524 chaves conferidas
// por `npm run i18n:check`. Despejar as chaves do site ali dentro misturaria dois
// vocabulários com donos diferentes e faria aquele conferidor acusar tudo.
//
// Aqui é um depósito à parte, lido só por quem monta documento.
//
// Rode depois de mexer na tradução do site:  node scripts/traducaoDoSite.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(AQUI, "..", "..", "gofitnow-frontend", "src", "i18n", "locales");
const DESTINO = path.join(AQUI, "..", "lib", "i18n", "documentos");

// As PARTES que um documento usa. `avaliacoes` traz os rótulos das medidas e dos
// ângulos de foto; `comum` traz as palavras que todo documento reaproveita.
// Quando a folha da dieta nascer, `dietas` entra nesta lista.
//
// `financeiro` entrou em 17/09/2026, com o EXTRATO da pessoa: "Cobrado",
// "Recebido", "Vence", os nomes das sete formas de pagamento de fábrica.
//
// `funcionarios` entrou em 21/09/2026, com a FOLHA DE PONTO: "Batidas",
// "Assinatura do funcionário", "Falta justificada". O papel do app nasce aqui e
// o do painel é React — as duas metades falando as MESMAS palavras é o que este
// espelho garante.
const PARTES = ["avaliacoes", "comum", "dietas", "financeiro", "funcionarios"];
const IDIOMAS = ["pt-BR", "en", "es", "fr"];

if (!fs.existsSync(SITE)) {
  console.error("site não encontrado em " + SITE);
  process.exit(1);
}

fs.mkdirSync(DESTINO, { recursive: true });

for (const lng of IDIOMAS) {
  const junto = {};

  for (const parte of PARTES) {
    const arquivo = path.join(SITE, lng, `${parte}.json`);
    if (!fs.existsSync(arquivo)) continue;
    Object.assign(junto, JSON.parse(fs.readFileSync(arquivo, "utf8")));
  }

  // ── O PLURAL DO SITE, no formato que o i18next do backend lê ────────────
  //
  // O site escreve `chave` + `chave_plural` (compatibilidade v3). Se o backend
  // usar uma versão que só entende `_one`/`_other`, o plural cai calado no
  // singular. Gravamos as duas formas: sobra chave, e nenhuma falta.
  const comPlural = (no) => {
    for (const [k, v] of Object.entries(no)) {
      if (v && typeof v === "object" && !Array.isArray(v)) comPlural(v);
      else if (k.endsWith("_plural")) {
        const base = k.slice(0, -"_plural".length);
        no[`${base}_other`] = v;
        if (no[base] !== undefined) no[`${base}_one`] = no[base];
      }
    }
  };
  comPlural(junto);

  // O aviso vai DENTRO do JSON, como chave: arquivo `.json` não aceita
  // comentário, e um `//` no topo faz o `JSON.parse` estourar na leitura. (Foi o
  // que aconteceu na primeira versão deste script.)
  const saida = path.join(DESTINO, `${lng}.json`);
  fs.writeFileSync(
    saida,
    JSON.stringify({ _aviso: "ESPELHADO DO SITE — não edite. Ver scripts/traducaoDoSite.mjs", ...junto }, null, 2) + "\n"
  );
  console.log(`${lng}: ${Object.keys(junto).length} grupos`);
}
