// QUANTAS LINHAS CABEM NUMA RESPOSTA — e por que a exportação tem outro teto.
//
// Toda lista paginada deste servidor termina no mesmo lugar:
//
//     Math.min(Math.max(Number(limite) || PADRAO, 1), MAXIMO)
//
// O `MAXIMO` (200 em todas) protege a máquina de um `?limit=999999` vindo da
// rede. Ele é certo para a TELA: ninguém rola duzentas linhas.
//
// ── E ELE ESTAVA CORTANDO A EXPORTAÇÃO EM SILÊNCIO ────────────────────────
//
// A planilha pede a lista inteira do recorte — *"quem exporta quer o que o
// filtro diz, não os vinte primeiros que couberam na tela"*. Pedia `limit:
// 5000`, o clamp devolvia 200, e o arquivo saía com duzentas linhas sem uma
// palavra dizendo que faltava o resto. Numa conta pequena passa despercebido
// para sempre; numa de quinhentos alunos, alguém manda a lista para a
// contabilidade faltando trezentas pessoas.
//
// Então o teto vira DOIS. Não "um maior": quem chama de dentro do servidor —
// só o registro de listas exportáveis — passa `exportando: true`, e o que vem
// da query continua preso em 200. É a diferença entre elevar o limite e
// abrir o limite: `exportando` nunca é lido de `req.query`.
const TETO_DE_EXPORTACAO = 5000;

function porPagina(limite, { padrao, maximo, exportando = false } = {}) {
  const teto = exportando ? TETO_DE_EXPORTACAO : maximo;
  // Sem limite pedido, exportar traz TUDO até o teto: quem exporta não escolhe
  // tamanho de página, e cair no `padrao` (25) seria o mesmo corte calado.
  const pedido = Number(limite) || (exportando ? teto : padrao);
  return Math.min(Math.max(pedido, 1), teto);
}

module.exports = { TETO_DE_EXPORTACAO, porPagina };
