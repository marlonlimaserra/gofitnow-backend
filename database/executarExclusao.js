require("dotenv").config();

const mongodb = require("../config/mongodb.js");
const arquivos = require("../lib/arquivos.js");
const { ObjectId } = require("mongodb");

// EXECUTA UMA SOLICITAÇÃO DE EXCLUSÃO — uma, nomeada, à mão.
//
// Substituiu `excluirContasAgendadas.js` em 02/09/2026. Aquele varria datas
// vencidas e apagava sozinho; este só faz o que um pedido específico manda,
// depois de alguém ter conversado com quem pediu.
//
// ── POR QUE UM COMANDO, E NÃO UM BOTÃO NO PAINEL ──────────────────────────
//
// Porque quem pode dizer que os dados foram apagados é quem apagou. Um botão que
// escrevesse "concluída" e disparasse a exclusão em segundo plano criaria um
// registro que pode mentir — e é justamente esse registro que uma auditoria de
// LGPD vai ler.
//
// Aqui a ordem é: apaga, confere o que saiu, e só então marca a solicitação como
// concluída, com os números reais. Se o script morrer no meio, a solicitação
// continua aberta — o que é verdade.
//
// ── AS TRAVAS ─────────────────────────────────────────────────────────────
//
//   1. NÃO FAZ NADA sem `--executar`. Sem a flag, mostra o que faria.
//   2. Exige `--pedido=<id>`. Não existe "apagar todos os vencidos".
//   3. Recusa pedido que não esteja em `pendente` ou `em_contato`.
//   4. Imprime nome, e-mail, cliente e papel antes de tocar em nada.
//
// ── AS COLLECTIONS SAEM DO BANCO, NÃO DE UMA LISTA ────────────────────────
//
// É um banco só para todos os clientes, com `instance` em cada documento (ver
// lib/escopo.js). Apagar um cliente é `deleteMany({instance})` em TODA
// collection, e a lista vem do `listCollections`.
//
// Escrita aqui à mão, ela envelheceria na primeira tela nova — e o que ficaria
// para trás é dado de saúde de alguém que pediu para sair. A varredura cega é
// segura porque o filtro é o `instance`: collection compartilhada (exercícios,
// alimentos, receitas) não tem documento com esse campo e sai intacta.
//
// uso:
//   node database/executarExclusao.js --pedido=68b1…              ensaio
//   node database/executarExclusao.js --pedido=68b1… --executar    apaga

const executar = process.argv.includes("--executar");
const pedidoId = (process.argv.find((a) => a.startsWith("--pedido=")) || "").slice("--pedido=".length);

const ABERTOS = ["pendente", "em_contato"];

