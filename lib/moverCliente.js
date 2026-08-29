const { ObjectId } = require("mongodb");

const ensureSchema = require("../database/schema.js");
const destinos = require("./destinos.js");
const { POR_INSTANCIA } = ensureSchema;

// MOVER UM CLIENTE DE BANCO.
//
// É o que faz "deixar dedicado" ser um botão em vez de uma noite de trabalho.
//
// ── A ORDEM, e o que cada passo protege ───────────────────────────────────
//
//   1. PREPARA o destino: collections e índices. Copiar para um banco sem índice
//      funciona e deixa o cliente lento até alguém notar.
//   2. COPIA os documentos, com o `_id` preservado. Preservar é obrigatório, não
//      conveniência: metade dos documentos referencia outro por `_id` (treino
//      aponta para pessoa, foto aponta para avaliação), e id novo quebraria todos
//      esses vínculos.
//   3. CONFERE por número, collection por collection. Uma soma total igual pode
//      esconder dois erros que se cancelam.
//   4. VIRA o ponteiro no registro, e só então.
//   5. ESQUECE o cache, para a mudança valer na requisição seguinte.
//   6. COPIA A SOBRA: o que nasceu no banco antigo entre o passo 2 e o 4.
//
// ── O QUE ESTA FUNÇÃO NÃO RESOLVE, e é honesto dizer ─────────────────────
//
// Documento ALTERADO durante a cópia. Um documento criado no meio do caminho é
// pego pelo passo 6 (ele não existe no destino, então entra); um documento que
// já existia e foi EDITADO nesse intervalo chega ao destino com o valor antigo, e
// o passo 6 não sabe distinguir.
//
// A janela é de segundos, e quem aperta este botão escolhe quando. Fechá-la de
// verdade exigiria bloquear a escrita do cliente durante a cópia — o que é o
// próximo passo se algum dia mover um cliente grande em horário cheio.
//
// Nada é APAGADO do banco de origem. Os documentos antigos ficam, e são a volta
// atrás: apontar o cliente de volta é uma escrita só.
const LOTE = 500;

async function mover(app, { instancia, destinoId }) {
  const central = await app.mongodb.centralDb();

  const registro = await central.collection("instances").findOne({ instance: instancia });
  if (!registro) return { erro: "instancia_nao_registrada" };

  if (!ObjectId.isValid(String(destinoId))) return { erro: "destino_invalido" };
  const alvo = await central
    .collection("databases")
    .findOne({ _id: new ObjectId(String(destinoId)) });
  if (!alvo) return { erro: "destino_nao_encontrado" };

  // De onde ele sai HOJE. Resolvido pela mesma função que o produto usa, para não
  // haver duas ideias de "onde este cliente mora".
  const atual = await destinos.destinoDe(
    instancia,
    central,
    process.env.MONGODB_URI
  );

  const alvoBanco = destinos.nomeDoBancoNaUri(alvo.uri);
  if (!alvoBanco) return { erro: "destino_sem_nome_de_banco" };

  if (atual.uri === alvo.uri) {
    // Já está lá. Não é erro, e dizer que é faria a tela mostrar vermelho para
    // quem clicou duas vezes.
    return { ok: true, intocado: true, banco: alvoBanco };
  }

  const origemDb = await app.mongodb.bancoCruSemEscopo(atual.uri);
  const destinoDb = await app.mongodb.bancoCruSemEscopo(alvo.uri);

  // 1. o destino precisa estar pronto ANTES de receber documento.
  await ensureSchema.ensureUmBanco(destinoDb);

  // 2. a cópia
  const copiados = await copiar(origemDb, destinoDb, instancia);

  // 3. a conferência
  const problemas = await conferir(origemDb, destinoDb, instancia);
  if (problemas.length) {
    // O ponteiro NÃO vira. O cliente continua atendido pelo banco antigo, e o que
    // foi copiado fica no destino sem incomodar ninguém — ele só passa a ser lido
    // quando o ponteiro virar.
    return { erro: "conferencia_falhou", problemas };
  }

  // 4. o ponteiro
  await central
    .collection("instances")
    .updateOne(
      { instance: instancia },
      { $set: { database: String(alvo._id), bancoMudadoEm: new Date() } }
    );

  // 5. o cache
  destinos.esquecer(instancia);

  // 6. a sobra — o que nasceu na origem enquanto a cópia rodava.
  const sobra = await copiar(origemDb, destinoDb, instancia, { soFaltantes: true });

  return {
    ok: true,
    banco: alvoBanco,
    de: atual.nome,
    para: alvo.nome,
    copiados,
    sobra,
    total: Object.values(copiados).reduce((a, b) => a + b, 0),
  };
}

async function copiar(origem, destino, instancia, { soFaltantes = false } = {}) {
  const porColecao = {};
  const existentes = (await origem.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  for (const nome of POR_INSTANCIA) {
    if (!existentes.includes(nome)) continue;

    const cursor = origem.collection(nome).find({ instance: instancia });
    let lote = [];
    let n = 0;

    const descarregar = async () => {
      if (!lote.length) return;
      // `ordered: false` para um documento repetido não parar o lote. Repetido
      // acontece na passada da SOBRA, quando alguém já copiou parte à mão.
      try {
        await destino.collection(nome).insertMany(lote, { ordered: false });
      } catch (error) {
        // Chave duplicada é esperado na segunda passada: o documento já está lá.
        // Qualquer outro erro sobe.
        if (error?.code !== 11000 && !error?.writeErrors?.every((e) => e.err?.code === 11000)) throw error;
      }
      n += lote.length;
      lote = [];
    };

    for await (const doc of cursor) {
      if (soFaltantes) {
        const ja = await destino.collection(nome).findOne({ _id: doc._id }, { projection: { _id: 1 } });
        if (ja) continue;
      }
      lote.push(doc);
      if (lote.length >= LOTE) await descarregar();
    }
    await descarregar();

    if (n) porColecao[nome] = n;
  }

  return porColecao;
}

async function conferir(origem, destino, instancia) {
  const problemas = [];
  const existentes = (await origem.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  for (const nome of POR_INSTANCIA) {
    if (!existentes.includes(nome)) continue;
    const antes = await origem.collection(nome).countDocuments({ instance: instancia });
    const depois = await destino.collection(nome).countDocuments({ instance: instancia });
    if (antes !== depois) problemas.push(`${nome}: origem ${antes} != destino ${depois}`);
  }

  return problemas;
}

module.exports = { mover, copiar, conferir };
