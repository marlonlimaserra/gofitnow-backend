// QUANTOS CABEM DENTRO DE UM. E o que segura isso quando tudo mais falha.
//
// ── O PEDIDO, E O QUE ELE ACERTA ───────────────────────────────────────────
//
// *"Crie na central limite de categorias de foto, lá no plano; crie também
// limite de alimentos por refeição, só para evitar um ataque — vai que alguém
// resolve colocar 9999 alimentos via API numa refeição para derrubar o sistema
// etc."* E depois: *"no treino também: limite de total de exercício no treino e
// limite de série por exercício."*
//
// Ele está certo, e o risco não é teórico. As quatro listas são gravadas
// INTEIRAS num único documento, por uma rota que aceita o array como ele vem:
//
//   PUT /diets/:id/meals          →  meals[].foods[]
//   PUT /workouts/:id/exercises   →  exercises[] e exercises[].sets[]
//   PUT /tenant/assessment-photo-sides
//
// Não é só o tamanho do documento (o Mongo corta em 16 MB, o que já é um erro
// feio na cara de quem salva). É que TODA leitura daquele plano passa a carregar
// e somar aquilo: `comTotais` percorre alimento por alimento, a listagem soma
// séries com `$reduce` em cada linha, o PDF desenha tudo, e o e-mail também. Um
// documento absurdo não derruba a gravação; ele deixa lento cada lugar que o lê,
// depois, para sempre.
//
// ── POR QUE UM LIMITE DE PLANO NÃO BASTA, E ISTO É O PONTO ────────────────
//
// O limite do plano vive na central, e `lib/limiteDoPlano.js` **falha ABERTO**
// de propósito: central fora do ar, `limitsFor` devolve `{}` e todo mundo passa.
// É a escolha certa para um limite comercial — barrar um cliente que pagou por
// causa de uma queda nossa é pior do que não barrar.
//
// Mas é exatamente o oposto do que um teto anti-abuso precisa. Se a única
// barreira fosse o plano, o ataque que ele descreveu passaria justamente na hora
// em que ninguém está olhando: com o painel caído.
//
// Então são DUAS camadas, com trabalhos diferentes:
//
//   TETO ABSOLUTO (aqui)        no funil que limpa os dados, sem I/O, sem plano,
//                              sem como falhar. Corta e segue. É a proteção.
//   LIMITE DO PLANO (na rota)   número que a central escolhe, sempre ≤ o teto.
//                              Responde 409 e abre a vitrine de planos. É a
//                              regra comercial.
//
// A primeira não pode ser desligada por ninguém, nem por mim no painel. A
// segunda existe para vender, e é a que a pessoa vê.
//
// ── OS NÚMEROS, MEDIDOS EM PRODUÇÃO (04/09/2026) ──────────────────────────
//
// Um teto abaixo do que alguém já usa é um cliente quebrado no dia do deploy, e
// por isso nenhum destes números foi inventado:
//
//   alimentos por refeição   maior real: 5     (média 2,6 em 18 refeições)
//   refeições por dieta      maior real: 4     (14 dietas)
//   exercícios por treino    maior real: 7     (média 5,0 em 629 treinos)
//   séries por exercício     maior real: 4     (média 3,5 em 3.163 exercícios)
//   categorias de foto       nenhuma conta configurou; todas nos 4 de fábrica
//
// O `padrao` é generoso — de seis a doze vezes o maior uso real — porque ele
// vale para quem nunca vai ouvir falar de plano nenhum, e apertar aqui seria
// resolver um ataque criando um defeito. O `maximo` é o que nem o plano mais
// caro pode passar.
const TETOS = {
  // Por refeição. Doze é uma refeição com tudo e alternativas; trinta é folga.
  foodsPerMeal: { padrao: 30, maximo: 100 },

  // ── ESTE NÃO FOI PEDIDO, E ENTRA JUNTO ───────────────────────────────────
  //
  // Sem ele, o ataque que ele descreveu só muda de forma: 9.999 refeições de um
  // alimento cada dá o mesmo documento gigante que 9.999 alimentos numa. Limitar
  // uma ponta e deixar a outra aberta é não ter limitado.
  //
  // Não tem chave no plano — ninguém vende "até 40 refeições por dia", e um
  // campo que não se vende no painel é um campo que envelhece sem ninguém notar.
  // É teto duro, e só.
  mealsPerDiet: { padrao: 40, maximo: 100 },

  // Por treino. Cinquenta é um treino de corpo inteiro com sobra.
  exercisesPerWorkout: { padrao: 50, maximo: 200 },

  // Por exercício. Vinte cobre pirâmide, drop-set e o que mais alguém invente.
  setsPerExercise: { padrao: 20, maximo: 50 },

  // ── AS CATEGORIAS DE FOTO JÁ TINHAM TETO ─────────────────────────────────
  //
  // Doze estava escrito à mão em `lib/assessmentPhotoSides.js`, com o motivo
  // certo: "cada ângulo a mais é uma foto a mais por avaliação, para sempre, em
  // todas as pessoas da conta". O número não muda; ele só passou a ser também o
  // `maximo`, e o plano ganhou o direito de apertar abaixo dele.
  photoSides: { padrao: 12, maximo: 12 },
};

