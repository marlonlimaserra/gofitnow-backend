require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

// MANDAR O BACKUP PARA FORA DA MÁQUINA.
//
// Chamado por /usr/local/bin/backup-mongo.sh, que já dumpa todo dia às 03:00 e
// já guardava 14 dias — só que **no mesmo disco do banco**. Um backup no mesmo
// disco protege contra comando errado e não protege contra o disco morrer, que é
// justamente o caso em que ele importa.
//
// ── Por que Node e não o `aws` ────────────────────────────────────────────
//
// O script nasceu chamando `aws s3 cp`. O Debian desta máquina não tem pacote
// `awscli`, e instalar a v2 pelo zip oficial são ~100 MB para copiar um arquivo.
// O `@aws-sdk/client-s3` já está aqui, instalado para lib/arquivos.js, e lê o
// mesmo `.env`. Menos peça, menos coisa para envelhecer.
//
// ── STREAM, e não o arquivo na memória ────────────────────────────────────
//
// São 113 MB numa máquina de 4 GB, e ela roda o Mongo, dois Node e o Chrome do
// PDF. Ler o arquivo inteiro para a RAM às 3 da manhã é o tipo de coisa que
// funciona por meses e derruba o servidor no dia em que o backup crescer.
// `ContentLength` explícito é o que permite o stream num PUT só.
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

const BALDE = process.env.R2_BUCKET;
// A pasta dos backups, escolhida por ele: "crie a pasta lá chamada backup, aí
// você guarda os zips".
const PREFIXO = "backup/";
const GUARDAR_DIAS = Number(process.env.BACKUP_R2_DIAS || 30);

const arquivo = process.argv[2];

if (!arquivo || !fs.existsSync(arquivo)) {
  console.error("uso: node database/enviarBackup.js <arquivo>");
  process.exit(1);
}

if (!process.env.R2_ACCESS_KEY_ID || !BALDE) {
  // Sai com 0: sem R2 configurado, o backup local já aconteceu e o script que
  // chamou isto não deve morrer por causa da cópia. O aviso é do chamador.
  console.log("R2 não configurado — a cópia fica só neste disco.");
  process.exit(0);
}

const s3 = new S3Client({
  region: "auto",
  endpoint:
    process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

(async () => {
  const nome = path.basename(arquivo);
  const tamanho = fs.statSync(arquivo).size;

  await s3.send(
    new PutObjectCommand({
      Bucket: BALDE,
      Key: PREFIXO + nome,
      Body: fs.createReadStream(arquivo),
      ContentLength: tamanho,
      ContentType: "application/gzip",
    })
  );

  console.log(`enviado ${PREFIXO}${nome} (${(tamanho / 1048576).toFixed(0)} MB)`);

  // ── A LIMPEZA DO LADO DE LÁ ─────────────────────────────────────────────
  //
  // O script limpa o disco local; sem esta parte, o R2 acumularia para sempre.
  // Trinta dias e não quatorze: o espaço lá é barato e o histórico mais longo é
  // o que salva de um estrago que ninguém notou na primeira semana.
  //
  // Por DATA do próprio objeto, e não pelo nome: nome é convenção e pode mudar;
  // `LastModified` é fato.
  const limite = Date.now() - GUARDAR_DIAS * 86400000;
  const velhos = [];
  let token;

  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: BALDE, Prefix: PREFIXO, ContinuationToken: token })
    );
    for (const o of r.Contents || []) {
      if (new Date(o.LastModified).getTime() < limite) velhos.push({ Key: o.Key });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  if (velhos.length) {
    await s3.send(
      new DeleteObjectsCommand({ Bucket: BALDE, Delete: { Objects: velhos, Quiet: true } })
    );
    console.log(`apagados ${velhos.length} backup(s) com mais de ${GUARDAR_DIAS} dias`);
  }

  process.exit(0);
})().catch((erro) => {
  // Falha na cópia NÃO é falha do backup: o arquivo local já existe e presta.
  // Sair com erro faria o `set -e` do script matar a limpeza e, no dia seguinte,
  // o disco encher.
  console.error("a cópia para o R2 falhou:", erro.message);
  process.exit(0);
});
