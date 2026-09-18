// O CEP, e o endereço que ele preenche.
//
// Pedido do Marlon em 18/09/2026: *"peça o endereço completo e não um text
// area de endereço, peça o cep primeiro e preencha o resto"*.
//
// ── Por que no SERVIDOR, e não direto do navegador ──────────────────────
//
// O ViaCEP aceita CORS, então a tela poderia chamá-lo sozinha. Três razões
// para não deixar:
//
//   1. CACHE. Um CEP não muda. Cinco pessoas cadastrando a mesma unidade, ou
//      a mesma pessoa corrigindo o número três vezes, são uma consulta só.
//   2. O terceiro fica do NOSSO lado da conversa. Se o ViaCEP sair do ar ou
//      trocar de formato, conserta-se aqui — e não num bundle que já está no
//      navegador de todo mundo.
//   3. A tela não precisa saber que ele existe. Ela pede "o endereço deste
//      CEP"; trocar de provedor um dia não mexe em uma linha de front.
//
// ── E POR QUE SÓ O BRASIL ───────────────────────────────────────────────
//
// Porque "CEP" é brasileiro, e foi o que ele pediu. O produto atende quatro
// idiomas, então o que NÃO se pode fazer é exigir o formato: quem digita um
// código postal de outro país recebe "não achei" e preenche à mão, com todos
// os campos abertos. O CEP é um atalho, nunca uma cerca.
const FORMATO = /^\d{8}$/;
const TEMPO_DE_VIDA_MS = 24 * 60 * 60 * 1000;

// Cache na memória do processo. Some no deploy, e tudo bem: ele existe para
// poupar a rajada de quem está digitando agora, não para ser um banco.
const cache = new Map();

// Só os dígitos: a tela manda "01310-100", "01310100" ou com espaço.
function limpar(valor) {
  return String(valor || "").replace(/\D/g, "");
}

function valido(valor) {
  return FORMATO.test(limpar(valor));
}

// `undefined` quer dizer "não achei", e é diferente de erro: o ViaCEP responde
// 200 com `{ erro: true }` para CEP inexistente.
async function buscar(valor, buscador = fetch) {
  const cep = limpar(valor);
  if (!valido(cep)) return undefined;

  const guardado = cache.get(cep);
  if (guardado && Date.now() - guardado.quando < TEMPO_DE_VIDA_MS) return guardado.dados;

  try {
    // 4s: quem está digitando não espera mais que isso, e o campo continua
    // aberto para ser preenchido à mão.
    const resposta = await buscador(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!resposta.ok) return undefined;

    const bruto = await resposta.json();
    if (!bruto || bruto.erro) return undefined;

    const dados = {
      cep,
      logradouro: String(bruto.logradouro || "").trim(),
      bairro: String(bruto.bairro || "").trim(),
      cidade: String(bruto.localidade || "").trim(),
      uf: String(bruto.uf || "").trim().toUpperCase(),
    };

    cache.set(cep, { quando: Date.now(), dados });
    return dados;
  } catch (erro) {
    // Rede lenta, ViaCEP fora, resposta estranha: nada disso pode virar erro
    // na cara de quem está cadastrando. Ela preenche à mão.
    return undefined;
  }
}

// ── O ENDEREÇO DE UMA LINHA, montado a partir das partes ────────────────
//
// A lista, o cartão e um dia a vitrine mostram UMA linha. Montá-la aqui, e não
// em cada tela, é o que impede três formatos diferentes do mesmo endereço.
//
// As partes vazias somem sem deixar vírgula sobrando — é o que separa
// "Rua X, 100 — Centro, São Paulo/SP" de "Rua X, , — , /".
function umaLinha(u = {}) {
  const rua = [u.logradouro, u.numero].filter(Boolean).join(", ");
  const comComplemento = [rua, u.complemento].filter(Boolean).join(" — ");
  const cidadeUf = [u.cidade, u.uf].filter(Boolean).join("/");
  const depois = [u.bairro, cidadeUf].filter(Boolean).join(", ");

  return [comComplemento, depois].filter(Boolean).join(" — ");
}

module.exports = { buscar, valido, limpar, umaLinha, TEMPO_DE_VIDA_MS };
