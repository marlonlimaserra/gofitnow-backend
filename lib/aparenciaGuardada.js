const redis = require("./redis.js");

// A APARÊNCIA DO CLIENTE, GUARDADA POR SEIS HORAS.
//
// Ideia do Marlon: *"a parte de aparência o cara vai mexer só uma vez, você pode
// salvar por 6h"*. Ele está certo sobre a frequência — cor e logo se escolhem no
// primeiro dia e não se toca mais.
//
// ── O que ela economiza, e onde ───────────────────────────────────────────
//
// `/public/theme` é chamada ANTES de qualquer sessão, em toda abertura de tela de
// login, no site e no app. E ela faz duas coisas caras em sequência:
//
//   1. pergunta ao CENTRAL de quem é aquele endereço;
//   2. abre o banco daquele cliente e lê a configuração.
//
// É a rota mais chamada por quem ainda não entrou, e a única que paga o custo
// duas vezes. Guardando a RESPOSTA PRONTA, as duas somem.
//
// ── SEIS HORAS SÓ É SEGURO PORQUE A LIMPEZA É ESTRUTURAL ─────────────────
//
// Com prazo de seis horas, "esperar expirar" não é conserto: quem trocar a cor da
// marca veria a antiga até de noite. O que torna o prazo longo aceitável é a
// escrita limpar o cache — e isso não depende de ninguém lembrar: `lib/escopo.js`
// intercepta toda escrita de cliente e `lib/cachesDeLeitura.js` diz o que cai
// quando `configurations` ou `brand_images` mudam.
//
// Sem essa parte, este arquivo seria um gerador de reclamação.
const PRAZO_MS = 6 * 60 * 60 * 1000;

// A chave é o ENDEREÇO, porque é só isso que a rota tem: ela chega sem sessão e
// sem instância, e descobrir de quem é o host é parte do que se quer economizar.
function chaveDoHost(host) {
  return `aparencia:${String(host || "").toLowerCase()}`;
}

// E um conjunto por cliente, para a limpeza saber quais endereços derrubar — um
// cliente pode ter o subdomínio nosso e o domínio próprio dele. Mesmo desenho
// dos tokens de sessão.
function chaveDaInstancia(instancia) {
  return `aparencias:${instancia}`;
}

async function ler(host) {
  if (!redis.ligado() || !host) return null;

  try {
    const cru = await redis.lerTexto(chaveDoHost(host));
    if (!cru) return null;

    const dados = JSON.parse(cru);
    // Sem `theme` é lixo: melhor ir buscar que responder uma tela sem cor.
    return dados?.theme ? dados : null;
  } catch (erro) {
    return null;
  }
}

// `instancia` pode vir vazia — é o caso do endereço desconhecido e o do portal,
// que também vale guardar (eles custam a mesma consulta ao central). Sem
// instância, o registro fica só no prazo: não há cliente cuja escrita o derrube,
// e não há o que derrubar.
function guardar(host, dados, instancia) {
  if (!redis.ligado() || !host || !dados) return;

  redis.guardarTexto(chaveDoHost(host), JSON.stringify(dados), PRAZO_MS);
  if (instancia) redis.somarAoConjunto(chaveDaInstancia(instancia), String(host).toLowerCase(), PRAZO_MS);
}

// Chamado pela camada de escrita quando a configuração ou a marca do cliente
// muda. Derruba TODOS os endereços dele de uma vez.
async function esquecer(instancia) {
  if (!redis.ligado() || !instancia) return;

  const conjunto = chaveDaInstancia(instancia);

  try {
    const hosts = await redis.membrosDoConjunto(conjunto);
    const chaves = (hosts || []).map(chaveDoHost);
    await redis.esquecer([...chaves, conjunto]);
  } catch (erro) {
    console.error("[aparencia] não consegui limpar:", erro?.message);
  }
}

module.exports = { ler, guardar, esquecer, PRAZO_MS, chaveDoHost, chaveDaInstancia };
