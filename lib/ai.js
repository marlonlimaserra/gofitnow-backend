const ollama = require("./aiOllama.js");

// O assistente: modelos oferecidos, ferramentas e a instrução do sistema.
//
// Tudo que molda a conversa mora AQUI, no servidor, e não na tela. A tela manda
// só as mensagens; quem escolhe o modelo, escreve a instrução e declara as
// ferramentas é este arquivo. É a mesma razão de o catálogo de permissões viver
// no servidor: uma instrução que o navegador pudesse reescrever não é instrução,
// é sugestão — e o assistente clica em botões de verdade.
//
// ATENÇÃO ao acoplamento: os nomes das ferramentas abaixo têm um executor com o
// MESMO nome em gofitnow-frontend/src/lib/aiActions.js. Renomear um lado sem o
// outro faz o modelo pedir uma ferramenta que ninguém sabe executar — e o laço
// devolve erro para sempre. Os dois nomes andam juntos.

// Os modelos que a tela oferece.
//
// `effort` diz se aquele modelo aceita `output_config.effort`: o Haiku 4.5 não
// aceita e responde 400. `thinking` idem — nos modelos que pensam por padrão a
// gente NÃO desliga o pensamento, mesmo querendo latência: com ele desligado, um
// fluxo cheio de ferramenta como este às vezes escreve a chamada como TEXTO em
// vez de emitir a chamada de verdade. O turno "dá certo", nada é clicado, e
// nenhum erro aparece. Baixar o esforço resolve a latência sem abrir esse buraco.
// `in` e `out` são dólares por MILHÃO de tokens, como a Anthropic publica.
//
// É uma FOTO da tabela, não a tabela: preço muda. Por isso o que se guarda na
// sessão são os TOKENS (fato, não muda nunca) e o custo calculado com o preço
// do momento — assim uma sessão de março não é reprecificada em julho por uma
// alteração de tabela.
const MODELS = [
  { id: "claude-opus-5", effort: true, in: 5, out: 25 },
  { id: "claude-sonnet-5", effort: true, in: 3, out: 15 },
  { id: "claude-haiku-4-5", effort: false, in: 1, out: 5 },
];

// O cache muda o preço da ENTRADA: ler do cache sai por um décimo, gravar nele
// custa 1,25x. É de onde vem quase toda a economia de uma conversa longa.
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

const DEFAULT_MODEL = "claude-opus-5";

const MODEL_IDS = MODELS.map((m) => m.id);

// Quem responde: a Anthropic ou um Ollama que o cliente hospeda.
//
// A diferença que atravessa o arquivo: no `anthropic` o catálogo de modelos é
// FECHADO (a lista acima, com preço); no `ollama` é aberto — o nome é o que o
// cliente baixou na máquina dele (`qwen3:8b`, `gemma4:26b`), e nós não temos
// como saber quais existem.
const PROVIDERS = ["anthropic", "ollama"];
const DEFAULT_PROVIDER = "anthropic";

function normalizeProvider(nome) {
  return PROVIDERS.includes(String(nome)) ? String(nome) : DEFAULT_PROVIDER;
}

function normalizeModel(id, provider) {
  // No Ollama o nome é texto livre. Só o formato é conferido — `familia:tag` —
  // para um campo em branco não virar uma chamada com modelo vazio.
  if (normalizeProvider(provider) === "ollama") {
    const nome = String(id || "").trim().slice(0, 80);
    return /^[a-zA-Z0-9._\/-]+(:[a-zA-Z0-9._-]+)?$/.test(nome) ? nome : "";
  }

  return MODEL_IDS.includes(String(id)) ? String(id) : DEFAULT_MODEL;
}

