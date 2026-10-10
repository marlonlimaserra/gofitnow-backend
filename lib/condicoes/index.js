const fs = require("node:fs");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const tempo = require("../tempo.js");

// O FILTRO AVANÇADO — condições combinadas com E e OU.
//
// *"coloque uma aba 'Básico' e outra 'Avançado'; se clicar em avançado quero
// que abra algo igual é no SprintHub, aí dá para pôr várias condições"*
// (10/10/2026).
//
// ── O QUE ISTO É, E O QUE NÃO PODE SER ─────────────────────────────────────
//
// É um tradutor de uma ÁRVORE DE CONDIÇÕES para um `$match` do Mongo. E o
// perigo está inteiro nessa frase: se a árvore que chega da tela virasse
// consulta diretamente, quem mandasse `{"campo": "$where", "valor": "..."}`
// executaria código no banco, e quem mandasse `{"campo": "password"}`
// descobriria senha por tentativa — um filtro que responde "0 resultados" ou
// "1 resultado" é um oráculo.
//
// Por isso **nada do que chega vira caminho de consulta**. A tela manda a
// CHAVE de uma condição do catálogo abaixo; o catálogo diz qual campo é, que
// operadores aceita e de que tipo é o valor. Chave desconhecida é descartada,
// operador fora da lista daquela condição é descartado, e o valor é coagido
// pelo tipo antes de encostar no Mongo.
//
// ── POR QUE O CATÁLOGO MORA AQUI, E NÃO NA TELA ────────────────────────────
//
// Porque é ele que autoriza. A tela o BUSCA para desenhar o seletor (as
// categorias, a busca, os rótulos) — e se ela inventar uma condição que não
// está aqui, o servidor simplesmente não a aplica. Um catálogo duplicado nos
// dois lados divergiria na primeira adição, e o lado que ficasse para trás
// seria o que decide.
//
// Acrescentar condição nova é uma linha aqui e uma chave de tradução. É o que
// torna "dá para pôr várias condições" uma promessa que se cumpre amanhã
// também.

// Os tipos de valor que uma condição pode pedir, e como a tela desenha cada um:
//
//   booleano  → sim/não             nenhum valor extra
//   opcao     → uma lista fixa      `opcoes`
//   texto     → caixa de texto
//   numero    → caixa numérica
//   data      → calendário          (dia de calendário, "AAAA-MM-DD")
//   pessoa    → id de um registro   (unidade, por enquanto)
const OPERADORES_POR_TIPO = {
  booleano: ["e"],
  opcao: ["e", "nao_e"],
  texto: ["contem", "nao_contem", "e", "vazio", "preenchido"],
  numero: ["e", "maior", "menor", "vazio", "preenchido"],
  // "e" é o DIA EXATO. *"acho que faltou 'data exata', quero pegar o que tem
  // naquele dia"* (10/10/2026) — e ele é o primeiro da lista porque é o que
  // mais se pede: "quem entrou hoje".
  data: ["e", "depois", "antes", "entre"],
  pessoa: ["e", "nao_e", "vazio"],
};

// ── O CATÁLOGO ────────────────────────────────────────────────────────────
//
// `campo` é o caminho no documento da PESSOA. Condição que não é um campo
// simples traz `montar`, que devolve o `$match` inteiro — é o caso de tudo que
// mora em outra collection (pendências, treinos) ou que é derivado (o acesso
// ao app é senha E não-bloqueado, nunca um campo só).
// ── UMA CONDIÇÃO POR ARQUIVO, DESCOBERTAS AQUI ───────────────────────────
//
// *"em breve vamos ter um montão de condições, e tenho medo de dar conflito
// quando outro programador for mexer; no SprintHub cada filtro é um arquivo
// separado"* (10/10/2026).
//
// Ele está certo, e o problema tem nome: REGISTRO CENTRAL. Com um array só,
// toda adição mexe nas mesmas linhas — duas pessoas acrescentando condições na
// mesma semana conflitam sempre, e no pior lugar: no meio de uma lista, onde um
// `>>>>>>>` passa despercebido na revisão.
//
// Com um arquivo por condição o conflito deixa de existir, e a LEITURA da pasta
// é o que tira até a linha do índice. Acrescentar uma condição passa a tocar
// exatamente um arquivo novo e nenhum existente.
//
// ── O PREÇO DISSO, E COMO ELE É PAGO ─────────────────────────────────────
//
// Descoberta automática é implícita: não dá para `grep` a lista, e um arquivo
// esquecido na pasta vira uma condição no ar. O teste
// `test/lib/condicoesAvancadas.test.js` paga esse preço — ele exige que TODA
// entrada tenha chave única, categoria conhecida, tipo válido e operadores
// coerentes. Um arquivo torto quebra a suíte em vez de chegar à produção.
//
// A ORDEM da pasta não importa: o painel agrupa por categoria e ordena pelo
// rótulo TRADUZIDO, que é a ordem que faz sentido para quem lê — e que o
// servidor não tem como saber, porque ele não conhece o idioma de quem olha.
const PASTA = __dirname;

