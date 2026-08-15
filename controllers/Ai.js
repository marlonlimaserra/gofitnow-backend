const ai = require("../lib/ai.js");
const instanceContext = require("../lib/instance.js");
const mcpTools = require("../lib/mcpTools.js");

// Quantas vezes o servidor pode ir ao modelo dentro de UM turno.
//
// Cada volta é uma ferramenta executada e uma pergunta nova. Seis dá para
// "busca o exercício, acrescenta, ajusta as séries, confere" com folga — e é
// baixo o bastante para um laço que se enrosque parar de custar dinheiro.
const MAX_PASSOS_DE_FERRAMENTA = 6;
const tempoReal = require("../lib/tempoReal.js");

// O assistente.
//
// Duas coisas moram aqui: a configuração (chave e modelo) e o proxy para a
// Anthropic. O proxy existe por um motivo só, e é o mais importante deste
// arquivo: a chave NÃO PODE ir para o navegador. O frontend é servido pela
// Cloudflare Pages, público e sem sessão — qualquer coisa embutida no bundle
// está publicada. A tela manda a conversa, o servidor põe a chave.
//
// O que o assistente PODE fazer não se decide aqui. Ele não tem rota para
// gravar nada: devolve pedidos de clique e de preenchimento, o navegador os
// executa na tela de verdade, e quem grava é o mesmo POST que o dedo do
// profissional dispararia. As permissões dele são, literalmente, as da sessão.
module.exports = function (app) {
  const ENDPOINT = "https://api.anthropic.com/v1/messages";

  // Trocável no teste. Em produção é o fetch do próprio Node (26.x).
  const chamar = app.anthropicFetch || fetch;

  // ── Configuração ────────────────────────────────────────────────────────

  // A forma da resposta, UMA vez, para as três rotas.
  //
  // Ela existe por causa de um defeito real: o GET devolvia `models` e
  // `canManage`, o PUT devolvia só o que tinha mudado, e a tela — que troca o
  // estado dela pela resposta do salvar — ficava sem a lista de modelos. O
  // `dados.models.map(...)` do render estourava em `undefined` e a tela ia a
  // branco DEPOIS de gravar certo: o pior formato de erro, porque parece que
  // não salvou.
  //
  // Uma rota que devolve um recurso devolve o recurso INTEIRO. "Só o que mudou"
  // obriga cada chamador a lembrar o que veio junto e o que não veio.
  function resposta(user, settings) {
    return {
      ...settings,
      models: ai.MODEL_IDS,
      providers: ai.PROVIDERS,
      voices: ai.VOICES,
      // Ver a configuração é uma coisa, mexer nela é outra. A tela usa isto
      // para mostrar o formulário ou só o estado.
      canManage: app.helpers.ReqProtected.has(user, "ai.manage"),
    };
  }

  // Quem pode USAR precisa saber se está configurado — é o que decide entre
  // abrir o chat e mandar a pessoa para as configurações. A chave nunca vem.
  app.get("/me/ai", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    res.send(resposta(user, await app.api.ai.settings()));
  });

  app.put("/me/ai", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.manage");
    if (user === false) return;

    // Uma chave de API não configura outra chave de API. É decisão de conta e
    // de custo, e o dono está na tela quando a toma — mesma regra do domínio.
    if (req._viaApiKey) {
      return res
        .status(403)
        .send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
    }

    const provider = ai.normalizeProvider(req.body?.provider);
    const chave = String(req.body?.key || "").trim();
    let baseUrl = "";

    if (provider === "ollama") {
      // O endereço é a única entrada do sistema em que alguém escolhe para onde
      // o NOSSO servidor faz uma requisição. A conferência recusa endereço
      // interno — ver o comentário em lib/ai.js#checkBaseUrl.
      const conferido = ai.checkBaseUrl(req.body?.baseUrl);
      if (!conferido.ok) {
        const chaves = {
          private: "errors.aiPrivateUrl",
          required: "errors.aiInvalidUrl",
          invalid: "errors.aiInvalidUrl",
        };
        return res.status(400).send({ msg: req.t(chaves[conferido.erro]), code: conferido.erro });
      }
      baseUrl = conferido.url;

      if (!ai.normalizeModel(req.body?.model, provider)) {
        return res.status(400).send({ msg: req.t("errors.aiInvalidModel"), code: "invalid_model" });
      }
    } else if (chave && !chave.startsWith("sk-ant-")) {
      // Formato conferido antes de gravar: uma chave colada pela metade só
      // apareceria como erro da Anthropic no meio de uma conversa, e ninguém
      // ligaria uma coisa à outra.
      return res.status(400).send({ msg: req.t("errors.aiInvalidKey"), code: "invalid_key" });
    }

    // A chave da OpenAI tem prefixo próprio. Conferir aqui evita que uma chave
    // colada no campo errado só apareça como erro no meio de uma conversa.
    const chaveVoz = String(req.body?.realtimeKey || "").trim();
    if (chaveVoz && !chaveVoz.startsWith("sk-")) {
      return res.status(400).send({ msg: req.t("errors.aiInvalidVoiceKey"), code: "invalid_key" });
    }

    const salvo = await app.api.ai.save({
      provider,
      key: chave,
      baseUrl,
      model: req.body?.model,
      realtimeKey: chaveVoz,
      realtimeModel: req.body?.realtimeModel,
      realtimeVoice: req.body?.realtimeVoice,
    });
    if (!salvo) return res.status(400).send({ msg: req.t("errors.aiNoOwner") });

    app.insertUserActionHistory(req, user, "update_ai_settings", {
      category: "admin",
      local: { target_type: "tenants", target_id: String(user._id) },
      // A chave não entra no log. Nem inteira, nem em pedaço: o histórico é
      // lido na tela por outras pessoas.
      extra: { model: salvo.model, key: chave ? "changed" : "kept" },
    });

    res.send(resposta(user, salvo));
  });

  app.delete("/me/ai/key", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.manage");
    if (user === false) return;

    const salvo = await app.api.ai.remove();
    if (!salvo) return res.status(400).send({ msg: req.t("errors.aiNoOwner") });

    app.insertUserActionHistory(req, user, "update_ai_settings", {
      category: "admin",
      local: { target_type: "tenants", target_id: String(user._id) },
      extra: { model: salvo.model, key: "removed" },
    });

    res.send(resposta(user, salvo));
  });

  // ── A conversa ──────────────────────────────────────────────────────────

  // Um turno. A tela manda a conversa inteira (a API da Anthropic não guarda
  // estado), o servidor acrescenta modelo, instrução e ferramentas, e devolve a
  // resposta crua — inclusive os pedidos de ferramenta, que é o que a tela
  // executa antes de chamar de novo.
  // Executa uma ferramenta DO SERVIDOR pedida pelo modelo.
  //
  // É o mesmo caminho da porta MCP — a permissão da tela, o histórico e o aviso
  // de tempo real. Uma segunda implementação aqui seria uma segunda regra, e a
  // divergência apareceria como "pela conversa deixa, pelo MCP não".
  async function executarFerramenta(req, user, nome, entrada) {
    const ferramenta = mcpTools.achar(nome);
    if (!ferramenta) return { ok: false, erro: "ferramenta_desconhecida" };

    if (!app.helpers.ReqProtected.has(user, ferramenta.permissao)) {
      return { ok: false, erro: "sem_permissao", detalhe: ferramenta.permissao };
    }

    let saida;
    try {
      saida = await ferramenta.executar(app, user, entrada || {});
    } catch (error) {
      console.error("[ai] ferramenta", nome, error);
      return { ok: false, erro: "falha_interna" };
    }

    if (saida?.ok && saida.alvo) {
      try {
        tempoReal.avisar(instanceContext.current(), String(user._id), "assistente:alvo", {
          ferramenta: nome,
          ...saida.alvo,
        });
      } catch (error) {
        // A tela não acompanhar não desfaz o que já foi gravado.
      }
    }

    if (saida?.ok) {
      app.insertUserActionHistory(req, user, "mcp_tool", {
        category: "admin",
        local: { target_type: "mcp", target_id: nome },
        extra: { ferramenta: nome, argumentos: entrada || {}, via: "conversa" },
      });
    }

    return saida;
  }

  // A porta para o TURNO MISTO.
  //
  // Quando o modelo pede, no mesmo turno, uma ferramenta do servidor e uma da
  // tela, o laço lá de baixo não pode resolver sozinho: o protocolo exige uma
  // resposta para CADA pedido, e metade delas depende do navegador. Então a
  // tela executa as dela e pede as nossas por aqui.
  app.post("/ai/tool", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const saida = await executarFerramenta(req, user, req.body?.name, req.body?.input);
    res.send(saida);
  });

  app.post("/ai/chat", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const credenciais = await app.api.ai.credentials();
    if (!credenciais) {
      return res.status(400).send({ msg: req.t("errors.aiNotConfigured"), code: "not_configured" });
    }

    const messages = req.body?.messages;
    const grande = ai.tooBig(messages);
    if (grande) return res.status(400).send({ msg: req.t(grande), code: "chat_too_long" });

    const local = credenciais.provider === "ollama";

    // A conversa CRESCE dentro deste turno.
    //
    // Quando o modelo pede uma ferramenta do SERVIDOR, quem executa somos nós —
    // e aí ele precisa ver o resultado para seguir. Devolver isso para a tela e
    // esperar ela voltar seria uma ida e volta de rede por passo, que é
    // exatamente o custo que a porta de ferramentas veio tirar.
    //
    // O laço para quando o modelo escreve texto ou pede algo que só o navegador
    // faz (ver_tela, clicar, preencher).
    let conversa = messages;
    let dados = null;
    let usoTotal = null;

    for (let passo = 0; passo < MAX_PASSOS_DE_FERRAMENTA; passo++) {
    const body = ai.requestBody({
      provider: credenciais.provider,
      model: credenciais.model,
      messages: conversa,
      language: req.lang,
      user,
      // A palavra que ESTE profissional escolheu. Vem da conta de quem está
      // conversando, não de uma constante: é a mesma separação de sempre entre
      // idioma e vocabulário.
      words: { singular: user.peopleSingular, plural: user.peoplePlural },
      // A tela avisa que a resposta vai ser OUVIDA. Só ela sabe — é quem tem o
      // alto-falante ligado —, e a diferença é grande: dois parágrafos lidos com
      // o olho levam dois segundos; ouvidos, vinte.
      voice: Boolean(req.body?.voice),
    });

    // Para onde e com que credencial. É a única diferença de transporte entre os
    // dois provedores — o resto (limite, gravação, resposta) é o mesmo caminho.
    const destino = local ? credenciais.baseUrl + "/v1/chat/completions" : ENDPOINT;
    const cabecalhos = local
      ? {
          "content-type": "application/json",
          // O ngrok gratuito entrega uma PÁGINA DE AVISO em vez da resposta
          // quando não reconhece o cliente. Este cabeçalho a desliga — sem ele,
          // a primeira chamada volta HTML e o erro aparece como "resposta
          // ilegível", que não diz nada sobre a causa.
          "ngrok-skip-browser-warning": "1",
        }
      : {
          "content-type": "application/json",
          "x-api-key": credenciais.key,
          "anthropic-version": "2023-06-01",
        };

    let resposta;
    try {
      resposta = await chamar(destino, {
        method: "POST",
        headers: cabecalhos,
        body: JSON.stringify(body),
        // Um modelo local numa placa apertada leva dezenas de segundos por
        // passo. O tempo padrão do fetch cortaria a resposta no meio e pareceria
        // erro de rede.
        signal: AbortSignal.timeout(local ? 300000 : 120000),
      });
    } catch (error) {
      // Rede: ninguém respondeu. Não é erro da conversa, e dizer isso evita a
      // pessoa procurar defeito no que ela escreveu.
      const chave = local ? "errors.aiOllamaUnreachable" : "errors.aiUnreachable";
      return res.status(502).send({ msg: req.t(chave), code: "unreachable" });
    }

    const cru = await resposta.json().catch(() => null);
    // A resposta do Ollama vem no dialeto da OpenAI e é traduzida aqui, na
    // borda. Daqui para baixo o código é um só.
    dados = local && resposta.ok ? ai.ollama.daResposta(cru) : cru;

    if (!resposta.ok) {
      // O erro da Anthropic é repassado com o CÓDIGO dela e uma frase nossa.
      // Chave errada e cota estourada são coisas diferentes, e a tela precisa
      // dizer qual — mas o texto cru vem em inglês, e esta tela fala quatro
      // idiomas.
      // O Ollama não usa os códigos da Anthropic. O erro dele quase sempre é
      // um só na prática — modelo que não foi baixado — e vale dizer isso em
      // vez de repassar um texto em inglês sobre "model not found".
      if (local) {
        return res
          .status(502)
          .send({ msg: req.t("errors.aiOllamaFailed"), code: "ollama_error" });
      }

      const tipo = cru?.error?.type || "";
      const chaves = {
        authentication_error: "errors.aiBadKey",
        permission_error: "errors.aiBadKey",
        rate_limit_error: "errors.aiRateLimited",
        invalid_request_error: "errors.aiRejected",
      };

      return res.status(resposta.status === 401 || resposta.status === 403 ? 400 : 502).send({
        msg: req.t(chaves[tipo] || "errors.aiFailed"),
        code: tipo || "unknown",
      });
    }

    // Os classificadores da Anthropic recusaram. Vem como 200 com
    // `stop_reason: "refusal"` e `content` vazio — quem ler `content[0]` sem
    // conferir isto quebra numa resposta bem-sucedida.
    if (dados?.stop_reason === "refusal") {
      return res.status(200).send({ refusal: true, msg: req.t("errors.aiRefused") });
    }

    // O gasto de TODOS os passos deste turno, somado: cada ida ao modelo custa,
    // e mostrar só a última faria o turno parecer barato.
    usoTotal = ai.somarUsage(usoTotal, dados?.usage);

    // O que o modelo pediu, separado por quem executa.
    const pedidos = (dados?.content || []).filter((c) => c.type === "tool_use");
    const doServidor = pedidos.filter((c) => ai.NOMES_DO_SERVIDOR.has(c.name));

    // Só seguimos sozinhos quando TUDO no turno é nosso. Um turno misto —
    // ferramenta nossa e clique na mesma resposta — não pode ser resolvido pela
    // metade: o protocolo exige uma resposta para cada pedido, e as do
    // navegador só ele tem. Nesse caso a tela recebe o turno inteiro e pede as
    // nossas por `/ai/tool`.
    if (!doServidor.length || doServidor.length !== pedidos.length) break;

    const resultados = [];
    for (const pedido of doServidor) {
      const saida = await executarFerramenta(req, user, pedido.name, pedido.input);
      resultados.push({
        type: "tool_result",
        tool_use_id: pedido.id,
        content: JSON.stringify(saida),
        ...(saida?.ok === false ? { is_error: true } : {}),
      });
    }

    conversa = [
      ...conversa,
      { role: "assistant", content: dados.content },
      { role: "user", content: resultados },
    ];
    }

    // ── A partir daqui a resposta é boa; o que falta é guardar ────────────
    //
    // A gravação nunca derruba o turno. A pessoa está no meio de uma tarefa, e
    // uma falha de escrita no histórico não pode custar a resposta que já foi
    // paga à Anthropic. Se falhar, perde-se o registro daquele turno — o
    // próximo regrava a conversa inteira de qualquer forma.
    let sessao = null;
    try {
      sessao = await app.api.aiSession.registrarTurno({
        sessionId: req.body?.sessionId,
        userId: user._id,
        model: credenciais.model,
        // A conversa COM a resposta nova: o que a tela mandou mais o que
        // acabou de voltar. Sem isto, a última fala do assistente ficaria de
        // fora até o turno seguinte — e numa conversa que termina, para sempre.
        messages: [...conversa, { role: "assistant", content: dados?.content || [] }],
        usage: usoTotal,
        provider: credenciais.provider,
      });
    } catch (error) {
      // Fica para o próximo turno.
    }

    // E o contador no central: quanto, de qual cliente. Sem uma linha da
    // conversa — ver Center_model#registrarUsoIa.
    if (sessao) {
      try {
        await app.api.center.registrarUsoIa({
          instance: instanceContext.required(),
          sessionId: String(sessao._id),
          model: credenciais.model,
          usage: usoTotal,
          costMicros: ai.custoMicros(usoTotal, credenciais.model, credenciais.provider),
        });
      } catch (error) {
        // O central estar fora não pode derrubar a conversa do cliente.
      }
    }

    res.send({
      content: dados?.content || [],
      stop_reason: dados?.stop_reason || null,
      model: dados?.model || credenciais.model,
      usage: usoTotal || null,
      // A conversa CRESCEU aqui dentro quando o servidor executou ferramenta.
      // A tela precisa da versão nova, senão o próximo turno mandaria de volta
      // uma conversa sem os resultados e o modelo repetiria o que já fez.
      messages: conversa !== messages ? conversa : undefined,
      // A tela guarda isto e devolve no próximo turno — é o que costura os
      // turnos numa conversa só.
      sessionId: sessao ? String(sessao._id) : null,
      // O acumulado DA SESSÃO, não deste turno: é o número que a pessoa quer
      // ver ("esta conversa custou X"), e somá-lo na tela seria repetir aqui uma
      // conta que o banco já faz.
      sessionCostMicros: sessao?.costMicros ?? null,
      sessionTurns: sessao?.turns ?? null,
    });
  });

  // ── Modo conversa ───────────────────────────────────────────────────────

  // Cria uma sessão de voz e devolve um token EFÊMERO.
  //
  // A chave da OpenAI não vai para o navegador, pelo mesmo motivo da chave da
  // Anthropic: o bundle é público. Mas aqui há um problema a mais — o áudio
  // precisa ir do microfone direto para a OpenAI, sem passar por nós (um proxy
  // de áudio em tempo real acrescentaria latência justamente onde ela dói).
  //
  // A saída é o token de vida curta (~1 minuto, só para abrir a conexão): o
  // navegador ganha permissão para CONVERSAR, e não a chave da conta. E a
  // instrução e as ferramentas vão presas a ele, daqui — o navegador não tem
  // como reescrever quem o assistente é.
  app.post("/ai/realtime/session", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const credenciais = await app.api.ai.realtimeCredentials();
    if (!credenciais) {
      return res
        .status(400)
        .send({ msg: req.t("errors.aiVoiceNotConfigured"), code: "not_configured" });
    }

    // Tenta a forma nova e, se o endereço não existir naquela conta, a antiga.
    // O endpoint mudou quando o tempo real saiu de beta, e as duas convivem no
    // mundo — amarrar numa só faz o recurso quebrar a cada renomeação da OpenAI.
    let ultimo = null;

    for (const tentativa of ai.REALTIME_ENDPOINTS) {
      const corpo = ai.realtimeSession({
        model: credenciais.model,
        voice: credenciais.voice,
        language: req.lang,
        user,
        words: { singular: user.peopleSingular, plural: user.peoplePlural },
        envelope: tentativa.envelope,
      });

      let resposta;
      try {
        resposta = await chamar(tentativa.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + credenciais.key,
          },
          body: JSON.stringify(corpo),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        return res
          .status(502)
          .send({ msg: req.t("errors.aiVoiceUnreachable"), code: "unreachable" });
      }

      const dados = await resposta.json().catch(() => null);

      if (resposta.ok) {
        const token = ai.realtimeToken(dados);
        if (!token) {
          ultimo = { status: 502, detalhe: "resposta sem token", code: "no_token" };
          continue;
        }

        return res.send({
          // O que o navegador usa para abrir a conexão, e só isso.
          token,
          // O endereço da oferta vai junto para viver num lugar só: se a OpenAI
          // mudá-lo, muda no servidor e a tela nem fica sabendo.
          sdpUrl: ai.REALTIME_SDP_URL,
          model: credenciais.model,
          voice: credenciais.voice,
        });
      }

      ultimo = ai.erroDaOpenAI(dados, resposta.status);

      // 404 e "Invalid URL" são "este endereço não existe aqui" — vale tentar o
      // outro. Chave inválida ou cota estourada não melhoram com outro endereço.
      const enderecoErrado =
        resposta.status === 404 || /invalid url/i.test(ultimo.detalhe || "");
      if (!enderecoErrado) break;
    }

    // A mensagem da OpenAI vai JUNTO da nossa. A nossa diz o que fazer ("sua
    // conta está sem créditos"); a dela é o que se cola numa busca quando a
    // nossa não bastar.
    res.status(ultimo?.status || 502).send({
      msg:
        req.t(ultimo?.chave || "errors.aiVoiceFailed") +
        (ultimo?.detalhe ? " (" + ultimo.detalhe + ")" : ""),
      code: ultimo?.code || "voice_error",
    });
  });

  // O registro da conversa POR VOZ.
  //
  // O modo voz fala direto com a OpenAI pelo navegador — é isso que o torna
  // rápido, e é isso que o deixava fora do histórico. Consequência prática: um
  // defeito relatado por voz não tinha como ser investigado. "Ela diz que não
  // achou" chegava sem o retrato da tela que ela estava olhando, e o conserto
  // virava adivinhação.
  //
  // A tela manda o que aconteceu — o que foi dito dos dois lados, quais
  // ferramentas rodaram e o que cada uma devolveu. O custo fica em zero: a
  // cobrança do tempo real é da OpenAI, por minuto de áudio, e não temos o
  // número. Registrar um valor inventado seria pior que registrar nenhum.
  app.post("/ai/voice/log", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).send({ msg: req.t("errors.aiEmptyLog"), code: "empty_log" });
    }

    // O mesmo teto do modo escrita: uma conversa longa demais para ser mandada
    // também é longa demais para ser gravada.
    const grande = ai.tooBig(messages);
    if (grande) return res.status(400).send({ msg: req.t(grande), code: "chat_too_long" });

    let sessao = null;
    try {
      sessao = await app.api.aiSession.registrarTurno({
        sessionId: req.body?.sessionId,
        userId: user._id,
        model: String(req.body?.model || "gpt-realtime").slice(0, 80),
        messages,
        usage: null,
        provider: "openai",
      });
    } catch (error) {
      // Perder o registro nunca pode derrubar a conversa: a pessoa está no meio
      // de uma tarefa, falando.
    }

    res.send({ sessionId: sessao ? String(sessao._id) : null });
  });

  // Falar um texto em voz de verdade.
  //
  // O Claude continua pensando e dirigindo a tela; quem empresta a voz é a
  // OpenAI. É a combinação que o `speechSynthesis` do navegador não dá: aquele
  // toca a voz instalada no sistema operacional — a mesma do leitor de tela —, e
  // nenhum ajuste a torna natural, porque não há modelo nenhum ali.
  //
  // Reusa a MESMA chave do modo conversa: quem já pagou por uma não precisa de
  // duas.
  app.post("/ai/speak", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const credenciais = await app.api.ai.realtimeCredentials();
    if (!credenciais) {
      return res.status(400).send({ msg: req.t("errors.aiVoiceNotConfigured"), code: "not_configured" });
    }

    // Teto de tamanho: a fala dele é curta por instrução, e um texto gigante
    // aqui seria minutos de áudio gerados de uma vez — caro e inútil, porque
    // ninguém escuta um parágrafo de assistente até o fim.
    const texto = String(req.body?.text || "").trim().slice(0, 1200);
    if (!texto) return res.status(400).send({ msg: req.t("errors.aiEmptyChat") });

    let resposta;
    try {
      resposta = await chamar(ai.SPEECH_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + credenciais.key,
        },
        body: JSON.stringify({
          model: ai.SPEECH_MODEL,
          voice: credenciais.voice,
          input: texto,
          // MP3 porque toda tag <audio> toca sem ajuda. Formatos melhores
          // exigiriam decodificação por conta nossa.
          response_format: "mp3",
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      return res.status(502).send({ msg: req.t("errors.aiVoiceUnreachable"), code: "unreachable" });
    }

    if (!resposta.ok) {
      const dados = await resposta.json().catch(() => null);
      const erro = ai.erroDaOpenAI(dados, resposta.status);
      return res.status(erro.status).send({
        msg: req.t(erro.chave) + (erro.detalhe ? " (" + erro.detalhe + ")" : ""),
        code: erro.code,
      });
    }

    const audio = Buffer.from(await resposta.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(audio.length));
    res.send(audio);
  });

  // ── O histórico ─────────────────────────────────────────────────────────

  app.get("/ai/sessions", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const linhas = await app.api.aiSession.listar(user._id, req.query.limit);

    res.send({
      rows: linhas.map((s) => ({
        _id: String(s._id),
        title: s.title,
        model: s.model,
        turns: s.turns,
        costMicros: s.costMicros,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
  });

  app.get("/ai/sessions/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const sessao = await app.api.aiSession.data(req.params.id, user._id);
    if (!sessao) return res.status(404).send({ msg: req.t("errors.aiSessionNotFound") });

    res.send({
      _id: String(sessao._id),
      title: sessao.title,
      model: sessao.model,
      messages: sessao.messages || [],
      usage: sessao.usage || null,
      costMicros: sessao.costMicros || 0,
      turns: sessao.turns || 0,
      createdAt: sessao.createdAt,
    });
  });

  app.delete("/ai/sessions/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.use");
    if (user === false) return;

    const apagou = await app.api.aiSession.remover(req.params.id, user._id);
    if (!apagou) return res.status(404).send({ msg: req.t("errors.aiSessionNotFound") });

    res.send({ ok: true });
  });

  // Quanto a IA custou para este cliente. Uma pergunta do NEGÓCIO, então exige
  // a permissão de quem cuida da configuração, não a de quem conversa.
  app.get("/ai/usage", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "ai.manage");
    if (user === false) return;

    const dias = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

    res.send({ days: dias, ...(await app.api.aiSession.resumo(desde)) });
  });
};