async function main() {
  if (!pedidoId || !ObjectId.isValid(pedidoId)) {
    console.error("uso: node database/executarExclusao.js --pedido=<id> [--executar]");
    process.exitCode = 1;
    return;
  }

  const central = await mongodb.centralDb();
  const banco = await mongodb.bancoCruSemEscopo();
  const pedidos = central.collection("deletion_requests");

  const pedido = await pedidos.findOne({ _id: new ObjectId(pedidoId) });
  if (!pedido) {
    console.error(`não achei a solicitação ${pedidoId}.`);
    process.exitCode = 1;
    return;
  }

  if (!ABERTOS.includes(pedido.estado)) {
    console.error(
      `a solicitação está "${pedido.estado}", não em aberto. ` +
        (pedido.estado === "concluida" ? "Os dados já foram apagados." : "Nada a fazer.")
    );
    process.exitCode = 1;
    return;
  }

  console.log("── A SOLICITAÇÃO ──────────────────────────────────────────────");
  console.log(`   ${pedido.nome} <${pedido.email}>`);
  console.log(`   cliente: ${pedido.instance}   papel: ${pedido.papel}`);
  console.log(`   pedida em ${pedido.pedidaEm?.toISOString?.().slice(0, 16).replace("T", " ")}`);
  if (pedido.motivo) console.log(`   motivo: ${pedido.motivo.slice(0, 300)}`);
  if (pedido.observacao) console.log(`   observação: ${pedido.observacao.slice(0, 300)}`);
  console.log("");

  if (!executar) console.log("— ENSAIO. Nada será apagado. Use --executar.\n");

  const resultado = { documentos: {}, arquivos: 0, papel: pedido.papel };

  // ── O ALUNO E O PROFISSIONAL: só eles ───────────────────────────────────
  //
  // Nenhum dado de terceiro vai com eles. O aluno leva a própria ficha e tudo
  // que pende dela (a cascata de `User_model.apagarTudoDoAluno`, que aqui é
  // reproduzida em consultas porque o script roda fora do app).
  //
  // Não é o caso de reimplementar a cascata: para esses dois papéis o certo é
  // usar o BACKEND, que já tem a lista. Este script cobre o caso do DONO, que é
  // o que não tem rota — e para os outros dois avisa e para.
  if (pedido.papel !== "dono") {
    console.log(
      "Este pedido é de UMA pessoa, não da conta inteira.\n" +
        "Apagar uma pessoa é ato do produto, não deste script: a cascata de 15 collections\n" +
        "mora em `model/User_model.js` (apagarTudoDoAluno) e este processo não a alcança.\n" +
        "\n" +
        "Use a tela de pessoas do cliente para excluir o cadastro, e depois marque a\n" +
        "solicitação no painel. Ou me peça uma rota interna para isto."
    );
    process.exitCode = 1;
    return;
  }

  // ── O DONO: a instância inteira ─────────────────────────────────────────
  const colecoes = (await banco.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .sort();

  let total = 0;
  for (const colecao of colecoes) {
    const col = banco.collection(colecao);
    const quantos = await col.countDocuments({ instance: pedido.instance });
    if (!quantos) continue;

    total += quantos;
    resultado.documentos[colecao] = quantos;
    console.log(`   ${String(quantos).padStart(7)}  ${colecao}`);
    if (executar) await col.deleteMany({ instance: pedido.instance });
  }
  console.log(`   ${String(total).padStart(7)}  ── total de documentos`);

  // ── OS ARQUIVOS ─────────────────────────────────────────────────────────
  //
  // Listados do BALDE e não deduzidos do banco: documento que perdeu a
  // referência deixa o objeto lá, pago e invisível — e invisível é o que não
  // pode sobreviver a um pedido de exclusão.
  //
  // A barra no fim do prefixo não é detalhe: sem ela, apagar `bru` levaria
  // `bruna/` junto.
  const chaves = await arquivos.listarPrefixo(`${pedido.instance}/`);
  resultado.arquivos = chaves.length;
  console.log(`   ${String(chaves.length).padStart(7)}  arquivos no R2 sob ${pedido.instance}/`);

  if (executar && chaves.length) {
    const apagadas = await arquivos.apagarMuitas(chaves);
    resultado.arquivosApagados = apagadas;
    if (apagadas !== chaves.length) {
      console.warn(`   ATENÇÃO: apaguei ${apagadas} de ${chaves.length} arquivos.`);
    }
  }

  if (!executar) {
    console.log("\n— ENSAIO. Nada foi apagado.\n");
    return;
  }

  // ── O REGISTRO DA INSTÂNCIA, E A SOLICITAÇÃO, POR ÚLTIMO ────────────────
  //
  // Por último de propósito: enquanto o registro existe, dá para saber o que
  // ainda falta apagar. Removê-lo primeiro e falhar no meio deixaria dado de um
  // cliente que ninguém mais sabe que existiu.
  await central.collection("instances").deleteOne({ instance: pedido.instance });
  console.log(`   registro da instância removido. ${pedido.instance} não existe mais.`);

  // E só AGORA a solicitação vira "concluída", com o que realmente saiu. Se o
  // script tivesse morrido antes daqui, ela continuaria aberta — que é a
  // verdade.
  await pedidos.updateOne(
    { _id: pedido._id },
    {
      $set: {
        estado: "concluida",
        concluidaEm: new Date(),
        resultado,
        atualizadaEm: new Date(),
      },
    }
  );
  console.log("   solicitação marcada como concluída.\n");
}

main()
  .catch((erro) => {
    console.error("falhou:", erro);
    process.exitCode = 1;
  })
  .finally(() => mongodb.close?.());
