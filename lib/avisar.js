const { enviar } = require("./push.js");
const { translator } = require("./i18n");

// AVISAR A PESSOA — a camada entre o que aconteceu e o push.
//
// `lib/push.js` sabe falar com o OneSignal e mais nada. Aqui mora o resto: a
// configuração, o idioma, o texto de cada evento, e as duas regras que impedem
// notificação idiota.
//
// ── Regra 1: NINGUÉM É AVISADO DO QUE ELE MESMO FEZ ──────────────────────
//
// O profissional que também é atendido (existe, e é comum: ele monta o próprio
// treino) receberia "seu treino novo chegou" um segundo depois de salvá-lo. É o
// tipo de aviso que ensina a pessoa a ignorar os avisos.
//
// ── Regra 2: FALHA NÃO DESFAZ NADA ───────────────────────────────────────
//
// A dieta foi salva. Se o push não sair — OneSignal fora do ar, chave errada,
// aparelho não registrado —, isso é problema do aviso, não da dieta. Toda função
// aqui engole o erro e registra no log.

const NOMES = ["push.enabled", "push.oneSignalAppId", "push.oneSignalApiKey"];

async function configuracao(app) {
  try {
    const db = await app.mongodb.centralDb();
    const docs = await db.collection("settings").find({ key: { $in: NOMES } }).toArray();
    const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));

    const appId = String(v["push.oneSignalAppId"] || "").trim();
    const apiKey = String(v["push.oneSignalApiKey"] || "").trim();

    return {
      // Ligado só com o par COMPLETO: sem chave, cada evento viraria uma ida à
      // rede que sempre falha.
      ligado: Boolean(v["push.enabled"]) && Boolean(appId) && Boolean(apiKey),
      appId,
      apiKey,
    };
  } catch (erro) {
    console.error("[avisar] não consegui ler a configuração:", erro.message);
    return { ligado: false };
  }
}

// ── OS EVENTOS ────────────────────────────────────────────────────────────
//
// Cada um é uma chave de tradução e o caminho que o toque abre no app. O texto
// sai no idioma de QUEM RECEBE — mesma regra dos e-mails: quem lê é o dono da
// conta, não quem disparou.
const EVENTOS = {
  diet: { chave: "push.diet", rota: "/my/diet" },
  workout: { chave: "push.workout", rota: "/my/workouts" },
  assessment: { chave: "push.assessment", rota: "/my" },
  message: { chave: "push.message", rota: "/chat" },
};

// `avisar(app, evento, { para, de, lang, vars })`
//
// `para` é a PESSOA (o id dela). `de` é quem fez a coisa — usado só para não
// avisar alguém do próprio ato.
async function avisar(app, evento, { para, de, lang, vars = {} } = {}) {
  const tipo = EVENTOS[evento];
  if (!tipo) return { ok: false, erro: "evento_desconhecido" };

  if (!para) return { ok: false, erro: "sem_destino" };
  if (de && String(de) === String(para)) return { ok: false, erro: "autor" };

  const config = await configuracao(app);
  if (!config.ligado) return { ok: false, erro: "desligado" };

  const t = translator(lang);

  const r = await enviar({
    appId: config.appId,
    apiKey: config.apiKey,
    paraUsuarios: [String(para)],
    titulo: t(`${tipo.chave}.title`, vars),
    texto: t(`${tipo.chave}.body`, vars),
    dados: { rota: tipo.rota, evento },
  });

  if (!r.ok) console.error(`[avisar:${evento}]`, r.erro);
  return r;
}

// A versão que NUNCA espera.
//
// Quem chama é uma rota que já respondeu ao que a pessoa pediu — segurar a
// resposta para esperar o OneSignal seria cobrar do profissional o tempo de um
// aviso que não é dele.
function avisarSemEsperar(app, evento, dados) {
  avisar(app, evento, dados).catch((erro) =>
    console.error(`[avisar:${evento}] falhou:`, erro?.message)
  );
}

module.exports = { avisar, avisarSemEsperar, configuracao, EVENTOS };