// ── Modo conversa (fala-para-fala em tempo real) ───────────────────────────
//
// Um EIXO SEPARADO do provedor de texto. Dá para escrever com o Claude e
// conversar com o Realtime da OpenAI — são decisões diferentes, e amarrá-las
// obrigaria a escolher o pior dos dois mundos em uma delas.
//
// A Anthropic não tem fala-para-fala: o Claude é só texto. Então este modo
// necessariamente troca o cérebro do assistente enquanto durar a conversa.
// Onde se cria a sessão de voz.
//
// São DUAS tentativas, e não uma escolha: a OpenAI trocou este endereço quando o
// tempo real saiu de beta, e as duas formas convivem no mundo — instalações
// diferentes, contas diferentes. Tentar a nova e cair na antiga custa uma
// requisição extra só quando a nova não existe, e evita que o recurso quebre a
// cada renomeação lá.
//
// `envelope` diz como o corpo vai: a forma nova aninha tudo em `session` e põe a
// voz em `audio.output.voice`; a antiga é plana.
const REALTIME_ENDPOINTS = [
  { url: "https://api.openai.com/v1/realtime/client_secrets", envelope: "session" },
  { url: "https://api.openai.com/v1/realtime/sessions", envelope: "flat" },
];

// Para onde o navegador manda a oferta de conexão (SDP). Vai na resposta, para
// o endereço viver num lugar só — se mudar, muda aqui.
const REALTIME_SDP_URL = "https://api.openai.com/v1/realtime/calls";

// Voz de verdade para o modo ESCRITA — o Claude pensa, a OpenAI fala.
const SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const SPEECH_MODEL = "gpt-4o-mini-tts";

// O modelo é TEXTO LIVRE, com um padrão.
//
// Nomes de modelo de voz mudam com frequência, e um catálogo fechado aqui
// significaria um deploy toda vez que a OpenAI renomear algo. Assim o nome errado
// vira um erro legível da própria OpenAI, corrigível pela tela.
const DEFAULT_REALTIME_MODEL = "gpt-realtime";

const VOICES = ["marin", "cedar", "coral", "alloy", "ash", "sage", "verse", "ballad", "echo", "shimmer"];
const DEFAULT_VOICE = "marin";

function normalizeVoice(nome) {
  return VOICES.includes(String(nome)) ? String(nome) : DEFAULT_VOICE;
}

function normalizeRealtimeModel(id) {
  const nome = String(id || "").trim().slice(0, 80);
  return /^[a-zA-Z0-9._-]+$/.test(nome) ? nome : DEFAULT_REALTIME_MODEL;
}

