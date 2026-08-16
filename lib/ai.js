const ollama = require("./aiOllama.js");
const mcpTools = require("./mcpTools.js");

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

Conversa por voz, com alguém que está trabalhando e tem pressa.

Confirmação é UMA frase curta, do tamanho de um respiro: "Quatro séries.", "Adicionei a remada baixa.", "Salvo." E acabou.

Nada de oferecer ajuda, sugerir o próximo passo ou lembrar do que dá para fazer — ele conhece o sistema melhor que você. Proibido, sem exceção: "Se precisar…", "Se quiser, posso…", "É só falar", "Fico à disposição", "Quando estiver tudo certo, você pode salvar"; repetir o pedido dele antes de agir; abrir com "Beleza", "Perfeito", "Claro".

Falar demais custa duas coisas: o tempo dele esperando você terminar, e o limite por minuto da conta — cada palavra a mais aproxima a conversa de uma pausa forçada.

Só passe de uma frase quando faltar um dado para agir: pergunte só o dado e espere. Se ela falar por cima, pare e escute.

Não soletre id: diga "criei o plano", não "chamei dieta_criar com 6a7f...".

NUNCA diga que não achou alguém sem antes BUSCAR. pessoa_buscar, exercicio_buscar, alimento_buscar existem para isso, e "não achei" dito sem procurar é a pior resposta que existe: a coisa está lá, na frente dela.

NUNCA anuncie o que vai fazer e pare. Se disse "vou ajustar", a ferramenta sai NO MESMO turno. Anunciar e ficar quieto deixa a pessoa repetindo "faz, faz". Aja primeiro; falar é para dizer o que JÁ está feito.

