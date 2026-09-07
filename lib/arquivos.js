const instanceContext = require("./instance.js");

// OS ARQUIVOS — fotos, clipes e documentos, fora do banco.
//
// ── Por que sair do Mongo ─────────────────────────────────────────────────
//
// Eles nasceram DENTRO dele, como `data: buffer` no documento. Funcionou e foi a
// escolha certa no começo: um lugar só, backup junto, permissão já resolvida.
//
// Medido em 30/08/2026: 151 MB de binário no banco, contra 6 MB de dados de
// verdade. Numa máquina de um núcleo e 4 GB, isso é o Mongo gastando memória
// para cachear bytes de imagem em vez de índice, e todo backup arrastando 151 MB
// para copiar 6. E o que cresce é justamente foto: 217 KB cada, quatro ângulos
// por coleta, quatro coletas por ano, por pessoa.
//
// ── R2, e não S3 ──────────────────────────────────────────────────────────
//
// Mesma API (o cliente da AWS fala com ele sem adaptação), e **egress zero** —
// que era a preocupação do Marlon com a Amazon. Trazer um arquivo do R2 para
// este servidor não custa banda.
//
// ── NADA É PÚBLICO NO R2 ──────────────────────────────────────────────────
//
// "Quando o cliente solicitar alguma coisa vai ter que passar pelo backend para
// ter autenticação, então não quero nada com URL pública."
//
// Então o bucket não tem domínio, não tem acesso anônimo, e este módulo NÃO
// gera URL assinada. Quem serve os bytes são as mesmas rotas de hoje, com a
// mesma permissão que já aplicam — o R2 entra só no lugar do `doc.data`.
//
// Uma URL assinada, mesmo curta, é um link que sai do nosso controle e funciona
// sem sessão enquanto durar. Não ter essa porta é mais simples do que decidir
// quantos segundos ela pode ficar aberta.
//
// (Duas rotas continuam públicas, e não é descuido: a logo da marca, porque a
// tela de login precisa dela ANTES de existir sessão, e os clipes de exercício,
// que são o nosso catálogo e iguais para todo mundo. Elas já eram públicas antes
// disto; o que muda é de onde os bytes saem.)
//
// ── LIGA SOZINHO, E DESLIGADO NÃO ATRAPALHA ───────────────────────────────
//
// Sem as variáveis de ambiente, `ligado()` é falso e toda função devolve `null`.
// Quem chama cai no caminho antigo, o do banco. É o que permite este código
// existir em produção antes de o bucket existir — e é o que mantém o sistema de
// pé se o R2 sair do ar durante uma escrita.
const ENDPOINT = process.env.R2_ENDPOINT || "";
const CONTA = process.env.R2_ACCOUNT_ID || "";
const CHAVE = process.env.R2_ACCESS_KEY_ID || "";
const SEGREDO = process.env.R2_SECRET_ACCESS_KEY || "";
const BALDE = process.env.R2_BUCKET || "";

// A PASTA DO QUE É NOSSO.
//
// O catálogo compartilhado — fotos de alimento, clipes de exercício, imagens de
// receita — é o mesmo byte para todo cliente. Ele mora numa pasta só, e é por
// isso que 130 MB de foto de alimento não viram 130 MB por cliente.
const NOSSA = "gofitnow";

// As pastas, escritas aqui e em nenhum outro lugar.
//
// Lista fechada pelo mesmo motivo da lista de limites do plano: pasta de nome
// livre convida a typo, e um `avaliacoes` gravado como `avaliacaoes` é um
// arquivo que ninguém acha e nada apaga.
const PASTAS = {
  avaliacoes: "avaliacoes",
  avatares: "avatares",
  marca: "marca",
  alimentos: "alimentos",
  clipes: "clipes",
  receitas: "receitas",
  documentos: "documentos",
  painel: "painel",
  // As fotos dos cartões da casa do aluno — uma por destino do menu.
  cartoes: "cartoes",
  // Os anexos dos chamados de suporte: imagem, áudio e PDF.
  tickets: "tickets",
};

function ligado() {
  return Boolean((ENDPOINT || CONTA) && CHAVE && SEGREDO && BALDE);
}

// O cliente entra por `require` preguiçoso, dentro de try.
//
// Mesma regra do puppeteer neste projeto: um `require` no topo transformaria
// "dependência não instalada" em "servidor não sobe". Um módulo de arquivos não
// pode ser o motivo de o produto não abrir.
let s3 = null;
let procurado = false;

