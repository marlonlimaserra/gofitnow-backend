const crypto = require("node:crypto");

// O WEBHOOK DA META — Instagram, Messenger e Páginas.
//
// *"ué, por que não podemos fazer agora?"* (26/09/2026), quando eu disse que
// deixaria o webhook para depois. Ele estava certo: a ordem é escrever o
// endereço, subir, e SÓ ENTÃO configurar no console — porque a Meta confere o
// endereço na hora de salvar, mandando um desafio. Sem alguém do outro lado, o
// botão "Verify and save" recusa.
//
// ── DUAS ROTAS, DOIS CONTRATOS ───────────────────────────────────────────
//
// `GET` é a conferência, e acontece UMA vez, no console: a Meta manda
// `hub.verify_token` e espera de volta, em texto puro, o `hub.challenge`. Se
// responder qualquer outra coisa — JSON, aspas, quebra de linha — ela recusa.
//
// `POST` é o evento. Ela não espera corpo nenhum: espera 200 em menos de cinco
// segundos, e REPETE o que demorar. Por isso aqui se guarda e responde; o
// trabalho de verdade acontece depois, lendo a collection.
//
// ── SEM INSTÂNCIA, e é isso que o torna diferente de todo o resto ────────
//
// A Meta não sabe o que é um cliente nosso: ela chama um endereço só, para
// todas as contas conectadas. Quem descobre de quem é cada evento é o que vem
// DENTRO dele (o id da conta do Instagram, o id da Página) — e isso exige a
// tabela de contas conectadas, que é o trabalho de amanhã.
//
// Até lá o evento é guardado cru. Guardar sem saber de quem é vale a pena por
// uma razão: a Meta não reenvia o que já entregou. O que não for guardado
// agora não existe depois.
module.exports = function (app) {
  // A porta única. `/public/` porque o portão de instância isenta este prefixo
  // (ver `lib/instanceGate.js`): requisição sem cliente identificável morreria
  // ali com 400, e a Meta leria isso como endereço inválido.
  const ROTA = "/public/webhook/meta";

  app.get(ROTA, async function (req, res) {
    const modo = req.query["hub.mode"];
    const token = String(req.query["hub.verify_token"] || "");
    const desafio = String(req.query["hub.challenge"] || "");

    const esperado = await app.api.center.tokenDoWebhookDaMeta();

    // Comparação de tamanho fixo, como na chave interna: um `!==` normal vaza,
    // pelo tempo, quantos caracteres iniciais estão certos. É um token curto e
    // adivinhável por tentativa se o tempo falar.
    const iguais =
      esperado.length > 0 &&
      token.length === esperado.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado));

    if (modo !== "subscribe" || !iguais) {
      console.log("[webhook-meta] conferência recusada");
      return res.status(403).send("forbidden");
    }

    // Texto puro, sem JSON e sem aspas: é o que a Meta espera ler.
    res.type("text/plain").send(desafio);
  });

  app.post(ROTA, async function (req, res) {
    // ── RESPONDER PRIMEIRO, TRABALHAR DEPOIS ──────────────────────────────
    //
    // A Meta desiste em cinco segundos e reenvia o que demorou. Guardar antes
    // de responder transformaria um soluço do Mongo numa enxurrada de eventos
    // repetidos — e o repetido chega igual, sem nada dizendo que é o mesmo.
    res.sendStatus(200);

    try {
      const assinatura = String(req.headers["x-hub-signature-256"] || "");
      const corpo = req.body || {};

      await app.api.center.guardarEventoDaMeta({
        assinatura,
        confere: await confereAssinatura(app, req, assinatura),
        corpo,
      });
    } catch (erro) {
      // Nunca estoura para fora: a resposta já foi dada, e um erro aqui só
      // encheria o log de um processo que a Meta já considera atendido.
      console.error("[webhook-meta] não consegui guardar o evento:", erro.message);
    }
  });
};

// A ASSINATURA, quando há segredo para conferi-la.
//
// A Meta assina o corpo cru com o segredo do app. Sem conferir, qualquer um que
// descubra o endereço manda evento falso — e o endereço aparece no console de
// quem tiver acesso ao app.
//
// Guardamos o resultado junto do evento em vez de descartar o que não confere:
// um evento recusado é o sinal de que alguém está tentando, e jogar fora
// apagaria justamente o que se quer ver.
async function confereAssinatura(app, req, assinatura) {
  const segredo = await app.api.center.segredoDoAppDaMeta();
  if (!segredo || !assinatura.startsWith("sha256=")) return null;

  // `req.rawBody` é posto pelo parser (ver app.js). Sem ele não há o que
  // assinar: o JSON já parseado e reserializado não é byte a byte o original.
  const cru = req.rawBody;
  if (!cru) return null;

  const esperado = "sha256=" + crypto.createHmac("sha256", segredo).update(cru).digest("hex");

  return (
    esperado.length === assinatura.length &&
    crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(assinatura))
  );
}
