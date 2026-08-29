// O DESAFIO — Cloudflare Turnstile.
//
// ── Turnstile, e não reCAPTCHA ────────────────────────────────────────────
//
// São a mesma ideia com donos diferentes: um widget na página que devolve um
// token, e um servidor que pergunta ao dono do widget se aquele token vale.
// Turnstile é o da Cloudflare — grátis sem limite de uso, sem conta no Google, e
// esta casa já vive na Cloudflare (o app é um Worker, o site e o painel são
// Pages). Uma dependência a menos e um fornecedor a menos.
//
// ── E não é o "Challenge" do WAF ──────────────────────────────────────────
//
// Aquele roda na BORDA, é ligado no painel da Cloudflare e não passa por código
// nenhum nosso. Ele é ótimo contra varredura, e é inútil para o que foi pedido
// aqui: *"se a pessoa errar x vezes o login ... aí obriga"*. A borda não sabe que
// o login falhou — quem sabe é este servidor. Por isso o desafio tem de ser o
// widget, e não a regra de WAF.
//
// ── Este módulo não decide NADA ───────────────────────────────────────────
//
// Ele não lê configuração, não conta tentativa e não escolhe quando exigir. Só
// responde "este token vale?". Quem decide é a rota — e é o que permite testar
// isto sem rede e sem banco.

const ENDERECO = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TEMPO_LIMITE_MS = 10 * 1000;

// `verificar` devolve `{ ok, erro }`. Nunca lança: uma falha de rede na
// verificação não pode virar 500 na tela de entrada.
async function verificar({ secretKey, token, ip }, buscar = fetch) {
  if (!secretKey) return { ok: false, erro: "sem_chave" };
  if (!token) return { ok: false, erro: "sem_token" };

  const corpo = new URLSearchParams({ secret: secretKey, response: token });
  // O IP é opcional para a Cloudflare e ajuda a pontuar o pedido. Mandar um IP
  // errado é pior que não mandar, então só vai quando existe.
  if (ip) corpo.set("remoteip", ip);

  try {
    const resposta = await buscar(ENDERECO, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo.toString(),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });

    const dados = await resposta.json().catch(() => ({}));

    if (dados?.success === true) return { ok: true };

    // Os códigos da Cloudflare vão para o log, não para a tela: eles dizem
    // "timeout-or-duplicate", "invalid-input-secret" e afins, que interessam a
    // quem configurou e não a quem está tentando entrar.
    return { ok: false, erro: (dados?.["error-codes"] || ["recusado"]).join(",") };
  } catch (error) {
    // ── FALHAR FECHADO, aqui sim ────────────────────────────────────────
    //
    // O oposto do contador de tentativas. Lá, na dúvida, deixa passar: o desafio
    // é uma segunda camada. AQUI o desafio já foi exigido — chegou-se a este
    // ponto porque a senha errou várias vezes. Deixar passar por a Cloudflare
    // estar fora do ar transformaria a indisponibilidade dela na porta aberta
    // que o desafio existe para fechar.
    return { ok: false, erro: "indisponivel:" + (error?.message || "") };
  }
}

module.exports = { verificar, ENDERECO };
