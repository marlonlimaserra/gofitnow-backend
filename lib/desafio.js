const { verificar } = require("./captcha.js");
const tentativas = require("./tentativasDeLogin.js");

// QUANDO EXIGIR O DESAFIO, E COMO CONFERI-LO.
//
// Junta as três peças que sozinhas não decidem nada:
//
//   lib/captcha.js            sabe perguntar à Cloudflare se um token vale
//   lib/tentativasDeLogin.js  sabe quantas vezes esta pessoa errou
//   a central                 sabe se está ligado, com que chave e a partir de
//                             quantos erros
//
// ── A configuração mora na central, como as outras chaves ─────────────────
//
// Mesma collection `settings` que guarda o OAuth e o Resend, lida direto do banco
// central — sem chamada HTTP entre os dois. Ligar, desligar ou trocar a chave é
// uma tela, não um deploy: no dia em que o desafio começar a barrar gente de
// verdade, desligar não pode depender de entrar no VPS.
//
// Central fora do ar devolve DESLIGADO. É a mesma escolha do OAuth: uma falha de
// leitura não pode trancar a porta da frente para todo mundo.

const NOMES = [
  "captcha.enabled",
  "captcha.siteKey",
  "captcha.secretKey",
  "captcha.loginAfterFailures",
  "captcha.onSignup",
  "captcha.onForgotPassword",
];

async function configuracao(app) {
  try {
    const db = await app.mongodb.centralDb();
    const docs = await db.collection("settings").find({ key: { $in: NOMES } }).toArray();
    const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));

    const siteKey = String(v["captcha.siteKey"] || "").trim();
    const secretKey = String(v["captcha.secretKey"] || "").trim();

    return {
      // Ligado só com o PAR completo. Ligado sem chave mostraria um widget que
      // nunca carrega, e aí ninguém entra — o pior resultado possível para uma
      // proteção de tela de login.
      ligado: Boolean(v["captcha.enabled"]) && Boolean(siteKey) && Boolean(secretKey),
      siteKey,
      secretKey,
      // O padrão é 3: erra três vezes, na quarta prova que é gente. Não é lei —
      // é o número que o painel mostra preenchido e que dá para mudar.
      aposFalhas: Number.isFinite(Number(v["captcha.loginAfterFailures"]))
        ? Number(v["captcha.loginAfterFailures"])
        : 3,
      noCadastro: Boolean(v["captcha.onSignup"]),
      noEsqueci: Boolean(v["captcha.onForgotPassword"]),
    };
  } catch (erro) {
    console.error("[desafio] não consegui ler a configuração:", erro.message);
    return { ligado: false };
  }
}

// ── A TELA PRECISA SABER ANTES ────────────────────────────────────────────
//
// Quantas falhas já existem para este e-mail/IP, e portanto se o próximo envio
// vai precisar do token. Sem isto a pessoa preencheria o formulário, apanharia um
// erro, e só então veria o widget aparecer — duas viagens para uma entrada.
async function exigidoNoLogin(app, { email, ip }) {
  const config = await configuracao(app);
  if (!config.ligado) return { exigido: false, config };

  if (config.aposFalhas <= 0) return { exigido: true, config };

  const falhas = await tentativas.contarFalhas(tentativas.chavesDe(email, ip));
  return { exigido: falhas >= config.aposFalhas, config, falhas };
}

// Confere o token quando ele é exigido. Devolve `null` quando está tudo bem, ou
// um objeto `{ status, code }` para a rota responder.
async function conferir(app, { config, token, ip }) {
  const r = await verificar({ secretKey: config.secretKey, token, ip });
  if (r.ok) return null;

  // `sem_token` é o caso normal da primeira vez: a tela ainda não sabia que
  // precisava. Ele merece um código próprio, porque a tela reage a ele mostrando
  // o widget — e não é um erro de quem está entrando.
  if (r.erro === "sem_token") return { status: 403, code: "captcha_required" };

  console.error("[desafio] token recusado:", r.erro);
  return { status: 403, code: "captcha_failed" };
}

module.exports = { configuracao, exigidoNoLogin, conferir, NOMES };