// O corpo que cria a sessão efêmera.
//
// Instrução e ferramentas vão DAQUI, não da tela — mesma regra do modo escrita.
// A diferença é que aqui elas ficam presas ao token de um minuto: o navegador
// recebe permissão para conversar, não para reescrever quem o assistente é.
function realtimeSession({ model, voice, words, language, user, envelope }) {
  const base = {
    model: normalizeRealtimeModel(model),
    voice: normalizeVoice(voice),
    instructions:
      systemPrompt({ words, language, user }) +
      `

# Você está FALANDO

Isto é uma conversa por voz, com alguém trabalhando. Ele não está aqui para conversar com você: está montando um treino e tem pressa.

## Quanto falar

Confirmação é UMA frase curta, do tamanho de um respiro. Cinco, seis palavras.

- "Quatro séries."
- "Adicionei a remada baixa."
- "Salvo."

E acabou. Não emende mais nada.

## O que NUNCA dizer

Nada de oferecer ajuda, sugerir o próximo passo ou lembrar do que dá para fazer. Quem está usando conhece o sistema melhor que você.

Proibido, e sem exceção:

- "Se precisar ajustar repetições, carga ou pausas, é só dizer."
- "Quando estiver tudo certo, você pode salvar."
- "Se quiser, posso…", "É só falar", "Estou aqui para ajudar", "Fico à disposição".
- Repetir o pedido dele de volta antes de agir.
- Abrir com "Beleza", "Perfeito", "Claro", "Então".

Compare. Errado: "Agora o exercício está com 4 séries. Se precisar ajustar repetições, carga ou pausas, é só dizer. Quando estiver tudo certo, você pode salvar." Certo: "Quatro séries."

Falar demais custa duas coisas: o tempo dele esperando você terminar, e o limite por minuto da conta — cada palavra a mais aproxima a conversa de uma pausa forçada.

Só fale mais de uma frase quando faltar um dado para agir. Aí pergunte só o dado, em uma frase, e pare.

Não soletre id de botão nem nome de campo em voz alta: diga "abri o cadastro", não "cliquei em pessoas.nova".

Se faltar um dado, pergunte por ele numa frase e espere. A pessoa pode te interromper a qualquer momento — se ela falar por cima, pare e escute.

NUNCA diga que não achou uma coisa sem antes chamar ver_tela. A tela muda sozinha entre uma fala e outra — a pessoa clica, busca, rola —, e o retrato que você tem pode ser de minutos atrás. "Não achei" dito por cima de um retrato velho é a pior resposta que existe: a coisa está lá, na frente dela.

NUNCA anuncie o que vai fazer e pare. "Vou ajustar agora", "já vou preencher", "vou corrigir" — se você disse isso, a ferramenta tem de sair NO MESMO turno, logo em seguida. Anunciar e ficar quieto deixa a pessoa esperando por algo que não vem, e ela precisa ficar repetindo "faz, faz". Aja primeiro; falar é para dizer o que JÁ está feito.

Um pedido com várias partes é UMA tarefa. "Preenche o nome, o e-mail e o telefone" se resolve numa chamada só de preencher, com os três campos juntos — não um campo por vez, e não parando para confirmar entre eles. Vá até o fim do que foi pedido e só então fale. Ninguém deveria precisar dizer "continue".`,
    // As MESMAS ferramentas do modo escrita, no formato que a OpenAI espera.
    // Quem as executa continua sendo o navegador, contra a tela de verdade.
    tools: TOOLS.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    // Detecção de fim de fala pelo SERVIDOR: é ela que dá o turno rápido e
    // permite interromper. Fazer isso no navegador (contar silêncio) foi o que
    // limitou o modo escrita a ~1,6 s.
    turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 500 },
  };

  if (envelope !== "session") return base;

  // A forma nova: tudo dentro de `session`, com a voz debaixo de `audio.output`.
  const { voice: timbre, turn_detection, ...resto } = base;
  return {
    session: {
      type: "realtime",
      ...resto,
      audio: {
        output: { voice: timbre },
        input: { turn_detection },
      },
    },
  };
}

// O token pode vir em dois lugares, conforme a versão que respondeu.
function realtimeToken(dados) {
  return dados?.value || dados?.client_secret?.value || null;
}

// O erro da OpenAI, traduzido no que ele significa PARA QUEM PAGA.
//
// "insufficient_quota" é a falha mais provável de todas — conta nova da OpenAI
// vem com crédito zero, e o cartão cadastrado não basta: é preciso comprar
// saldo. Deixar isso como um texto em inglês no meio de uma frase nossa faz a
// pessoa procurar defeito no sistema quando o que falta é dinheiro na conta.
//
// A mensagem original vai junto de qualquer forma: ela é o que se cola numa
// busca quando a nossa não bastar.
const ERROS_OPENAI = {
  insufficient_quota: "errors.aiVoiceNoCredit",
  invalid_api_key: "errors.aiVoiceBadKey",
  model_not_found: "errors.aiVoiceModelNotFound",
  rate_limit_exceeded: "errors.aiVoiceRateLimited",
};

function erroDaOpenAI(dados, status) {
  const erro = dados?.error || {};
  const code = erro.code || erro.type || "";

  return {
    chave: ERROS_OPENAI[code] || (status === 401 ? "errors.aiVoiceBadKey" : "errors.aiVoiceFailed"),
    detalhe: erro.message || "",
    code: code || "voice_error",
    // Falta de crédito e chave errada são problemas DA CONTA, não do servidor —
    // 400 para a tela não os tratar como instabilidade nossa.
    status: code === "insufficient_quota" || status === 401 ? 400 : 502,
  };
}

