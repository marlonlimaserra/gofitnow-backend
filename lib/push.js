// A NOTIFICAÇÃO QUE CHEGA COM O APP FECHADO — OneSignal.
//
// ── O que ela é, e o que ela NÃO é ────────────────────────────────────────
//
// O sistema já avisa em tempo real por WebSocket (`lib/tempoReal.js`), e aquilo
// continua valendo: é o que faz a mensagem do chat aparecer sem recarregar. Só
// que ele alcança apenas quem está com a tela ABERTA.
//
// Isto aqui é o outro caso: a pessoa fechou o app, e o profissional dela acabou
// de mandar uma dieta. Sem push, ela descobre na próxima vez que abrir — que
// pode ser semana que vem.
//
// ── Por que OneSignal, e não o push da Expo ───────────────────────────────
//
// Escolha do Marlon, e ela se paga numa coisa concreta: o painel. Com ele, dá
// para disparar um aviso para toda a base sem passar por deploy nenhum — e isso
// é dele, não meu.
//
// ── QUEM RECEBE é o `external_id`, e não um token guardado por nós ────────
//
// A saída óbvia seria uma tabela de tokens de aparelho: cada app registra o seu,
// e o servidor guarda. É uma tabela a mais para encher de lixo — token morre
// quando a pessoa reinstala, e ninguém avisa.
//
// O OneSignal já faz isso. O app diz "este aparelho é do usuário X"
// (`OneSignal.login(id)`), e daqui se manda para o usuário X — em todos os
// aparelhos dele, sem que este servidor saiba quantos são nem quais.
//
// ── O iOS depende de uma coisa que NÃO é técnica ──────────────────────────
//
// A permissão que autoriza um app a receber push é da Apple e não existe em
// conta de desenvolvedor gratuita. Enquanto a conta do GoFitNow for Personal
// Team, isto funciona no Android e é ignorado no iPhone — o OneSignal aceita o
// envio e a Apple não entrega. Não há contorno do lado do código.

const ENDERECO = "https://api.onesignal.com/notifications";
const TEMPO_LIMITE_MS = 10 * 1000;

// `enviar` NUNCA lança. Notificação é acessório: a dieta foi salva, o treino foi
// montado, e um erro no aviso não pode desfazer nem atrapalhar o que a pessoa
// pediu. Falha vira log.
async function enviar({ appId, apiKey, paraUsuarios, titulo, texto, dados }, buscar = fetch) {
  if (!appId || !apiKey) return { ok: false, erro: "sem_chave" };

  const alvos = (Array.isArray(paraUsuarios) ? paraUsuarios : [paraUsuarios])
    .filter(Boolean)
    .map(String);

  if (!alvos.length) return { ok: false, erro: "sem_destino" };

  try {
    const resposta = await buscar(ENDERECO, {
      method: "POST",
      headers: {
        // `Key` e não `Basic`: é o formato da API v5 do OneSignal.
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app_id: appId,
        include_aliases: { external_id: alvos },
        target_channel: "push",
        // O idioma é obrigatório na API deles, e "en" é o rótulo do texto
        // PADRÃO — não uma tradução. Quem traduz é este servidor, antes de
        // chamar: o texto já chega no idioma de quem vai ler.
        headings: { en: titulo },
        contents: { en: texto },
        // O que a tela usa para saber PARA ONDE ir quando a pessoa toca.
        ...(dados ? { data: dados } : {}),
      }),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });

    const corpo = await resposta.json().catch(() => ({}));

    if (!resposta.ok || corpo?.errors) {
      const motivo = Array.isArray(corpo?.errors)
        ? corpo.errors.join(", ")
        : corpo?.errors?.invalid_aliases
          ? "destino sem aparelho registrado"
          : `HTTP ${resposta.status}`;
      return { ok: false, erro: motivo };
    }

    // `recipients: 0` não é erro da API: é "ninguém para receber". Acontece o
    // tempo todo — a pessoa nunca abriu o app, ou negou a permissão. Vale
    // distinguir de sucesso para não procurar defeito onde não há.
    return { ok: true, id: corpo?.id || null, entregues: corpo?.recipients ?? 0 };
  } catch (erro) {
    return { ok: false, erro: "indisponivel:" + (erro?.message || "") };
  }
}

module.exports = { enviar, ENDERECO };
