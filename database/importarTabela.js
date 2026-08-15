// Importa uma tabela de composição de alimentos para o catálogo central.
//
//   node database/importarTabela.js TACO  database/TACO.json
//   node database/importarTabela.js IBGE  database/IBGE.json
//   node database/importarTabela.js USDA  database/USDA.json
//   node database/importarTabela.js IBGE --limpar    → tira só o que é do IBGE
//
// Substitui o importarTaco.js: são três tabelas agora, e a diferença entre elas
// é só o FORMATO do arquivo de origem. O que acontece com o dado depois — o
// nome legível, a marcação de valor ausente, o casamento por nome + fonte — é
// idêntico, e ter isso em três arquivos seria pedir para divergirem.
//
// Cada arquivo de origem é convertido para uma forma comum ANTES de chegar
// aqui: um array de { name, category, kcal, protein, carbs, fat, fiber,
// sodium }. Quem converte é o adaptador da fonte, logo abaixo.
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

function semAcento(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// As tabelas marcam "não é número" de formas diferentes, e elas NÃO querem
// dizer a mesma coisa:
//
//   "NA", "", "*"  → não analisado. Ninguém mediu. Vira `null`, e a soma do dia
//                    sabe que não sabe.
//   "Tr"           → traço: medido, e é tão pouco que não se conta. Vira 0,
//                    porque zero é a resposta certa — não é ignorância, é
//                    ausência.
//
// Tratar as duas como zero inflaria a confiança nos totais; tratar as duas como
// desconhecido faria metade do catálogo parecer sem dado.
function valor(v) {
  if (v === undefined || v === null || v === "") return null;

  if (typeof v === "string") {
    const limpo = v.trim();
    if (limpo === "Tr") return 0;
    if (limpo === "NA" || limpo === "*" || limpo === "-") return null;
  }

  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  // Uma casa decimal: as tabelas publicam com precisão de laboratório, e
  // "2.58825 g de proteína" numa tela de dieta é falsa precisão.
  return Math.round(n * 10) / 10;
}

// "ARROZ, INTEGRAL, COZIDO" → "Arroz integral cozido".
//
// As tabelas escrevem em ordem de catálogo, com vírgulas e caixa alta, para
// agrupar os parentes na listagem impressa. Numa busca por digitação isso
// atrapalha: ninguém procura por "ARROZ, INTEGRAL".
function nomeLegivel(descricao) {
  const limpo = String(descricao || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  // Só a primeira letra sobe. Deixar tudo em caixa alta grita na tela, e
  // capitalizar cada palavra viraria "Arroz Integral Cozido".
  const minuscula = limpo === limpo.toUpperCase() ? limpo.toLowerCase() : limpo;
  return minuscula.charAt(0).toUpperCase() + minuscula.slice(1);
}

// ── Adaptadores: cada fonte vira a mesma forma ────────────────────────────

const FONTES = {
  // github.com/marcelosanto/tabela_taco (MIT) — transcrição dos 597 alimentos
  // publicados pelo NEPA/Unicamp.
  TACO: (bruto) =>
    bruto.map((i) => ({
      name: nomeLegivel(i.description),
      category: String(i.category || "").trim(),
      kcal: valor(i.energy_kcal),
      protein: valor(i.protein_g),
      carbs: valor(i.carbohydrate_g),
      fat: valor(i.lipid_g),
      fiber: valor(i.fiber_g),
      sodium: valor(i.sodium_mg),
    })),

  // Convertido da planilha oficial do IBGE (POF 2008-2009) por
  // scripts/ibgeParaJson.py. Cada linha é um alimento numa PREPARAÇÃO — cru,
  // cozido, frito — e é isso que o nome precisa dizer: "Milho em grão" cozido e
  // cru têm valores diferentes e são duas escolhas diferentes na refeição.
  IBGE: (bruto) =>
    bruto.map((i) => ({
      name: nomeLegivel(
        i.preparation && !/^n[aã]o se aplica$/i.test(i.preparation)
          ? `${i.description}, ${i.preparation}`
          : i.description
      ),
      category: String(i.category || "").trim(),
      kcal: valor(i.kcal),
      protein: valor(i.protein),
      carbs: valor(i.carbs),
      fat: valor(i.fat),
      fiber: valor(i.fiber),
      sodium: valor(i.sodium),
    })),

  // FoodData Central, do USDA. Domínio público (governo dos EUA). Os nomes vêm
  // em inglês e é assim que ficam: traduzir "Cheese, cheddar" por conta própria
  // criaria um nome que não existe em tabela nenhuma e que ninguém consegue
  // conferir contra a fonte.
  USDA: (bruto) =>
    bruto.map((i) => ({
      name: nomeLegivel(i.description),
      category: String(i.category || "").trim(),
      kcal: valor(i.kcal),
      protein: valor(i.protein),
      carbs: valor(i.carbs),
      fat: valor(i.fat),
      fiber: valor(i.fiber),
      sodium: valor(i.sodium),
    })),
};

async function importar(app, fonte, arquivo) {
  const adaptar = FONTES[fonte];
  if (!adaptar) throw new Error(`fonte desconhecida: ${fonte}`);

  const itens = adaptar(JSON.parse(fs.readFileSync(arquivo, "utf8")));

  const db = await app.mongodb.centralDb();
  const col = db.collection("foods");

  // Os alimentos escritos à mão neste projeto (database/foods.js) têm medida
  // caseira — "1 fatia = 50 g" — que as tabelas não trazem. Eles GANHAM do item
  // equivalente: perder a porção sugerida para ganhar uma segunda linha com o
  // mesmo nome seria mau negócio.
  const curados = new Set(
    (await col.find({ source: { $in: [null, ""] } }, { projection: { nameSort: 1 } }).toArray()).map(
      (d) => d.nameSort
    )
  );

  const vistos = new Set();
  const ops = [];
  let pulados = 0;

  for (const item of itens) {
    const chave = semAcento(item.name);

    // Duplicata DENTRO do próprio arquivo é comum: o IBGE repete o alimento
    // por preparação, e duas preparações podem colidir depois de normalizadas.
    // Sem este controle, a segunda sobrescreveria a primeira em silêncio e a
    // contagem final mentiria.
    if (!item.name || curados.has(chave) || vistos.has(chave)) {
      pulados++;
      continue;
    }
    vistos.add(chave);

    ops.push({
      updateOne: {
        // Casado por nome + fonte: reimportar corrige em vez de duplicar, e uma
        // fonte nunca pisa na outra.
        filter: { nameSort: chave, source: fonte },
        update: {
          $set: {
            name: item.name,
            nameSort: chave,
            category: item.category,
            source: fonte,
            unit: "g",
            kcal: item.kcal,
            protein: item.protein,
            carbs: item.carbs,
            fat: item.fat,
            fiber: item.fiber,
            sodium: item.sodium,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date(), portion: null, portionLabel: "" },
        },
        upsert: true,
      },
    });
  }

  if (!ops.length) return { novos: 0, atualizados: 0, pulados };

  // Em lotes: um bulkWrite de oito mil operações estoura o limite de 16 MB do
  // Mongo por comando.
  let novos = 0;
  let atualizados = 0;

  for (let i = 0; i < ops.length; i += 500) {
    const r = await col.bulkWrite(ops.slice(i, i + 500));
    novos += r.upsertedCount || 0;
    atualizados += r.modifiedCount || 0;
  }

  return { novos, atualizados, pulados };
}

async function main() {
  const fonte = String(process.argv[2] || "").toUpperCase();
  const app = {};
  app.mongodb = require("../config/mongodb.js");

  try {
    if (!FONTES[fonte]) {
      console.error(`[tabela] uso: node database/importarTabela.js ${Object.keys(FONTES).join("|")} arquivo.json`);
      process.exit(1);
    }

    if (process.argv.includes("--limpar")) {
      const db = await app.mongodb.centralDb();
      const r = await db.collection("foods").deleteMany({ source: fonte });
      console.log(`[tabela] removidos ${r.deletedCount} alimentos da fonte ${fonte}`);
      await app.mongodb.close();
      process.exit(0);
    }

    const arquivo = process.argv[3] || path.join(__dirname, `${fonte}.json`);
    if (!fs.existsSync(arquivo)) {
      console.error(`[tabela] arquivo não encontrado: ${arquivo}`);
      process.exit(1);
    }

    const { novos, atualizados, pulados } = await importar(app, fonte, arquivo);
    const col = (await app.mongodb.centralDb()).collection("foods");
    const daFonte = await col.countDocuments({ source: fonte });
    const total = await col.countDocuments({});

    console.log(
      `[${fonte}] ${novos} novos, ${atualizados} atualizados, ${pulados} pulados — ` +
        `${daFonte} desta fonte, ${total} no catálogo`
    );

    await app.mongodb.close();
    process.exit(0);
  } catch (error) {
    console.error("[tabela] falhou:", error.message);
    process.exit(1);
  }
}

// Só conecta ao banco quando alguém RODA o arquivo. Importado por um teste, ele
// oferece as funções e não abre conexão nenhuma.
if (require.main === module) main();

module.exports = { importar, nomeLegivel, valor, FONTES };