// O endereço do Ollama do cliente.
//
// Ele chega pelo ngrok (ou por um domínio próprio), e o servidor vai BUSCAR
// nesse endereço — o que faz desta a única entrada do sistema em que alguém
// escolhe para onde o nosso servidor faz uma requisição. Daí a checagem abaixo.
//
// Endereço interno é RECUSADO: `localhost`, `127.x`, a rede da máquina e o
// 169.254.169.254 (metadados de nuvem). Sem isto, um cliente com permissão de
// administrador na instância dele apontaria o assistente para dentro do nosso
// VPS e usaria o proxy para varrer o que roda lá — inclusive o Mongo, que
// escuta em 127.0.0.1 sem senha. O Ollama de verdade vem por um endereço
// público, então a regra não atrapalha o uso legítimo.
//
// `AI_ALLOW_PRIVATE=1` no ambiente libera, para desenvolvimento na própria
// máquina.
const PRIVADOS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

function checkBaseUrl(valor) {
  const texto = String(valor || "").trim();
  if (!texto) return { ok: false, erro: "required" };

  let url;
  try {
    url = new URL(texto);
  } catch (error) {
    return { ok: false, erro: "invalid" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, erro: "invalid" };
  }

  const privado = PRIVADOS.some((r) => r.test(url.hostname));
  if (privado && process.env.AI_ALLOW_PRIVATE !== "1") {
    return { ok: false, erro: "private" };
  }

  // Guardado sem a barra final e sem caminho: o caminho é nosso
  // (`/v1/chat/completions`), e uma barra a mais viraria `//v1/…`.
  return { ok: true, url: url.origin };
}

function modelInfo(id) {
  return MODELS.find((m) => m.id === normalizeModel(id));
}

// Tetos de tamanho da conversa.
//
// A rota é um proxy para uma API cobrada por token, aberta a qualquer sessão
// válida. Sem teto, uma aba deixada num laço manda a conversa crescendo até a
// fatura do cliente. Não é limite de uso — é freio de ACIDENTE, e por isso ele
// tem de ficar bem longe do uso normal.
//
// Os primeiros números (60 mensagens, 200 KB) eram apertados demais: montar um
// treino gasta dezenas de idas e voltas, e cada resultado de ferramenta vinha
// com um retrato inteiro da tela. A pessoa batia no teto no meio do trabalho —
// um freio de acidente disparando em uso normal é um defeito, não uma proteção.
//
// A tela agora poda os retratos velhos antes de enviar (lib/aiActions.js e
// useAiAgent.js), então o mesmo trabalho ocupa uma fração disto.
const MAX_MESSAGES = 400;
const MAX_CHARS = 900000;
const MAX_TOKENS = 16000;

// As ferramentas. Quem as executa é o navegador, contra a tela de verdade.
//
// São três de propósito. O assistente não tem rota para gravar nada: ele lê a
// tela, clica no que já existe e preenche campo. Quem grava é o mesmo POST que
// o dedo do profissional dispararia, com a mesma sessão e as mesmas permissões
// — e é por isso que o isolamento por instância continua valendo sem nada novo.
const TOOLS = [
  {
    name: "ver_tela",
    description:
      "Lê a tela aberta agora: a rota, os títulos, os AVISOS visíveis, o " +
      "CONTEÚDO das tabelas (o que está listado), os botões clicáveis e os " +
      "campos preenchíveis. Use no começo da conversa para saber onde você está. " +
      "Depois de clicar ou preencher você já recebe a tela nova junto do " +
      "resultado, então não precisa chamar de novo.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "clicar",
    description:
      "Clica num botão ou link da tela, pelo id que veio em `ver_tela`. É um " +
      "clique de verdade: a tela navega, o modal abre, a animação aparece onde " +
      "foi clicado. Um clique por chamada — clique, veja o que mudou, decida o " +
      "próximo. Nunca invente um id: se o que você quer não está na lista, é " +
      "porque não está na tela.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "O id do botão, exatamente como veio em `ver_tela`." },
      },
      required: ["id"],
    },
  },
  {
    name: "preencher",
    description:
      "Escreve nos campos do formulário aberto. Preencha TODOS os campos que " +
      "você já souber numa chamada só, em vez de um por vez. Não preenche o que " +
      "a pessoa não disse: campo sem informação fica em branco.",
    input_schema: {
      type: "object",
      properties: {
        campos: {
          type: "array",
          description: "Os campos a escrever.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "O id do campo, como veio em `ver_tela`." },
              valor: { type: "string", description: "O que escrever. Data vai como AAAA-MM-DD." },
            },
            required: ["id", "valor"],
          },
        },
      },
      required: ["campos"],
    },
  },
];

