const instanceContext = require("../instance.js");

// JUNTAR OUTRA COLLECTION PARA PODER PERGUNTAR SOBRE ELA.
//
// *"quero condição de dieta, financeiro, avaliação física, aula coletiva,
// frequência, pendências — tudo"* (10/10/2026).
//
// ── POR QUE ISTO PRECISOU EXISTIR ────────────────────────────────────────
//
// Até aqui toda condição olhava um campo da PESSOA, e o filtro era um `$match`
// e pronto. A primeira exceção foi o status, que mora no vínculo — e ela foi
// resolvida com um `precisaDoVinculo` que manda o pipeline subir uma junção
// que ele JÁ construía por outros motivos.
//
// Seis domínios novos não cabem nessa solução: cada um tem a sua collection, o
// seu campo de pessoa e o seu recorte. Então a junção virou coisa que a
// CONDIÇÃO declara, e este arquivo é a fôrma.
//
// ── O CAMPO DA PESSOA MUDA DE NOME, E ISSO JÁ CUSTOU ─────────────────────
//
// `checkins` e `pendencies` chamam de `person`; `charges`, `assessments` e
// `diets` chamam de `student`. Apontar para o errado não dá erro: devolve
// lista vazia — que parece "ninguém tem cobrança em aberto", e não "procurei
// no lugar errado". Por isso cada condição diz o nome explicitamente, em vez
// de este arquivo adivinhar.
//
// ── UMA JUNÇÃO POR DOMÍNIO, MESMO COM CINCO CONDIÇÕES ────────────────────
//
// A `chave` é o que faz isso: três condições de frequência compartilham a
// mesma junção, e o pipeline a adiciona uma vez. Sem ela, "veio nos últimos 30
// dias E tem mais de 10 visitas" pagaria duas varreduras de `checkins` por
// pessoa da página.
//
// ── E O `instance` DENTRO DO `$lookup` ───────────────────────────────────
//
// `lib/escopo.js` injeta o cliente em toda consulta e NÃO alcança dentro de um
// `$lookup`: a sub-pipeline é outra consulta. Correção não depende disso (os
// ids são ObjectId, únicos globais), mas desempenho sim — sem ele, a junção
// varre os documentos de todos os clientes a cada pessoa da página. É a mesma
// nota que já está no `juntarVinculo`, pelo mesmo motivo.

// A fôrma: conta quantos, guarda a data mais recente e, quando pedido, soma um
// campo. Três perguntas cobrem quase tudo que se quer de um histórico —
// "tem?", "quando foi a última?" e "quanto dá?".
function porPessoa({ chave, de, pessoa = "person", data, dataMin, soma, lista, filtro }) {
  return {
    chave,
    estagios: ({ hoje, dia }) => [
      {
        $lookup: {
          from: de,
          let: { eu: "$_id" },
          pipeline: [
            {
              $match: {
                instance: instanceContext.required(),
                $expr: { $eq: ["$" + pessoa, "$$eu"] },
              },
            },
            // O recorte do domínio — "só as em aberto", "só as vigentes". Ele
            // recebe `hoje` porque vencimento e vigência são perguntas de
            // calendário, e a resposta muda todo dia.
            ...(filtro ? [{ $match: filtro(hoje, dia) }] : []),
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                ...(data ? { ultima: { $max: "$" + data } } : {}),
                // A mais ANTIGA. É o que responde "tem alguma vencida?" sem
                // uma segunda junção: a cobrança em aberto mais velha estar no
                // passado é exatamente isso.
                ...(dataMin ? { primeira: { $min: "$" + dataMin } } : {}),
                ...(soma ? { soma: { $sum: { $ifNull: ["$" + soma, 0] } } } : {}),
                // QUAIS, e não só quantos. `$addToSet` porque a pergunta é
                // "frequentou esta aula?", e frequentar quatro vezes não a
                // torna quatro aulas diferentes.
                ...(lista ? { lista: { $addToSet: "$" + lista } } : {}),
              },
            },
          ],
          as: "_" + chave,
        },
      },
      {
        $addFields: {
          // Zero e não ausente: "nunca veio" é uma RESPOSTA, e um campo que
          // não existe não casa com `$lt` nem com `$gte` — quem filtrasse
          // "menos de 3 visitas" perderia justamente quem tem zero.
          [chave + "Total"]: { $ifNull: [{ $arrayElemAt: ["$_" + chave + ".total", 0] }, 0] },
          ...(data
            ? { [chave + "Ultima"]: { $arrayElemAt: ["$_" + chave + ".ultima", 0] } }
            : {}),
          ...(dataMin
            ? { [chave + "Primeira"]: { $arrayElemAt: ["$_" + chave + ".primeira", 0] } }
            : {}),
          ...(soma
            ? { [chave + "Soma"]: { $ifNull: [{ $arrayElemAt: ["$_" + chave + ".soma", 0] }, 0] } }
            : {}),
          ...(lista
            ? { [chave + "Lista"]: { $ifNull: [{ $arrayElemAt: ["$_" + chave + ".lista", 0] }, []] } }
            : {}),
        },
      },
    ],
  };
}

module.exports = { porPessoa };