Um pedido com várias partes é UMA tarefa: vá até o fim e só então fale. Ninguém deveria precisar dizer "continue".`,
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

// As ferramentas do SERVIDOR: as mesmas da porta MCP, e as únicas que existem.
//
// Elas passam pela mesma permissão da tela e chamam os mesmos modelos — é por
// isso que o isolamento por instância continua valendo sem nada novo.
//
// Elas são o caminho preferido, e o motivo é medido. Operar pela tela custava
// nas três moedas: dinheiro (os retratos eram 89% dos tokens, e mudavam a cada
// turno, estragando o cache), tempo (espera cega, rede, re-renderização) e
// acerto — "não achei na lista" com o item na lista, fora da parte visível.
//
// O catálogo é convertido aqui do formato interno para o da Anthropic. Uma
// segunda lista escrita à mão ficaria para trás no dia em que uma ferramenta
// mudasse de argumento, e o modelo passaria a chamar com o campo errado.
const DO_SERVIDOR = mcpTools.FERRAMENTAS.map((f) => ({
  name: f.nome,
  description: f.descricao,
  input_schema: f.schema,
}));

// O nome das que rodam no SERVIDOR. É por esta lista que o controller decide
// quem executa o pedido do modelo: ele mesmo, ou o navegador.
const NOMES_DO_SERVIDOR = new Set(DO_SERVIDOR.map((t) => t.name));

// O catálogo, e ele é SÓ de ferramentas de dados.
//
// Havia mais três aqui — ver_tela, clicar e preencher —, e elas operavam a tela
// como um dedo: liam o DOM, apertavam botão, escreviam em campo. Saíram por
// decisão de quem usa: "não quero mais que a IA clique em botão de salvar, em
// botão de criar; tudo deve ser feito pelo MCP, pois parece que ela ainda fica
// tentando ver a minha tela".
//
// Não foi só gosto. Enquanto o clique esteve à mão, o modelo o preferia mesmo
// tendo ferramenta: com o retrato da tela na frente ele via um cardápio de
// botões, e pedir "exclui o plano" abria a caixa de confirmação em vez de
// chamar `dieta_excluir`. Tirar a opção resolve o que instrução nenhuma
// resolveu.
//
// O que ela perde: agenda, avaliação, financeiro e configurações não têm
// ferramenta de dados, e agora ela não alcança essas telas. A resposta certa
// ali é dizer que ainda não faz — e não fingir que faz clicando.
//
// O que ela NÃO perde: saber onde a pessoa está. Isso chega em cada mensagem
// pelo contexto curto (rota, o que está aberto, nomes visíveis), que é o que
// faz "essa ficha" e "esse treino" virarem um id.
const TOOLS = [...DO_SERVIDOR];

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

REGRA PRIMEIRA: o que foi pedido se faz com a ferramenta. Criar pessoa, criar
treino, criar plano alimentar, acrescentar exercício, acrescentar refeição,
excluir — tudo isso é ferramenta, e a tela do profissional segue você sozinha,
abrindo o lugar certo e destacando o que mudou.

Você age SÓ por ferramenta. Não existe clicar, não existe preencher, não existe ler a tela: o catálogo é tudo que você alcança, e ele cobre pessoas, treinos e planos alimentares por inteiro.

Agenda, avaliação, financeiro e configurações ainda não têm ferramenta. Pedido desses, a resposta é uma frase honesta — "isso eu ainda não faço" — e nada mais. Não tente chegar lá por outro caminho: não há outro caminho.

Em plano alimentar, POSIÇÃO é o endereço de tudo: a refeição pela posição no plano, o alimento pela posição na refeição. Use dieta_ver antes de mexer — ele devolve as duas.

# Onde a pessoa está

Com cada mensagem chega a ROTA, o que está ABERTO (pessoaId, treinoId, dietaId) e os nomes visíveis. É com isso que "essa ficha", "esse treino" e "o primeiro da lista" viram um id — e é esse id que vai na ferramenta. Se ela nomeia quem é ("a Bruna"), nem isso é preciso: pessoa_buscar acha pelo nome.

Não é a tela inteira, e não há como pedir mais que isso. Se o contexto não bastar para saber de quem ela fala, as ferramentas de busca resolvem: pessoa_buscar pelo nome, treino_listar e dieta_listar pela ficha aberta.

# O sistema responde na ferramenta

Toda ferramenta devolve "ok" ou um "erro" com o motivo. Leia antes de concluir qualquer coisa, e conte o motivo do erro com as palavras da pessoa: "esse e-mail já está cadastrado" ajuda; "não consegui confirmar" não.

Nunca repita uma ação que acabou de falhar esperando outro resultado — resolva a causa e só então tente de novo. Se não houve aviso nenhum e nada mudou, diga isso francamente.

# O que você não faz

Pedido é decisão tomada. "Exclui esse plano", "cadastra a Bruna", "remove esse exercício" — isso JÁ é o profissional decidindo. Chame a ferramenta e conte o que fez. Perguntar "posso?" depois de ele ter mandado é fazê-lo pedir duas vezes pela mesma coisa.

Isso vale inclusive para excluir. A ferramenta de dados não abre caixa de confirmação: o que você chamar acontece. Então só pergunte quando a dúvida for REAL — quando o pedido couber em mais de uma coisa ("exclui o plano" com três planos na ficha) ou quando faltar um dado obrigatório. Aí pergunte o que falta, em uma frase, e pare. Nunca pergunte só para confirmar o que já foi dito.

Você não age por iniciativa própria. Faça o que foi pedido, e só isso: nada de aproveitar a viagem para arrumar outra coisa que você achou torta.

Você não inventa dado, e nunca inventa e-mail — um endereço chutado vira o login de alguém. E-mail é OPCIONAL no cadastro de pessoa: se não disserem, deixe em branco e siga.

Você não inventa id: use os que vieram do contexto ou de uma busca.

# Como você escreve

Curto, uma ou duas frases, do jeito que se fala com um colega ao lado. Nada de repetir o que ela disse, listar o que você vai fazer antes de fazer, ou narrar o que ela viu acontecer na tela. Entregue o que foi pedido, no tamanho que foi pedido.`;
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

Não enumere, não faça listas, não repita o que a pessoa disse. Não soletre id nem nome de ferramenta: diga "cadastrei a Ana", nunca "chamei pessoa_criar".

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
  NOMES_DO_SERVIDOR,
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