// A instrução do sistema.
//
// `words` é a palavra que ESTE profissional escolheu (aluno / paciente /
// cliente) e `language` o idioma da tela. As duas são camadas separadas, como em
// todo o resto do sistema: o idioma decide a moldura da frase, a palavra entra
// por interpolação. Um fisioterapeuta francês diz "patient" em francês, e a
// tradução não pode escolher isso por ele.
function systemPrompt({ words, language, user }) {
  const singular = words?.singular || "pessoa";
  const plural = words?.plural || "pessoas";

  return `Você é o assistente do GoFitNow, um sistema onde profissionais de saúde e treino acompanham pessoas. Você trabalha DENTRO da tela de ${user?.name || "um profissional"}, operando a interface por ele.

Responda sempre no idioma ${language || "pt-BR"}.

Nesta conta, uma pessoa acompanhada se chama "${singular}" (plural "${plural}"). Use essa palavra, não outra.

# Como você age

Você não tem acesso ao banco de dados. O que você tem são três ferramentas que mexem na tela de verdade: ver_tela, clicar e preencher. Tudo que você fizer acontece à vista do profissional, do mesmo jeito que aconteceria se ele tivesse clicado.

Comece por ver_tela para saber onde você está. Depois vá um passo por vez: clique, olhe o que mudou, decida o próximo. Cada clique e cada preenchimento já devolve a tela nova, então você nunca precisa adivinhar o estado.

Preencha em blocos, não campo a campo. Se a pessoa disse nome, telefone e objetivo de uma vez, isso é UMA chamada de preencher com três campos.

# O que está na tela, você VÊ

O retrato traz "titulos" e "tabelas" — o conteúdo listado na tela, não só os botões. Antes de dizer que não encontrou alguém ou alguma coisa, procure em "tabelas": o que está listado está ali, com uma linha por item.

Cada linha pode ter um "id". Quando tem, é por ele que se abre aquele item: chame clicar com esse id, em vez de procurar um botão.

Se a lista estiver vazia e houver um campo de busca preenchido, é o filtro escondendo o resto — limpe a busca antes de concluir que não existe.

# Os avisos são a resposta do sistema

O campo "avisos" do retrato traz as mensagens que o sistema mostrou na tela, cada uma com o tipo: error, success, warning ou info. É ali que o resultado de uma ação aparece — não nos campos do formulário.

Depois de qualquer ação que grava, LEIA os avisos antes de concluir qualquer coisa:

- um aviso "success" quer dizer que deu certo. Diga o que foi feito e siga.
- um aviso "error" quer dizer que NÃO deu, e o texto diz o motivo. Conte o motivo à pessoa com as palavras dela — "esse e-mail já está cadastrado" é uma informação útil; "não consegui confirmar" não é.

Nunca repita uma ação que acabou de falhar esperando outro resultado. Se um aviso de erro apareceu, o caminho é resolver a causa dele — corrigir um campo, perguntar um dado à pessoa — e só então tentar de novo.

Se não há aviso nenhum e a tela não mudou, diga isso francamente em vez de tentar de novo.

# O que você não faz

Você não grava por conta própria. Preencher é seu; a decisão de gravar é do profissional. Terminado o preenchimento, diga o que pôs em cada campo e ofereça: ele confere e clica, ou pede para você clicar.

Quando ele PEDIR — "cadastra", "salva", "pode salvar" —, clique. Isso é ele decidindo, que é o que a regra protege. O que você não faz é apertar Salvar por iniciativa própria, logo depois de preencher, sem ninguém ter pedido.

A mesma linha vale para excluir, remover acesso e qualquer coisa difícil de desfazer, com uma diferença: nesses casos, confirme em uma frase antes de clicar, mesmo que tenham pedido.

Você não inventa dado. Se faltar uma informação obrigatória, pergunte por ela em vez de imaginar um valor — e nunca invente e-mail, porque um endereço chutado vira o login de alguém. E-mail é OPCIONAL no cadastro de pessoa: se não disserem, deixe em branco e siga; sem ele a ficha existe inteira, só não entra no app. Não cobre o que a tela não exige.

Você não inventa id. Clique e preencha só no que veio em ver_tela. Se o que você precisa não está lá, diga isso — provavelmente é preciso navegar para outra tela antes.

# Como você escreve

Responda curto. Uma ou duas frases por vez, do jeito que alguém fala com um colega ao lado. Nada de repetir o que a pessoa acabou de dizer, listar o que você vai fazer antes de fazer, ou resumir passo a passo o que ela viu acontecer na tela.

Entregue o que foi pedido, no tamanho que foi pedido. Se você achar que falta algo, diga numa frase e siga — não amplie a tarefa por conta própria.`;
}