const CATEGORIAS = require("./categorias.js");

const ARQUIVOS = fs
  .readdirSync(PASTA)
  .filter((n) => n.endsWith(".js") && n !== "categorias.js" && n !== "index.js")
  .map((n) => require(path.join(PASTA, n)));

// ── CONDIÇÕES FIXAS E CONDIÇÕES GERADAS ──────────────────────────────────
//
// *"faltou, em contato, os filtros dos campos customizados"* (10/10/2026).
//
// As fixas são iguais em toda conta — "Nome", "E-mail", "Passagem na catraca".
// As geradas não existem até alguém criá-las: "Convênio" é um campo que ESTA
// academia inventou, e a de Paraty tem outros cinco. Não há arquivo a
// escrever; há uma REGRA, e ela mora num gerador (`_camposCustomizados.js`).
//
// A pasta acomoda os dois pela FORMA do que o arquivo exporta: quem tem
// `gerar` é gerador, quem tem `chave` é condição. Um gerador novo — planos,
// etiquetas — entra do mesmo jeito, num arquivo só dele, sem tocar neste.
// Um arquivo pode trazer UMA condição ou VÁRIAS. Um domínio inteiro —
// frequência, financeiro — costuma render duas ou três perguntas que
// compartilham a mesma junção, e separá-las em arquivos faria a junção virar
// um quarto arquivo que os três importam. Elas nascem juntas e mudam juntas.
const CATALOGO = ARQUIVOS.flatMap((c) => (Array.isArray(c) ? c : [c])).filter((c) => c.chave);
const GERADORES = ARQUIVOS.filter((c) => typeof c.gerar === "function");

// As condições que dependem da conta. Custa uma consulta, então quem chama só
// paga quando precisa — a listagem de pessoas, por exemplo, só busca quando a
// árvore existe.
async function dinamicas(app, t) {
  const listas = await Promise.all(
    GERADORES.map((g) =>
      // Um gerador que falha não pode derrubar o filtro inteiro: o resto do
      // catálogo continua servindo, e a condição que faltou simplesmente não
      // aparece — como uma que ainda não foi escrita.
      Promise.resolve()
        .then(() => g.gerar(app, t))
        .catch((erro) => {
          console.error("[condicoes] gerador falhou:", erro.message);
          return [];
        })
    )
  );

  return listas.flat();
}

function operadoresDe(c) {
  const todos = OPERADORES_POR_TIPO[c.tipo] || [];
  if (!c.padrao || !todos.includes(c.padrao)) return todos;
  return [c.padrao, ...todos.filter((o) => o !== c.padrao)];
}

// O que a tela recebe para desenhar o seletor. Sem `montar` e sem `campo`: ela
// não precisa saber onde o dado mora, e mandar isso para o navegador seria
// publicar o mapa do banco.
function catalogo(extras = []) {
  return [...CATALOGO, ...extras].map((c) => ({
    chave: c.chave,
    categoria: c.categoria,
    icone: c.icone,
    tipo: c.tipo,
    operadores: operadoresDe(c),
    ...(c.opcoes ? { opcoes: c.opcoes } : {}),
    ...(c.fonte ? { fonte: c.fonte } : {}),
    // As geradas trazem o rótulo pronto: o nome é da CASA, já no idioma
    // dela, e não há chave de tradução que o conheça.
    ...(c.rotulo ? { rotulo: c.rotulo } : {}),
  }));
}