function cliente() {
  if (procurado) return s3;
  procurado = true;

  if (!ligado()) return null;

  try {
    const { S3Client } = require("@aws-sdk/client-s3");

    s3 = new S3Client({
      // "auto" é o que o R2 espera: ele não tem região no sentido da AWS, e
      // mandar `us-east-1` funciona por acidente até parar de funcionar.
      region: "auto",
      endpoint: ENDPOINT || `https://${CONTA}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: CHAVE, secretAccessKey: SEGREDO },
    });
  } catch (erro) {
    console.warn("[arquivos] @aws-sdk/client-s3 ausente — os arquivos seguem no banco.");
    s3 = null;
  }

  return s3;
}

// ── O NOME DO ARQUIVO ─────────────────────────────────────────────────────
//
// Um pedaço de nome que veio de fora não pode virar caminho. `..` sobe de pasta,
// `/` cria pasta, e um dos dois num id mal validado é um cliente escrevendo na
// pasta de outro. O que não for letra, número, ponto, hífen ou sublinhado é
// recusado — e recusado com erro, não sanitizado em silêncio: um id que não
// passa nesta régua é sintoma de outro defeito, e limpá-lo escondería a causa.
const PEDACO_VALIDO = /^[A-Za-z0-9._-]{1,120}$/;

function pedacos(partes) {
  const limpas = partes.map((p) => String(p ?? "").trim());

  for (const p of limpas) {
    if (!PEDACO_VALIDO.test(p)) throw new Error(`arquivos: pedaço de chave inválido: "${p}"`);
    // Ponto sozinho ou duplo passariam a régua acima e são exatamente o ataque.
    if (p === "." || p === "..") throw new Error("arquivos: pedaço de chave inválido");
  }

  return limpas.join("/");
}

function pasta(nome) {
  const p = PASTAS[nome];
  if (!p) throw new Error(`arquivos: pasta desconhecida: "${nome}"`);
  return p;
}

// ── A CHAVE DE UM CLIENTE ─────────────────────────────────────────────────
//
// O prefixo sai do CONTEXTO da requisição, nunca de um argumento.
//
// É a mesma decisão de `lib/escopo.js`, e pelo mesmo motivo: enquanto o cliente
// é parâmetro, existe um lugar onde alguém pode passar o errado — e esse lugar é
// achado por um bug, não por uma revisão. Vindo do contexto, escrever na pasta
// de outro cliente deixa de ser possível de expressar.
//
// Fora de um contexto de instância isto ESTOURA, e é de propósito: uma chave sem
// cliente cairia na raiz do bucket, misturada com a pasta nossa, e ninguém
// saberia de quem era.
function chaveDoCliente(nomeDaPasta, ...partes) {
  const instancia = instanceContext.required();
  return `${instancia}/${pasta(nomeDaPasta)}/${pedacos(partes)}`;
}

// ── A MESMA CHAVE, COM O CLIENTE DITO À MÃO ───────────────────────────────
//
// O nome é comprido de propósito, igual a `bancoCruSemEscopo` em
// config/mongodb.js: o uso é excepcional e tem de doer um pouco de escrever.
//
// Existe para a MIGRAÇÃO, que roda fora de qualquer requisição e por isso não
// tem contexto de instância. Ela lê o cliente do próprio documento — o campo
// `instance` que `lib/escopo.js` mantém em toda linha do banco.
//
// Nenhuma rota deve chamar isto. Dentro de uma requisição existe contexto, e
// usar o contexto é o que torna "escrever na pasta do cliente errado"
// impossível de expressar.
function chaveDeClienteDito(instancia, nomeDaPasta, ...partes) {
  const nome = String(instancia || "").trim();
  if (!PEDACO_VALIDO.test(nome)) throw new Error(`arquivos: instância inválida: "${nome}"`);

  return `${nome}/${pasta(nomeDaPasta)}/${pedacos(partes)}`;
}

// A chave do que é NOSSO — o catálogo, igual para todo cliente.
function chaveNossa(nomeDaPasta, ...partes) {
  return `${NOSSA}/${pasta(nomeDaPasta)}/${pedacos(partes)}`;
}

// ── GUARDAR ───────────────────────────────────────────────────────────────
//
// Devolve a chave quando gravou, ou `null` quando o R2 está desligado ou falhou.
// `null` é "não gravei" e quem chama tem de tratar: gravar a chave no banco sem
// os bytes existirem é o pior estado possível — o documento diz que a foto está
// lá, a rota devolve 404, e ninguém sabe por quê.
async function guardar(chave, bytes, mime) {
  const c = cliente();
  if (!c || !chave || !bytes) return null;

  try {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");

    await c.send(
      new PutObjectCommand({
        Bucket: BALDE,
        Key: chave,
        Body: bytes,
        ContentType: mime || "application/octet-stream",
      })
    );

    return chave;
  } catch (erro) {
    console.warn("[arquivos] não consegui guardar", chave, erro?.message);
    return null;
  }
}

// ── LER ───────────────────────────────────────────────────────────────────
//
// Devolve `{ bytes, mime }`, ou `null` — que significa "não achei aqui", e quem
// chama tenta o banco. É o que faz a migração acontecer sem parada: durante ela,
// metade dos arquivos está num lugar e metade no outro, e a leitura não sabe
// nem precisa saber qual.
async function ler(chave) {
  const c = cliente();
  if (!c || !chave) return null;

  try {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");

    const r = await c.send(new GetObjectCommand({ Bucket: BALDE, Key: chave }));

    // `transformToByteArray` junta o stream inteiro na memória, e aqui isso é o
    // certo: o maior arquivo do sistema tem 4 MB (o teto da foto de avaliação),
    // e quem chama precisa do Buffer completo para calcular o ETag antes de
    // responder. Streamar sem saber o conteúdo tiraria o 304, que é o que faz a
    // segunda visita não baixar nada.
    const bytes = Buffer.from(await r.Body.transformToByteArray());

    return { bytes, mime: r.ContentType || "application/octet-stream" };
  } catch (erro) {
    // Chave que não existe é caso NORMAL durante a migração, e não erro: só o
    // que não é "não achei" merece log.
    const nome = erro?.name || "";
    if (nome !== "NoSuchKey" && nome !== "NotFound") {
      console.warn("[arquivos] não consegui ler", chave, erro?.message);
    }
    return null;
  }
}

async function apagar(chave) {
  const c = cliente();
  if (!c || !chave) return false;

  try {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await c.send(new DeleteObjectCommand({ Bucket: BALDE, Key: chave }));
    return true;
  } catch (erro) {
    console.warn("[arquivos] não consegui apagar", chave, erro?.message);
    return false;
  }
}

// Apagar em lote. O R2 aceita mil por chamada; fatiar é responsabilidade daqui
// porque quem chama pensa em "as fotos desta coleta", não em lotes.
async function apagarMuitas(chaves) {
  const c = cliente();
  const lista = (chaves || []).filter(Boolean);
  if (!c || !lista.length) return 0;

  let apagadas = 0;

  try {
    const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");

    for (let i = 0; i < lista.length; i += 1000) {
      const fatia = lista.slice(i, i + 1000);
      const r = await c.send(
        new DeleteObjectsCommand({
          Bucket: BALDE,
          Delete: { Objects: fatia.map((Key) => ({ Key })), Quiet: true },
        })
      );
      apagadas += fatia.length - (r?.Errors?.length || 0);
    }
  } catch (erro) {
    console.warn("[arquivos] não consegui apagar o lote", erro?.message);
  }

  return apagadas;
}

// TODAS AS CHAVES sob um prefixo — `marlon/` devolve tudo daquele cliente.
//
// Existe para a exclusão de conta: apagar a instância tem de levar os arquivos
// dela, e o Mongo não é a lista completa. Documento que perdeu a referência (uma
// foto trocada antes da migração, um upload que falhou no meio) deixa o objeto
// no balde, pago e invisível — e "invisível" é exatamente o que não pode
// sobreviver a um pedido de exclusão.
//
// Pagina sozinha: o R2 devolve no máximo mil por vez, e um cliente com muitas
// avaliações passa disso fácil.
async function listarPrefixo(prefixo) {
  const c = cliente();
  const limpo = String(prefixo || "");
  // Prefixo vazio listaria o BALDE INTEIRO, incluindo os outros clientes e a
  // pasta `gofitnow`. Quem chama isto está a um passo de apagar o resultado.
  if (!c || !limpo) return [];

  const chaves = [];

  try {
    const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
    let token;

    do {
      const r = await c.send(
        new ListObjectsV2Command({ Bucket: BALDE, Prefix: limpo, ContinuationToken: token })
      );
      for (const o of r?.Contents || []) if (o?.Key) chaves.push(o.Key);
      token = r?.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  } catch (erro) {
    // Devolve o que juntou até aqui e deixa o chamador decidir. Numa exclusão
    // isso significa apagar o que se conseguiu enxergar e registrar que a lista
    // pode estar incompleta — melhor que abortar e não apagar nada.
    console.warn("[arquivos] não consegui listar " + limpo, erro?.message);
  }

  return chaves;
}

// ── O QUE VAI PARA O DOCUMENTO ────────────────────────────────────────────
//
// Os modelos guardam `data: buffer` no Mongo. A troca é só isto: quando o R2
// aceita os bytes, o documento passa a guardar a CHAVE e o `data` sai — é ele que
// a gente está tirando do banco.
//
// **Falhou o R2? Os bytes ficam no banco.** Gravar a chave sem os bytes
// existirem é o pior estado possível: o documento diz que a foto está lá, a rota
// devolve 404, e ninguém sabe por quê. Perder a economia de espaço é barato;
// perder a foto de alguém, não.
async function ondeGuardar(chave, bytes, mime) {
  const gravou = await guardar(chave, bytes, mime);

  if (gravou) return { set: { chave: gravou }, unset: { data: "" } };
  return { set: { data: bytes }, unset: { chave: "" } };
}

// Os bytes de um documento, venha ele de onde vier.
//
// É o que faz a migração acontecer SEM PARADA: durante ela metade dos arquivos
// está no R2 e metade no banco, e quem lê não sabe nem precisa saber qual. O dia
// em que o banco não tiver mais nenhum, este `if` some.
//
// A chave vem primeiro de propósito: um documento que tem as duas coisas é um
// documento a meio caminho da migração, e o R2 é o lado novo.
// `campo` existe porque o clipe de exercício guarda em `webp`, e não em `data`.
// Um segundo helper só para ele daria duas cópias da mesma decisão de ordem dos
// `if` — e é justamente essa decisão que eu já errei uma vez.
async function bytesDoDocumento(doc, campo = "data") {
  if (!doc) return null;

  if (doc.chave) {
    const achado = await ler(doc.chave);
    if (achado) return achado.bytes;
    // Tem chave e o R2 não devolveu. Cai no `data` se ele ainda existir — e se
    // não existir, devolve null, que a rota já trata como 404. Melhor um 404 que
    // um 500 numa foto.
  }

  if (!doc[campo]) return null;
  return paraBuffer(doc[campo]);
}

// ── A ORDEM DESTES TRÊS `if` NÃO É ESTILO ─────────────────────────────────
//
// Eu escrevi este trecho ao contrário na primeira vez, e teria corrompido TODA
// imagem servida pelo sistema:
//
//     return dado.buffer ? Buffer.from(dado.buffer) : dado;   // ERRADO
//
// Um `Buffer` do Node também tem `.buffer` — e ele aponta para o POOL de 8 KB
// que o Node compartilha entre buffers pequenos, não para os bytes deste. Então
// `Buffer.from(dado.buffer)` devolvia o pool inteiro: a foto de 11 bytes virava
// 8 KB de lixo com a foto perdida no meio. Um teste de e-mail pegou, porque o
// anexo saiu com o conteúdo de outra coisa.
//
// `Buffer.isBuffer` PRIMEIRO. Só depois o BSON Binary, cujo `.buffer` é um
// Buffer certinho — e aí a cópia é dos bytes que interessam.
//
// (Foi assim que `bytesDa`, em controllers/Assessment.js, sempre esteve escrito.
// Eu tinha o exemplo certo na frente e reescrevi errado.)
function paraBuffer(dado) {
  if (Buffer.isBuffer(dado)) return dado;

  // BSON Binary do driver do Mongo.
  if (Buffer.isBuffer(dado.buffer)) return Buffer.from(dado.buffer);

  // Qualquer outra vista sobre bytes: respeita o recorte, e não o pool.
  if (dado.byteLength !== undefined && dado.buffer) {
    return Buffer.from(dado.buffer, dado.byteOffset || 0, dado.byteLength);
  }

  return Buffer.from(dado);
}

module.exports = {
  ligado,
  paraBuffer,
  ondeGuardar,
  bytesDoDocumento,
  chaveDoCliente,
  chaveDeClienteDito,
  chaveNossa,
  guardar,
  ler,
  apagar,
  apagarMuitas,
  listarPrefixo,
  PASTAS,
  NOSSA,
};
