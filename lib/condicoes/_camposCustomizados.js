const tipos = require("../tiposDeCampo.js");

// OS CAMPOS CUSTOMIZADOS, COMO CONDIÇÕES.
//
// *"faltou, em contato, os filtros dos campos customizados"* (10/10/2026).
//
// ── POR QUE ESTE ARQUIVO NÃO É UMA CONDIÇÃO ──────────────────────────────
//
// Os outros arquivos desta pasta descrevem UMA condição cada, e são iguais em
// toda conta. Estes não existem: "Convênio" é um campo que esta academia
// criou, e a de Paraty tem outros cinco. Não há arquivo a escrever — há uma
// REGRA para transformar o catálogo de campos da conta em condições.
//
// Daí o `_` no nome e o `gerar` no lugar de `chave`: o `index.js` distingue os
// dois pela forma, e quem acrescentar um gerador novo (planos, etiquetas) o
// escreve do mesmo jeito, num arquivo só dele.
//
// ── ONDE O VALOR MORA, E POR QUE ISSO IMPORTA AQUI ───────────────────────
//
// Campo NATIVO (`goal`, `weight`, `height`) guarda na COLUNA de sempre, porque
// o IMC e a evolução leem de lá. O resto vai para `customFields.<alias>`.
// Filtrar pelo caminho errado devolve lista vazia — e lista vazia parece
// "ninguém tem esse convênio", não "procurei no lugar errado".
//
// ── E POR QUE `objetivo` SUMIU DA PASTA ──────────────────────────────────
//
// Eu tinha escrito uma condição estática para `goal`. Ela é NATIVA do catálogo
// de campos: a casa manda no nome dela, pode desligá-la, e ela já aparece
// aqui. Duas entradas para o mesmo campo é exatamente o que o `StudentForm` já
// cometeu uma vez — a nota em `campos-customizados` diz "não recolocar à mão:
// apareceriam duas vezes".

// O `guarda` do tipo de campo diz em que forma o valor foi gravado, e é ele —
// não o tipo da tela — que decide como se pergunta. Um "CPF" e um "Convênio"
// são os dois texto para o banco.
const POR_GUARDA = {
  texto: "texto",
  numero: "numero",
  data: "data",
  booleano: "booleano",
  // Lista guarda um array. No Mongo, `{campo: "x"}` casa com o array que
  // CONTÉM "x" — então a pergunta natural ("tem esta opção?") sai de graça.
  lista: "opcao",
};

const ICONE_PADRAO = "Type";

module.exports = {
  // `t` só é passado por quem vai DESENHAR o catálogo. Quem traduz uma árvore
  // não precisa de rótulo nenhum, e buscar tradução ali seria trabalho jogado
  // fora em toda listagem.
  gerar: async (app, t) => {
    const campos = await app.api.customField.list({ ativos: true });

    return campos
      .map((c) => {
        // `comoGuarda` e `dados` são de `lib/tiposDeCampo.js`, que é quem
        // decide isso para o resto do sistema. Reimplementar a tabela aqui
        // criaria uma segunda verdade — e a que ficasse para trás seria a que
        // decide onde o filtro procura.
        const def = tipos.dados(c.tipo);
        const guarda = tipos.comoGuarda(c.tipo);
        const temOpcoes = Array.isArray(c.opcoes) && c.opcoes.length;

        // Seletor e lista viram escolha FECHADA quando o campo declara as
        // opções; sem elas, viram texto — um seletor sem opção é um campo que
        // não dá para preencher.
        const tipo = temOpcoes ? "opcao" : POR_GUARDA[guarda] || "texto";

        return {
          // `campo_` na frente para nunca colidir com as condições fixas: um
          // campo chamado "nome" é possível, e sem o prefixo ele sequestraria
          // a condição de nome da pessoa.
          chave: "campo_" + c.alias,
          categoria: "contato",
          icone: def?.icone || ICONE_PADRAO,
          tipo,
          // NATIVO guarda na coluna; o resto, em `customFields.<alias>`.
          campo: c.nativo ? c.alias : "customFields." + c.alias,
          ...(temOpcoes ? { opcoes: c.opcoes.map((o) => String(o?.valor ?? o)) } : {}),
          // O rótulo vem do catálogo, e não de uma chave de tradução: a casa
          // escolheu o nome deste campo, e ele já está no idioma dela. Nativo
          // sem nome cai no padrão traduzido — é o mesmo que a ficha faz.
          rotulo: c.name || (t && c.rotuloPadrao ? t(c.rotuloPadrao) : c.alias),
        };
      })
      .filter((c) => c.campo);
  },
};