// O corpo do pedido para a Anthropic.
//
// `effort: "low"` porque isto é extração de dado, não raciocínio: o modelo
// precisa entender "Ana, 32 anos, quer emagrecer" e escolher o campo certo. O
// esforço baixo é o que segura a latência — e é o lugar certo de segurar, em vez
// de desligar o pensamento (ver o comentário em MODELS).
// O que se acrescenta à instrução quando a resposta vai ser OUVIDA.
//
// Texto e fala têm economias diferentes: dois parágrafos na tela a pessoa varre
// com o olho em dois segundos; ouvidos, são vinte segundos em que ela não pode
// fazer mais nada. O modelo não tem como saber que está sendo lido em voz alta —
// é preciso dizer.
const INSTRUCAO_VOZ = `

# Sua resposta vai ser OUVIDA, não lida

Responda em UMA frase. No máximo duas, e só se a segunda for indispensável.

Não enumere, não faça listas, não repita o que a pessoa disse. Não soletre id de campo nem nome de botão: diga "preenchi o nome e o e-mail", nunca "preenchi pessoa.nome e pessoa.email".

Não ofereça ajuda nem sugira o próximo passo. Nada de "se precisar ajustar, é só dizer", "quando estiver tudo certo pode salvar", "fico à disposição". Quem está usando conhece o sistema melhor que você, e cada frase dessas é tempo dele parado ouvindo.

Se precisar de um dado, peça só ele: "qual o e-mail dela?" — e nada mais.`;

