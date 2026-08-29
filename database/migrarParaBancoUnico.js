#!/usr/bin/env node
/**
 * Migra de um banco por cliente para um banco só, com o campo `instance`.
 *
 *   node database/migrarParaBancoUnico.js            # ensaio: só conta e confere
 *   node database/migrarParaBancoUnico.js --escrever # copia de verdade
 *
 * O que ele NÃO faz, de propósito: apagar os bancos antigos. Eles ficam de pé,
 * sem ninguém lendo, e são a volta atrás se algo aparecer dias depois. Apagar é
 * um comando separado, dado por gente, depois de conferir na tela.
 *
 * ── A ORDEM, e por quê ─────────────────────────────────────────────────────
 *
 *   1. copia os documentos, cada um com `instance` gravado;
 *   2. só DEPOIS cria os índices.
 *
 * Invertido, um índice único recusaria o primeiro documento e a migração pararia
 * no meio. Nesta ordem, uma colisão aparece na criação do índice — de uma vez, com
 * a mensagem do Mongo dizendo qual chave duplicou — e os dados copiados continuam
 * lá para eu olhar. Foi por isso que conferi os e-mails ANTES de escrever isto:
 * dois já existiam em duas academias cada, e é o que obrigou `users.email` a ser
 * único por (instance, email) em vez de global.
 */
require("dotenv").config();

const mongodb = require("../config/mongodb.js");
const ensureSchema = require("./schema.js");
const instanceContext = require("../lib/instance.js");
const { POR_INSTANCIA } = ensureSchema;

const ESCREVER = process.argv.includes("--escrever");
const LOTE = 500;

function baseDoNome() {
  return mongodb.nomeDoBanco();
}

// Quais bancos antigos existem. Vem do SERVIDOR e não do registro central: um
// cliente pode ter sido removido do registro e ainda ter banco, e deixar o dado
// dele para trás sem dizer nada seria pior que copiar de mais.
async function bancosDeCliente() {
  const cliente = mongodb.client();
  const admin = cliente.db("admin");
  const { databases } = await admin.command({ listDatabases: 1, nameOnly: true });

  const base = baseDoNome();
  const prefixo = `${base}_`;

  return databases
    .map((d) => d.name)
    .filter((n) => n.startsWith(prefixo))
    // `_center` é o banco compartilhado, não é cliente.
    .filter((n) => n !== `${base}_center`)
    .map((n) => ({ banco: n, instance: n.slice(prefixo.length) }))
    // O nome tem de passar pela mesma validação que o resto do sistema usa;
    // um banco com nome estranho não vira `instance` sem alguém olhar.
    .filter(({ instance, banco }) => {
      const ok = instanceContext.normalize(instance) === instance;
      if (!ok) console.warn(`[migrar] IGNORADO — nome inválido para instance: ${banco}`);
      return ok;
    });
}

async function jaMigrado(destino) {
  for (const nome of POR_INSTANCIA) {
    const n = await destino.collection(nome).countDocuments({ instance: { $exists: true } });
    if (n > 0) return { colecao: nome, docs: n };
  }
  return null;
}

async function copiar(origem, destino, instance) {
  const porColecao = {};

  const existentes = (await origem.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  for (const nome of POR_INSTANCIA) {
    if (!existentes.includes(nome)) continue;

    const cursor = origem.collection(nome).find({});
    let lote = [];
    let copiados = 0;

    const descarregar = async () => {
      if (!lote.length) return;
      if (ESCREVER) await destino.collection(nome).insertMany(lote, { ordered: false });
      copiados += lote.length;
      lote = [];
    };

    for await (const doc of cursor) {
      // O `_id` é PRESERVADO. ObjectId é único global, então não há colisão ao
      // juntar clientes — e preservar é obrigatório, não conveniência: metade dos
      // documentos referencia outro por `_id` (treino aponta para pessoa, foto
      // aponta para avaliação). Gerar id novo quebraria todos esses vínculos.
      lote.push({ ...doc, instance });
      if (lote.length >= LOTE) await descarregar();
    }
    await descarregar();

    if (copiados) porColecao[nome] = copiados;
  }

  return porColecao;
}

// Confere pelo NÚMERO, e por cliente e collection: uma soma total igual pode
// esconder dois erros que se cancelam.
async function conferir(bancos, destino) {
  const problemas = [];

  for (const { banco, instance } of bancos) {
    const origem = mongodb.client().db(banco);
    const existentes = (await origem.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

    for (const nome of POR_INSTANCIA) {
      if (!existentes.includes(nome)) continue;
      const antes = await origem.collection(nome).countDocuments({});
      const depois = await destino.collection(nome).countDocuments({ instance });
      if (antes !== depois) problemas.push(`${instance}.${nome}: origem ${antes} != destino ${depois}`);
    }
  }

  return problemas;
}

(async () => {
  const destino = await mongodb.bancoCruSemEscopo();
  const bancos = await bancosDeCliente();

  console.log(`\n[migrar] destino: ${baseDoNome()}`);
  console.log(`[migrar] bancos de cliente encontrados: ${bancos.length}`);
  for (const b of bancos) console.log(`           ${b.banco}  ->  instance="${b.instance}"`);

  const ja = await jaMigrado(destino);
  if (ja) {
    console.error(
      `\n[migrar] ABORTADO: o destino já tem dado migrado ` +
        `(${ja.colecao}: ${ja.docs} documentos com \`instance\`).\n` +
        `         Rodar de novo duplicaria tudo. Para refazer, esvazie o destino primeiro.`
    );
    await mongodb.close();
    process.exit(1);
  }

  let total = 0;
  const porInstancia = {};

  for (const { banco, instance } of bancos) {
    const origem = mongodb.client().db(banco);
    const contagens = await copiar(origem, destino, instance);
    porInstancia[instance] = contagens;
    const soma = Object.values(contagens).reduce((a, b) => a + b, 0);
    total += soma;
    console.log(`\n[migrar] ${instance}: ${soma} documentos`);
    for (const [col, n] of Object.entries(contagens)) console.log(`           ${col}: ${n}`);
  }

  console.log(`\n[migrar] total: ${total} documentos`);

  if (!ESCREVER) {
    console.log("\n[migrar] ENSAIO — nada foi escrito. Rode com --escrever para valer.");
    await mongodb.close();
    return;
  }

  // Os índices, depois dos dados. Uma colisão aparece aqui, de uma vez.
  console.log("\n[migrar] criando collections e índices no banco único...");
  await ensureSchema.ensureDados({ mongodb });
  console.log("[migrar] índices prontos");

  const problemas = await conferir(bancos, destino);
  if (problemas.length) {
    console.error("\n[migrar] CONFERÊNCIA FALHOU:");
    for (const p of problemas) console.error("   " + p);
    await mongodb.close();
    process.exit(1);
  }

  console.log("\n[migrar] conferência ok — origem e destino batem em toda collection de todo cliente");
  console.log("[migrar] os bancos antigos NÃO foram tocados; são a volta atrás.");
  await mongodb.close();
})().catch(async (err) => {
  console.error("\n[migrar] estourou:", err.message);
  try {
    await mongodb.close();
  } catch {}
  process.exit(1);
});
