const clientIp = require("../lib/clientIp.js");
const rateLimit = require("../lib/rateLimit.js");

// A porta por onde a TELA conta que quebrou.
//
// ── Por que /public/ ──────────────────────────────────────────────────────
//
// Porque erro não espera login. Metade do que interessa acontece antes de
// existir sessão — o portal genérico, a tela de criar senha, o primeiro acesso —
// e essas são justamente as telas mais novas e mais prováveis de quebrar.
//
// Exigir sessão aqui seria registrar só os erros de quem conseguiu entrar, que é
// o oposto de quem precisa de ajuda.
//
// ── Por que ela SEMPRE responde 204 ───────────────────────────────────────
//
// Quem chama é um relator de erro. Se esta rota devolvesse falha, o relator
// tentaria relatar a falha do relato — e um laço de erro relatando erro é a
// única forma de esta feature derrubar o servidor que ela existe para proteger.
//
// Então: 204 para tudo. Ruído descartado, limite estourado, banco fora do ar —
// a tela recebe a mesma resposta e segue a vida. O que dá errado aqui vira log
// do servidor, nunca resposta.
module.exports = function (app) {
  // Vinte por minuto por IP.
  //
  // Uma pessoa com a tela quebrada gera uns poucos relatos: o cliente agrupa
  // antes de mandar. Vinte é folga para um laço curto e teto para um laço longo
  // — e mesmo estourando, a resposta é 204, então a tela nem sabe.
  const LIMITE = 20;

  app.post("/public/client-error", async function (req, res) {
    // 204 imediato, e o trabalho ACONTECE DEPOIS.
    //
    // A tela que está quebrando não pode ficar esperando o nosso banco: ela já
    // está com problema, e uma requisição pendurada é um segundo problema em
    // cima do primeiro.
    res.status(204).end();

    try {
      const limite = await rateLimit.checkShared("erro:" + clientIp(req), LIMITE);
      if (!limite.allowed) return;

      const b = req.body || {};

      // A INSTÂNCIA é resolvida AQUI, contra o registro central — nunca aceita
      // do corpo. Mesma regra do resto do sistema: a tela diz o endereço, o
      // servidor diz de quem ele é.
      const host = String(req.headers["x-instance-host"] || "");
      let instance = "";
      try {
        if (host) instance = (await app.api.center.instanceForHost(host)) || "";
      } catch (error) {
        // Central fora do ar não pode impedir o registro do erro — provavelmente
        // é justamente o que a pessoa está sofrendo.
      }

      await app.api.clientError.registrar({
        message: b.message,
        stack: b.stack,
        source: b.source,
        line: b.line,
        col: b.col,
        tipo: b.tipo,
        // O CAMINHO da página, sem query string.
        //
        // `/imprimir/dieta/68f2a1` diz onde quebrou; `?token=abc` seria credencial
        // gravada em texto no nosso banco. O corte é feito aqui e não confiado ao
        // cliente.
        caminho: String(b.caminho || "").split("?")[0].split("#")[0],
        versao: b.versao,
        app: b.app === true,
        // De qual tela veio. O modelo confere contra a lista dele — aqui só
        // repassa, porque validar em dois lugares é combinar de divergir.
        origem: b.origem,
        navegador: b.navegador,
        host,
        instance,
      });
    } catch (error) {
      // O relator de erro falhando vira UMA linha no log do servidor, e nada
      // mais. Nunca uma resposta, nunca uma exceção que suba.
      console.error("[client-error] não consegui registrar:", error.message);
    }
  });
};