// AS CHAVES QUE O PLANO PODE MEXER. `mealsPerDiet` fica fora de propósito (ver
// acima) — e esta lista é o que impede alguém de "aproveitar" e ligar um campo
// no painel para um teto que não foi feito para ser vendido.
const DO_PLANO = ["foodsPerMeal", "exercisesPerWorkout", "setsPerExercise", "photoSides"];

function definicao(chave) {
  const d = TETOS[chave];
  if (!d) throw new Error(`teto estrutural desconhecido: ${chave}`);
  return d;
}

// O teto ABSOLUTO. Não consulta nada, não pode falhar, não depende de plano.
function absoluto(chave) {
  return definicao(chave).maximo;
}

function padraoDe(chave) {
  return definicao(chave).padrao;
}

// O teto QUE VALE para este cliente, dado o que a central respondeu.
//
// `limites` é o objeto de `limitsFor` — e ele pode ser `{}` (central caída) ou
// `null`. Nos dois casos vale o padrão, nunca "sem limite": é a diferença entre
// este arquivo e `lib/limiteDoPlano.js`, e é a razão de ele existir.
//
// O que o plano diz é APERTADO contra o absoluto, e não obedecido: um `9999`
// digitado por engano no painel não abre a porta que este arquivo fecha.
function doPlano(limites, chave) {
  const { padrao, maximo } = definicao(chave);

  const bruto = limites ? limites[chave] : undefined;

  // `null` no painel é o campo vazio, e aqui ele significa "use o padrão".
  //
  // Nas outras chaves de plano, vazio quer dizer ILIMITADO — e é por isso que
  // estas quatro são de outro tipo no catálogo da central. Ilimitado num teto
  // anti-abuso seria a ausência exata da coisa que se pediu.
  if (bruto === null || bruto === undefined) return padrao;
  if (!Number.isInteger(bruto) || bruto < 1) return padrao;

  return Math.min(bruto, maximo);
}

// Corta uma lista no teto ABSOLUTO, para os funis que limpam dados.
//
// Corta em silêncio, e é uma decisão. Estes funis são funções puras chamadas de
// dentro do modelo, sem `req` e sem `res` — não têm como responder 409. Quem
// PODE responder é a rota, e ela responde antes (ver `barrouQuantidade`): esta
// função é a rede embaixo, para o caminho que algum dia esquecer de checar.
//
// Cortar e não estourar porque uma exceção aqui derrubaria a gravação inteira de
// quem tem 101 alimentos por acidente de importação, em vez de gravar 100.
function cortar(lista, chave) {
  if (!Array.isArray(lista)) return [];
  const maximo = absoluto(chave);
  return lista.length > maximo ? lista.slice(0, maximo) : lista;
}

module.exports = { TETOS, DO_PLANO, absoluto, padraoDe, doPlano, cortar };
