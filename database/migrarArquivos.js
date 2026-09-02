require("dotenv").config();

const mongodb = require("../config/mongodb.js");
const arquivos = require("../lib/arquivos.js");

// MOVER OS BINÁRIOS DO MONGO PARA O R2.
//
// 151 MB de bytes moravam dentro do banco: fotos de alimento (130 MB), clipes de
// exercício (12 MB), fotos de avaliação, avatares, imagens de marca e de receita.
// Contra 6 MB de dados de verdade.
//
// ── SEM PARADA, e é o desenho que garante isso ────────────────────────────
//
// A leitura já sabe os dois lugares (`arquivos.bytesDoDocumento`: chave primeiro,
// campo do banco depois). Então este script pode rodar com o sistema no ar, um
// documento por vez, e a cada documento migrado o produto passa a servir aquele
// do R2 sem reiniciar nada.
//
// ── E NÃO APAGA OS BYTES DO BANCO ─────────────────────────────────────────
//
// Só ACRESCENTA a chave. O `data` fica onde está.
//
// É de propósito, e é a diferença entre uma migração que dá para desfazer e uma
// que não. Enquanto o campo antigo existe, tirar o R2 do ar é apagar uma
// variável de ambiente. Depois de conferir que está tudo servindo do bucket, o
// `--limpar` apaga os campos — e aí sim o espaço volta.
//
// uso:
//   node database/migrarArquivos.js            confere e mostra o que falta
//   node database/migrarArquivos.js --subir     sobe o que falta
//   node database/migrarArquivos.js --limpar    apaga os bytes do banco JÁ MIGRADOS

// Cada coleção: onde ela mora, qual campo tem os bytes, e como sai a chave.
//
// `pasta` sai de `arquivos.PASTAS` — não é texto solto aqui, senão um typo criaria
// uma pasta paralela que ninguém acha.
const ALVOS = [
  // ── O CATÁLOGO, na pasta `gofitnow/` ────────────────────────────────────
  //
  // Os mesmos bytes para todo cliente. É por isso que 130 MB de foto de alimento
  // não viram 130 MB vezes o número de clientes.
  {
    nome: "food_images",
    central: true,
    campo: "data",
    chave: (d) => arquivos.chaveNossa("alimentos", String(d.key || d._id)),
  },
  {
    nome: "exercise_clips",
    central: true,
    campo: "webp",
    chave: (d) => arquivos.chaveNossa("clipes", String(d._id) + ".webp"),
  },
  {
    nome: "recipe_images",
    central: true,
    campo: "data",
    chave: (d) => arquivos.chaveNossa("receitas", String(d._id)),
  },
  {
    nome: "doc_images",
    central: true,
    campo: "data",
    chave: (d) => arquivos.chaveNossa("documentos", String(d._id)),
  },
  {
    nome: "all_avatars",
    central: true,
    campo: "data",
    chave: (d) => arquivos.chaveNossa("painel", String(d.user || d._id)),
  },

  // ── O DE CADA CLIENTE, na pasta dele ────────────────────────────────────
  //
  // A instância sai do DOCUMENTO (`d.instance`), e não do contexto: este script
  // roda fora de requisição. Documento sem instância é pulado e contado — melhor
  // deixar no banco que gravar na pasta errada.
  {
    nome: "assessment_photos",
    campo: "data",
    chave: (d) => arquivos.chaveDeClienteDito(d.instance, "avaliacoes", String(d.assessment), d.side),
  },
  {
    nome: "avatars",
    campo: "data",
    chave: (d) => arquivos.chaveDeClienteDito(d.instance, "avatares", String(d.user)),
  },
  {
    nome: "brand_images",
    campo: "data",
    chave: (d) => arquivos.chaveDeClienteDito(d.instance, "marca", String(d._id)),
  },
];

const subir = process.argv.includes("--subir");
const limpar = process.argv.includes("--limpar");

function mb(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

(async () => {
  if ((subir || limpar) && !arquivos.ligado()) {
    console.error("R2 não configurado — veja R2_* no .env.example. Nada foi feito.");
    process.exit(1);
  }

  const central = await mongodb.centralDb();
  const proprio = await mongodb.bancoCruSemEscopo();

  let totalBytes = 0;
  let totalFalta = 0;

  for (const alvo of ALVOS) {
    const db = alvo.central ? central : proprio;
    const col = db.collection(alvo.nome);

    const comBytes = { [alvo.campo]: { $exists: true, $ne: null } };
    const jaTem = await col.countDocuments({ chave: { $exists: true } });
    const faltam = await col.countDocuments({ ...comBytes, chave: { $exists: false } });

    let bytes = 0;
    let subidos = 0;
    let pulados = 0;

    if (subir) {
      // Um por vez, e com `projection` completa: são 2.499 fotos de alimento, e
      // carregar tudo na memória de uma máquina de 4 GB é como se derruba o
      // servidor tentando arrumá-lo.
      const cursor = col.find({ ...comBytes, chave: { $exists: false } });

      while (await cursor.hasNext()) {
        const doc = await cursor.next();

        let chave;
        try {
          chave = alvo.chave(doc);
        } catch (erro) {
          // Documento sem instância, ou com id que não passa na régua da chave.
          pulados += 1;
          continue;
        }

        const conteudo = arquivos.paraBuffer(doc[alvo.campo]);
        const gravou = await arquivos.guardar(chave, conteudo, doc.mime || "application/octet-stream");

        // NÃO grava a chave se o R2 recusou: um documento apontando para um
        // arquivo que não existe é pior que um documento antigo.
        if (!gravou) {
          pulados += 1;
          continue;
        }

        await col.updateOne({ _id: doc._id }, { $set: { chave } });
        bytes += conteudo.length;
        subidos += 1;
      }
    } else {
      const soma = await col
        .aggregate([{ $match: { ...comBytes, chave: { $exists: false } } }, { $group: { _id: null, b: { $sum: "$size" } } }])
        .toArray();
      bytes = soma[0]?.b || 0;
    }

    let limpos = 0;
    if (limpar) {
      // Só onde a chave existe. É a garantia de nunca apagar bytes que não
      // subiram.
      const r = await col.updateMany(
        { chave: { $exists: true }, [alvo.campo]: { $exists: true } },
        { $unset: { [alvo.campo]: "" } }
      );
      limpos = r.modifiedCount;
    }

    totalBytes += bytes;
    totalFalta += faltam - subidos;

    const partes = [alvo.nome.padEnd(20), `já no R2: ${String(jaTem).padStart(5)}`, `faltando: ${String(faltam).padStart(5)}`];
    if (subir) partes.push(`subidos: ${subidos}`, `pulados: ${pulados}`, mb(bytes));
    else partes.push(mb(bytes));
    if (limpar) partes.push(`limpos no banco: ${limpos}`);

    console.log("  " + partes.join("  "));
  }

  console.log("");
  console.log(subir ? `subiu ${mb(totalBytes)} | ainda faltam ${totalFalta}` : `${mb(totalBytes)} a subir`);
  if (!subir && !limpar) console.log("nada foi alterado — rode com --subir");

  await mongodb.close?.();
  process.exit(0);
})().catch((erro) => {
  console.error("falhou:", erro.message);
  process.exit(1);
});
