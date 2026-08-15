// O tradutor entre o formato da Anthropic e o do Ollama.
//
// O Ollama fala o dialeto da OpenAI em `/v1/chat/completions`. São formatos
// parecidos e diferentes o bastante para não dar para fingir que são o mesmo:
//
//   Anthropic                          OpenAI / Ollama
//   ─────────────────────────────      ──────────────────────────────────
//   system: "…" (campo próprio)        messages[0] = {role:"system"}
//   content: [blocos]                  content: string + tool_calls[]
//   {type:"tool_use", id, input}       tool_calls[].function.arguments (STRING)
//   {type:"tool_result", tool_use_id}  {role:"tool", tool_call_id}
//   stop_reason: "tool_use"            finish_reason: "tool_calls"
//
// A tradução acontece SÓ AQUI, nas duas pontas da chamada. O resto do sistema —
// o laço da tela, o histórico, a gravação da sessão — continua falando o
// formato da Anthropic e não sabe que existe outro provedor. Trocar de modelo
// não pode significar reescrever a tela.

// Anthropic → OpenAI.
function paraOllama({ system, tools, messages, model, numCtx }) {
  const convertidas = [{ role: "system", content: system }];

  for (const m of messages) {
    const blocos = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];

    // Os resultados de ferramenta viram mensagens PRÓPRIAS, uma por resultado.
    // Na Anthropic eles são blocos dentro de uma mensagem de usuário; aqui cada
    // um é uma mensagem de papel "tool". Empacotar os dois jeitos igual faria o
    // modelo receber o resultado como se fosse fala da pessoa.
    const resultados = blocos.filter((b) => b.type === "tool_result");
    if (resultados.length) {
      for (const r of resultados) {
        convertidas.push({
          role: "tool",
          tool_call_id: r.tool_use_id,
          content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
        });
      }
      continue;
    }

    const texto = blocos
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    const chamadas = blocos
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function",
        // `arguments` é STRING de JSON, não objeto. É o erro clássico deste
        // formato, e o sintoma é o modelo receber os argumentos vazios.
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));

    if (m.role === "assistant") {
      convertidas.push({
        role: "assistant",
        content: texto,
        ...(chamadas.length ? { tool_calls: chamadas } : {}),
      });
    } else {
      convertidas.push({ role: "user", content: texto });
    }
  }

  return {
    model,
    messages: convertidas,
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
    stream: false,
    // O contexto do Ollama vem com 4096 por padrão, e a instrução mais UM
    // retrato de tela já passam de 1.500 tokens. Sem subir isto, o modelo perde
    // o começo da conversa e passa a inventar id de botão — e quem estiver
    // olhando vai achar que o modelo é ruim, quando o problema é configuração.
    options: { num_ctx: numCtx || 16384 },
  };
}

// OpenAI → Anthropic.
function daResposta(dados) {
  const escolha = dados?.choices?.[0];
  const msg = escolha?.message || {};
  const content = [];

  if (msg.content && String(msg.content).trim()) {
    content.push({ type: "text", text: String(msg.content) });
  }

  for (const chamada of msg.tool_calls || []) {
    let input = {};
    try {
      // Modelo pequeno erra JSON com alguma frequência. Argumento ilegível vira
      // objeto vazio em vez de exceção: a ferramenta recusa com um motivo que o
      // modelo consegue ler e corrigir, que é melhor que a conversa morrer.
      input = JSON.parse(chamada?.function?.arguments || "{}");
    } catch (error) {
      input = {};
    }

    content.push({
      type: "tool_use",
      id: chamada.id || "call_" + content.length,
      name: chamada?.function?.name,
      input,
    });
  }

  const pediuFerramenta = (msg.tool_calls || []).length > 0;

  return {
    content,
    stop_reason: pediuFerramenta ? "tool_use" : escolha?.finish_reason === "length" ? "max_tokens" : "end_turn",
    model: dados?.model,
    usage: {
      input_tokens: dados?.usage?.prompt_tokens || 0,
      output_tokens: dados?.usage?.completion_tokens || 0,
    },
  };
}

module.exports = { paraOllama, daResposta };