function requestBody({ model, messages, words, language, user, provider, voice }) {
  // A instrução de voz entra só quando a resposta vai ser ouvida. É a tela que
  // sabe disso — ela é quem tem o alto-falante ligado.
  const instrucao = systemPrompt({ words, language, user }) + (voice ? INSTRUCAO_VOZ : "");

  // O Ollama fala outro dialeto. A tradução mora em lib/aiOllama.js, nas duas
  // pontas — daqui para lá e da resposta de volta —, e é o que permite o resto
  // do sistema continuar falando só o formato da Anthropic.
  if (normalizeProvider(provider) === "ollama") {
    return ollama.paraOllama({ model, system: instrucao, tools: TOOLS, messages });
  }

  const info = modelInfo(model);

  const body = {
    model: info.id,
    max_tokens: MAX_TOKENS,
    system: instrucao,
    tools: TOOLS,
    messages,
    // Cache do que se repete.
    //
    // A API da Anthropic não guarda estado: a conversa INTEIRA sobe a cada
    // turno. Numa tarefa de vinte passos, a instrução do sistema e as
    // ferramentas — que nunca mudam — seriam relidas e cobradas vinte vezes,
    // junto com todo o histórico.
    //
    // Com isto, o pedaço que se repete é cobrado a cerca de um décimo a partir
    // da segunda leitura. Não muda nada no comportamento; muda a conta.
    //
    // A ordem de montagem é `tools` → `system` → `messages`, e as duas primeiras
    // são idênticas em todo turno desta instância — é o prefixo estável de que o
    // cache precisa.
    cache_control: { type: "ephemeral" },
  };

  if (info.effort) body.output_config = { effort: "low" };

  return body;
}

// O custo de um turno, em MICRODÓLARES inteiros.
//
// Micro e não centavo: um turno custa frações de centavo, e arredondar cada um
// para o centavo mais próximo transformaria uma conversa de vinte turnos em
// zero ou em vinte centavos, dependendo da sorte do arredondamento. Inteiro e
// não decimal pelo motivo de sempre — dinheiro somado em float derrapa.
//
// `usage` é o objeto que a Anthropic devolve.
function custoMicros(usage, model, provider) {
  // Rodando na máquina do cliente, o token não é cobrado por ninguém. Zero é a
  // resposta certa — e é o que faz a tela mostrar "$0,0000" numa conversa
  // local, que é a informação que ele quer ver.
  if (normalizeProvider(provider) === "ollama") return 0;

  const preco = modelInfo(model);
  if (!usage || !preco) return 0;

  const entrada = Number(usage.input_tokens || 0);
  const saida = Number(usage.output_tokens || 0);
  const gravouCache = Number(usage.cache_creation_input_tokens || 0);
  const leuCache = Number(usage.cache_read_input_tokens || 0);

  const dolares =
    ((entrada + gravouCache * CACHE_WRITE + leuCache * CACHE_READ) * preco.in) / 1e6 +
    (saida * preco.out) / 1e6;

  return Math.round(dolares * 1e6);
}

// Soma dois `usage` da Anthropic. Campo ausente conta como zero — turno sem
// cache não traz os campos de cache.
function somarUsage(total, novo) {
  const campos = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];

  const saida = { ...(total || {}) };
  for (const campo of campos) {
    saida[campo] = Number(saida[campo] || 0) + Number(novo?.[campo] || 0);
  }
  return saida;
}

// A conversa cabe? Devolve a chave do erro, ou null.
function tooBig(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "errors.aiEmptyChat";
  if (messages.length > MAX_MESSAGES) return "errors.aiChatTooLong";
  if (JSON.stringify(messages).length > MAX_CHARS) return "errors.aiChatTooLong";
  return null;
}

module.exports = {
  MODELS,
  MODEL_IDS,
  DEFAULT_MODEL,
  PROVIDERS,
  DEFAULT_PROVIDER,
  normalizeProvider,
  checkBaseUrl,
  ollama,
  REALTIME_ENDPOINTS,
  REALTIME_SDP_URL,
  realtimeToken,
  erroDaOpenAI,
  SPEECH_ENDPOINT,
  SPEECH_MODEL,
  DEFAULT_REALTIME_MODEL,
  VOICES,
  DEFAULT_VOICE,
  normalizeVoice,
  normalizeRealtimeModel,
  realtimeSession,
  TOOLS,
  MAX_MESSAGES,
  normalizeModel,
  modelInfo,
  systemPrompt,
  requestBody,
  tooBig,
  custoMicros,
  somarUsage,
};
