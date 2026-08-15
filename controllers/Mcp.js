const tools = require("../lib/mcpTools.js");
const tempoReal = require("../lib/tempoReal.js");
const instanceContext = require("../lib/instance.js");

// A porta MCP: onde um modelo opera o sistema por FERRAMENTA, e não pela tela.
//
// O assistente de hoje lê o DOM, procura o botão e clica. Funciona, e custa nas
// três moedas: dinheiro (os retratos de tela eram 89% dos tokens, e mudavam a
// cada turno, o que estragava o cache de prefixo), tempo (espera cega, rede,
// re-renderização, releitura) e acerto — "não achei na lista" com o item na
// lista, só que fora da parte visível.
//
// Aqui ele chama `exercicio_buscar` e recebe o id. Não tem lista para procurar.
//
// ── Por que MCP, e não uma rota nossa qualquer ─────────────────────────────
//
// Porque a mesma porta serve dois clientes: o assistente de dentro do produto e
// qualquer cliente de fora (Claude Desktop, um agente do próprio cliente, uma
// automação). MCP é JSON-RPC 2.0 com três métodos que importam — `initialize`,
// `tools/list` e `tools/call` — e isso cabe num controller.
//
// ── O que ela NÃO é ────────────────────────────────────────────────────────
//
// Não é uma porta com regra própria. Toda ferramenta chama o MESMO modelo que o
// controller da tela chama, e passa pela MESMA permissão. Sem isso, o dia em que
// a regra da tela mudar, a da ferramenta fica para trás — e ninguém percebe,
// porque nada quebra: só passa a aceitar o que não devia.
const VERSAO_PROTOCOLO = "2025-06-18";

module.exports = function (app) {
  // A resposta do JSON-RPC. `id` nulo é notificação: ela não responde.
  function ok(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  function falha(id, code, message, data) {
    return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
  }

  app.post("/mcp", async function (req, res) {
    // A sessão é a mesma do app, ou uma chave de API — as duas portas que o
    // `ReqProtected` já conhece. A permissão de CADA ferramenta é conferida
    // depois, na chamada: `tools/list` pode ser respondido por qualquer um que
    // esteja autenticado, e é bom que seja — o modelo precisa saber o que
    // existe para dizer "não posso fazer isso" com precisão.
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const corpo = req.body || {};
    const id = corpo.id === undefined ? null : corpo.id;

    switch (corpo.method) {
      case "initialize":
        return res.send(
          ok(id, {
            protocolVersion: VERSAO_PROTOCOLO,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "gofitnow", version: "1.0.0" },
          })
        );

      // O cliente avisa que terminou de subir. Notificação: não devolve corpo.
      case "notifications/initialized":
        return res.status(204).end();

      case "ping":
        return res.send(ok(id, {}));

      case "tools/list":
        return res.send(ok(id, { tools: tools.listar() }));

      case "tools/call": {
        const nome = corpo.params?.name;
        const ferramenta = tools.achar(nome);

        if (!ferramenta) {
          return res.send(falha(id, -32602, `Ferramenta desconhecida: ${nome}`));
        }

        // A permissão é a da TELA. Quem não cria pessoa clicando não cria por
        // aqui — e o motivo volta como resultado, não como erro de protocolo:
        // o modelo precisa poder dizer à pessoa o que faltou.
        if (!app.helpers.ReqProtected.has(user, ferramenta.permissao)) {
          return res.send(
            resultado(
              id,
              {
                ok: false,
                erro: "sem_permissao",
                detalhe: `Esta conta não tem "${ferramenta.permissao}".`,
              },
              // `isError` é o que faz o cliente saber que a chamada NÃO deu
              // certo. Sem ele, um cliente que só olha o envelope trataria a
              // recusa como sucesso e seguiria em frente.
              true
            )
          );
        }

        let saida;
        try {
          saida = await ferramenta.executar(app, user, corpo.params?.arguments || {});
        } catch (error) {
          // Erro de programa vira RESULTADO com `isError`, e não erro de
          // JSON-RPC: um erro de protocolo faria o cliente tentar de novo igual,
          // enquanto o modelo, lendo o motivo, muda de plano.
          console.error("[mcp]", nome, error);
          return res.send(resultado(id, { ok: false, erro: "falha_interna" }, true));
        }

        // A TELA acompanha.
        //
        // A ferramenta mexeu no banco; quem está com o app aberto não sabe de
        // nada. O aviso diz para onde ir e o que destacar, e a tela vai sozinha
        // — parece que o assistente está mexendo nela, e é melhor que isso:
        // ele mexeu no dado.
        //
        // Só para QUEM PEDIU, e nunca em transmissão: a sala é da pessoa.
        // Falhar aqui não derruba a ferramenta — o trabalho está feito, e um
        // aviso que não saiu é uma tela que não se moveu, não um dado perdido.
        if (saida?.ok && saida.alvo) {
          try {
            tempoReal.avisar(
              instanceContext.current(),
              String(user._id),
              "assistente:alvo",
              { ferramenta: nome, ...saida.alvo }
            );
          } catch (error) {
            console.error("[mcp] aviso não saiu:", error.message);
          }
        }

        // O que aconteceu vai para o histórico com autor e alvo, igual à tela.
        // É o que permite responder "quem apagou esta ficha?" quando a resposta
        // for "um modelo, a pedido de fulano".
        if (saida?.ok) {
          app.insertUserActionHistory(req, user, "mcp_tool", {
            category: "admin",
            local: { target_type: "mcp", target_id: nome },
            extra: { ferramenta: nome, argumentos: corpo.params?.arguments || {} },
          });
        }

        return res.send(resultado(id, saida, saida?.ok === false));
      }

      default:
        return res.send(falha(id, -32601, `Método não suportado: ${corpo.method}`));
    }
  });

  // O envelope de conteúdo do MCP.
  //
  // O protocolo pede uma lista de blocos de conteúdo; o texto é o JSON da
  // ferramenta. Vai TAMBÉM em `structuredContent`, que é o campo que os
  // clientes novos leem sem precisar analisar texto.
  function resultado(id, saida, isError = false) {
    return ok(id, {
      content: [{ type: "text", text: JSON.stringify(saida) }],
      structuredContent: saida,
      ...(isError ? { isError: true } : {}),
    });
  }
};