// ── A COAÇÃO DO VALOR ─────────────────────────────────────────────────────
//
// Devolve `undefined` quando o valor não serve, e quem chama descarta a
// condição inteira. É deliberado que valor inválido não vire "qualquer coisa":
// uma condição que o servidor não entendeu e ignora em SILÊNCIO devolve a
// lista inteira para quem pediu um recorte — e ninguém confere uma lista que
// parece certa.
function coagir(tipo, valor) {
  if (tipo === "booleano") return Boolean(valor);
  if (tipo === "numero") {
    const n = Number(valor);
    return Number.isFinite(n) ? n : undefined;
  }
  if (tipo === "pessoa") return ObjectId.isValid(valor) ? new ObjectId(String(valor)) : undefined;
  if (tipo === "data") return DIA.test(String(valor || "").trim()) ? String(valor).trim() : undefined;
  const texto = String(valor ?? "").trim();
  return texto || undefined;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

// ── UMA DATA NA TELA É UM DIA DE CALENDÁRIO, NÃO UM INSTANTE ──────────────
//
// `createdAt` guarda um instante; "10/10" é uma pergunta de calendário. As
// duas só se encontram passando pelo FUSO DA CONTA, e a primeira versão disto
// não passava: `new Date("2026-10-10")` é meia-noite em UTC, que no Brasil é
// 21h do dia 9. Quem foi cadastrado às 22h do dia 9 apareceria num filtro do
// dia 10, e sumiria de um do dia 9.
//
// É exatamente o defeito que `periodoDeCadastro` já descrevia por escrito, e
// que eu reintroduzi do lado — e ele dói mais no operador NOVO: "nesse dia"
// com três horas de deslocamento devolve o conjunto errado de gente, com cara
// de conjunto certo.
function doDia(texto, fuso) {
  const [ano, mes, dia] = String(texto).split("-").map(Number);
  return tempo.instante({ ano, mes, dia }, fuso);
}

// O dia SEGUINTE, para fechar o intervalo com `$lt`. `dia + 1` pode passar do
// fim do mês; o `Date.UTC` lá dentro vira o mês sozinho — 32 de setembro é 1º
// de outubro.
function doDiaSeguinte(texto, fuso) {
  const [ano, mes, dia] = String(texto).split("-").map(Number);
  return tempo.instante({ ano, mes, dia: dia + 1 }, fuso);
}

// Texto do usuário dentro de um `$regex` é texto, não expressão. Sem escapar,
// um `.*` devolve a base inteira e um `(a+)+$` trava o banco.
function escapar(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function umaCondicao(bruta, fuso, extras = [], ctx = {}) {
  const def = [...CATALOGO, ...extras].find((c) => c.chave === bruta?.campo);
  if (!def) return null;

  const operadores = operadoresDe(def);
  const op = operadores.includes(bruta?.operador) ? bruta.operador : operadores[0];

  // Os dois que não olham o valor.
  if (op === "vazio") return { [def.campo]: { $in: [null, ""] } };
  if (op === "preenchido") return { [def.campo]: { $nin: [null, ""] } };

  if (op === "entre") {
    const de = coagir("data", bruta?.valor);
    const ate = coagir("data", bruta?.valor2);
    if (!de || !ate) return null;
    // O fim é o dia SEGUINTE com `$lt`: `$lte` do dia escolhido pararia em
    // 00:00 e deixaria o dia inteiro de fora.
    return { [def.campo]: { $gte: doDia(de, fuso), $lt: doDiaSeguinte(ate, fuso) } };
  }

  const valor = coagir(def.tipo, bruta?.valor);
  if (valor === undefined) return null;

  // A lista de opções é conferida ANTES do `montar`: a primeira versão deixava
  // o valor inventado chegar nele, e uma condição derivada que recebe o que
  // não espera é exatamente o tipo de buraco que o catálogo existe para
  // fechar.
  if (def.tipo === "opcao" && !def.opcoes.includes(valor)) return null;

  // Condição derivada: ela mesma diz como virar consulta, e recebe o OPERADOR
  // junto — sem ele, "sexo não é feminino" viraria "sexo é feminino".
  // O `ctx` leva o que depende de QUANDO a pergunta é feita — hoje, e o dia
  // de calendário no fuso da conta. "Tem cobrança vencida" muda de resposta à
  // meia-noite, e uma condição que guardasse essa data no módulo responderia
  // com o dia em que o servidor subiu.
  if (def.montar) return def.montar(valor, op, ctx);

  switch (op) {
    case "contem":
      return { [def.campo]: { $regex: escapar(valor), $options: "i" } };
    case "nao_contem":
      return { [def.campo]: { $not: new RegExp(escapar(valor), "i") } };
    case "nao_e":
      return { [def.campo]: { $ne: valor } };
    case "maior":
      return { [def.campo]: { $gt: valor } };
    case "menor":
      return { [def.campo]: { $lt: valor } };
    case "depois":
      return { [def.campo]: { $gte: doDia(valor, fuso) } };
    case "antes":
      return { [def.campo]: { $lt: doDia(valor, fuso) } };
    default:
      // Data com "é" é o DIA INTEIRO, das 00:00 às 23:59:59 do fuso da conta
      // — e não um instante. Comparar `createdAt` com meia-noite exata não
      // acharia ninguém: ninguém é cadastrado exatamente às 00:00:00.000.
      if (def.tipo === "data") {
        return { [def.campo]: { $gte: doDia(valor, fuso), $lt: doDiaSeguinte(valor, fuso) } };
      }
      return { [def.campo]: valor };
  }
}

// ── A ÁRVORE ──────────────────────────────────────────────────────────────
//
//   { juntar: "e" | "ou",
//     grupos: [ { juntar: "e"|"ou", condicoes: [ {campo, operador, valor} ] } ] }
//
// Dois níveis, como no SprintHub: condições dentro de um grupo, grupos entre
// si. Dois bastam para tudo que se pede numa lista de alunos, e um terceiro
// nível seria uma tela que ninguém consegue ler.
//
// Grupo sem condição VÁLIDA desaparece, e árvore sem grupo devolve `null` —
// "não filtre nada". É o contrário de devolver `{}`, que num `$or` vazio faz o
// Mongo estourar.
function traduzir(arvore, fuso, extras = [], ctx = {}) {
  if (!arvore || !Array.isArray(arvore.grupos)) return null;

  const grupos = arvore.grupos
    .map((g) => {
      const partes = (Array.isArray(g?.condicoes) ? g.condicoes : [])
        .map((c) => umaCondicao(c, fuso, extras, ctx))
        .filter(Boolean);
      if (!partes.length) return null;
      if (partes.length === 1) return partes[0];
      return g?.juntar === "ou" ? { $or: partes } : { $and: partes };
    })
    .filter(Boolean);

  if (!grupos.length) return null;
  if (grupos.length === 1) return grupos[0];
  return arvore.juntar === "ou" ? { $or: grupos } : { $and: grupos };
}

// ── AS JUNÇÕES QUE A ÁRVORE PEDE ────────────────────────────────────────
//
// Cada condição de outro domínio declara a sua (ver `_junta.js`). Aqui elas
// são recolhidas e DEDUPLICADAS pela chave: três condições de frequência
// compartilham uma junção só, e sem isso "veio nos últimos 30 dias E tem mais
// de 10 visitas" pagaria duas varreduras de `checkins` por pessoa da página.
//
// A ordem é a de aparição, e não importa: são `$lookup` independentes.
function juntasDe(arvore, extras = []) {
  if (!arvore || !Array.isArray(arvore.grupos)) return [];

  const todas = [...CATALOGO, ...extras];
  const porChave = new Map();

  for (const g of arvore.grupos) {
    for (const c of Array.isArray(g?.condicoes) ? g.condicoes : []) {
      const def = todas.find((x) => x.chave === c?.campo);
      if (def?.junta?.chave && !porChave.has(def.junta.chave)) {
        porChave.set(def.junta.chave, def.junta);
      }
    }
  }

  return [...porChave.values()];
}

// A árvore pede a junção com o VÍNCULO?
//
// Só o status, por enquanto. O modelo pergunta antes de montar o pipeline: a
// junção é cara e correlacionada por pessoa, e subi-la sempre custaria a toda
// busca o preço de um filtro que quase ninguém usa.
function usaVinculo(arvore) {
  if (!arvore || !Array.isArray(arvore.grupos)) return false;

  const comVinculo = new Set(CATALOGO.filter((c) => c.precisaDoVinculo).map((c) => c.chave));
  return arvore.grupos.some((g) =>
    (Array.isArray(g?.condicoes) ? g.condicoes : []).some((c) => comVinculo.has(c?.campo))
  );
}

// Quantas condições VÁLIDAS a árvore tem — é o número no botão de Filtros, e
// contar na tela daria outro número no dia em que o servidor descartasse uma.
function quantas(arvore) {
  if (!arvore || !Array.isArray(arvore.grupos)) return 0;
  return arvore.grupos.reduce(
    (total, g) =>
      total +
      (Array.isArray(g?.condicoes)
        ? g.condicoes.filter((c) => umaCondicao(c, "UTC")).length
        : 0),
    0
  );
}

module.exports = {
  CATEGORIAS,
  catalogo,
  dinamicas,
  traduzir,
  quantas,
  juntasDe,
  usaVinculo,
  escapar,
};
