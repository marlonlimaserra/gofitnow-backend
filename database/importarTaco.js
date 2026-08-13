// Importa a TACO — Tabela Brasileira de Composição de Alimentos, do NEPA/Unicamp
// — para o catálogo central.
//
//   node database/importarTaco.js caminho/para/TACO.json
//   node database/importarTaco.js --limpar     → tira só o que veio da TACO
//
// A tabela em si é dado público de pesquisa da Unicamp. O arquivo JSON usado
// aqui vem de https://github.com/marcelosanto/tabela_taco (MIT), que é uma
// transcrição da publicação oficial — 597 alimentos com todos os nutrientes por
// 100 g de parte comestível.
//
// Rodar de novo é seguro: cada item é casado pelo nome normalizado + fonte, e
// atualizado no lugar. Isso é o que permite corrigir a tabela depois sem criar
// 597 duplicatas.
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const FONTE = "TACO";

function semAcento(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// A TACO usa três marcações para "não é um número", e elas NÃO querem dizer a
// mesma coisa:
//
//   "NA" / ""  → não analisado. Ninguém mediu. Vira `null`, e a soma do dia
//                sabe que não sabe.
//   "Tr"       → traço: medido, e é tão pouco que não se conta. Vira 0, porque
//                zero é a resposta certa aqui — não é ignorância, é ausência.
//
// Tratar as duas como zero inflaria a confiança nos totais; tratar as duas como
// desconhecido faria metade dos alimentos parecer sem dado.
function valor(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string") {
    const limpo = v.trim();
    if (limpo === "Tr") return 0;
    if (limpo === "NA" || limpo === "*") return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  // Uma casa decimal: a tabela publica com precisão de laboratório, e "2.58825
  // g de proteína" numa tela de dieta é falsa precisão.
  return Math.round(n * 10) / 10;
}

// "Arroz, integral, cozido" → "Arroz integral cozido".
//
// A TACO escreve em ordem de catálogo, com vírgulas, para agrupar os parentes na
// listagem alfabética. Numa busca por digitação isso atrapalha: ninguém procura
// por "Arroz, integral". As vírgulas viram espaço e a primeira letra sobe.
function nomeLegivel(descricao) {
  const limpo = String(descricao || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");

  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

async function importar(app, arquivo) {
  const bruto = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  const db = await app.mongodb.centralDb();
  const col = db.collection("foods");

  // Os alimentos escritos à mão neste projeto (database/foods.js) têm medida
  // caseira — "1 fatia = 50 g" — que a TACO não traz. Eles GANHAM do item
  // equivalente da tabela: perder a porção sugerida para ganhar uma segunda
  // linha com o mesmo nome seria um mau negócio.
  const jaExistem = new Set(
    (await col.find({ source: { $in: [null, ""] } }, { projection: { nameSort: 1 } }).toArray()).map(
      (d) => d.nameSort
    )
  );

  const ops = [];
  let pulados = 0;

  for (const item of bruto) {
    const nome = nomeLegivel(item.description);
    const chave = semAcento(nome);

    if (!nome || jaExistem.has(chave)) {
      pulados++;
      continue;
    }

    ops.push({
      updateOne: {
        // Casado por nome + fonte: reimportar corrige em vez de duplicar.
        filter: { nameSort: chave, source: FONTE },
        update: {
          $set: {
            name: nome,
            nameSort: chave,
            category: String(item.category || "").trim(),
            source: FONTE,
            unit: "g",
            kcal: valor(item.energy_kcal),
            protein: valor(item.protein_g),
            carbs: valor(item.carbohydrate_g),
            fat: valor(item.lipid_g),
            fiber: valor(item.fiber_g),
            sodium: valor(item.sodium_mg),
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date(), portion: null, portionLabel: "" },
        },
        upsert: true,
      },
    });
  }

  if (!ops.length) return { gravados: 0, pulados };

  const r = await col.bulkWrite(ops);
  return { gravados: (r.upsertedCount || 0) + (r.modifiedCount || 0), pulados };
}

async function main() {
  const app = {};
  app.mongodb = require("../config/mongodb.js");

  try {
    if (process.argv.includes("--limpar")) {
      const db = await app.mongodb.centralDb();
      const r = await db.collection("foods").deleteMany({ source: FONTE });
      console.log(`[taco] removidos ${r.deletedCount} alimentos da fonte ${FONTE}`);
      await app.mongodb.close();
      process.exit(0);
    }

    const arquivo = process.argv[2] || path.join(__dirname, "TACO.json");
    if (!fs.existsSync(arquivo)) {
      console.error(`[taco] arquivo não encontrado: ${arquivo}`);
      process.exit(1);
    }

    const { gravados, pulados } = await importar(app, arquivo);
    const total = await (await app.mongodb.centralDb()).collection("foods").countDocuments({});

    console.log(`[taco] ${gravados} gravados, ${pulados} pulados — ${total} alimentos no catálogo`);

    await app.mongodb.close();
    process.exit(0);
  } catch (error) {
    console.error("[taco] falhou:", error.message);
    process.exit(1);
  }
}

// Só conecta ao banco quando alguém RODA o arquivo. Importado por um teste, ele
// oferece as funções e não abre conexão nenhuma.
if (require.main === module) main();

module.exports = { importar, nomeLegivel, valor };
