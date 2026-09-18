// O ENDEREÇO VIRA UM PONTO NO MAPA.
//
// Pedido do Marlon em 18/09/2026: *"tem como abrir o google maps, ou algum
// mapa, para a pessoa colocar o ponto certinho?"*.
//
// ── Por que Nominatim (OpenStreetMap), e não Google ────────────────────
//
// "ou algum mapa" é dele, e decide. O Google Maps Platform exige uma conta com
// faturamento ativo e uma chave por instalação — cobrar isso de cada academia
// para pôr um alfinete no endereço dela seria trocar um campo por um
// cadastro. O Nominatim não pede chave.
//
// E o ponto é um ATALHO: quem não gostar do resultado arrasta o alfinete. Não
// há acerto de geocodificação que valha um cadastro no Google Cloud.
//
// ── A POLÍTICA DE USO, e é por isso que isto é servidor ────────────────
//
// O Nominatim é mantido por doação e pede três coisas: um User-Agent que
// identifique quem chama, no máximo uma consulta por segundo, e cache do que
// já foi respondido. Nenhuma das três dá para garantir no navegador de quem
// usa — mil abas fazem mil chamadas com o User-Agent do Chrome.
//
// Aqui dá: uma fila de um por segundo, um cache, e o nosso nome na chamada.
const UA = "VAFIT/1.0 (+https://vafit.app)";
const TEMPO_DE_VIDA_MS = 7 * 24 * 60 * 60 * 1000;
const ESPERA_MS = 1100;

const cache = new Map();
let ultima = 0;

// A fila de um por segundo. Uma promessa encadeada, e não um `setInterval`:
// duas pessoas cadastrando ao mesmo tempo entram em ordem em vez de disparar
// juntas.
let fila = Promise.resolve();

function enfileirar(tarefa) {
  const proxima = fila.then(async () => {
    const desde = Date.now() - ultima;
    if (desde < ESPERA_MS) await new Promise((r) => setTimeout(r, ESPERA_MS - desde));
    ultima = Date.now();
    return tarefa();
  });

  // A fila não pode morrer com uma falha: sem isto, um erro deixaria toda
  // consulta seguinte rejeitada para sempre.
  fila = proxima.catch(() => {});
  return proxima;
}

// `undefined` quer dizer "não achei". A tela continua: o alfinete começa onde
// estiver e a pessoa arrasta.
async function porEndereco(texto, buscador = fetch) {
  const consulta = String(texto || "").trim().slice(0, 300);
  if (consulta.length < 5) return undefined;

  const chave = consulta.toLowerCase();
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.quando < TEMPO_DE_VIDA_MS) return guardado.ponto;

  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(consulta);

    const resposta = await enfileirar(() =>
      buscador(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) })
    );
    if (!resposta?.ok) return undefined;

    const lista = await resposta.json();
    const achado = Array.isArray(lista) ? lista[0] : null;
    if (!achado) return undefined;

    const ponto = { lat: Number(achado.lat), lng: Number(achado.lon) };
    if (!Number.isFinite(ponto.lat) || !Number.isFinite(ponto.lng)) return undefined;

    cache.set(chave, { quando: Date.now(), ponto });
    return ponto;
  } catch (erro) {
    // Nominatim fora, rede lenta, resposta estranha: nada disso pode virar
    // erro na cara de quem cadastra. O alfinete fica onde está.
    return undefined;
  }
}

module.exports = { porEndereco, UA, ESPERA_MS, TEMPO_DE_VIDA_MS };
