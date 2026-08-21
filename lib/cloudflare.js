// Registro do subdomínio de cada profissional na Cloudflare.
//
// São DOIS passos, e os dois precisam acontecer:
//   1. o registro DNS (CNAME de marlon.gofitnow.fit para o projeto Pages);
//   2. o domínio ligado ao projeto Pages, que é o que faz o certificado sair e
//      o Pages responder por aquele host.
//
// O token precisa de Zone:DNS:Edit na zona do domínio base E de Pages:Edit na
// conta. Sem o primeiro, o passo 1 falha — e é justamente o que acontece com o
// token de Pages que o projeto usa hoje para deploy.
//
// ── QUANDO O CURINGA JÁ ATENDE ────────────────────────────────────────────────
//
// Desde a migração do gofitnow.fit para a Cloudflare, quem serve `*.gofitnow.fit`
// é um WORKER com rota curinga (`gofitnow-app`, em gofitnow-frontend). A rota
// atende qualquer subdomínio — inclusive os que ainda não existem — e o
// certificado curinga da zona já cobre todos.
//
// Nesse arranjo o cadastro não tem NADA a fazer aqui: nem registro de DNS, nem
// domínio no projeto Pages, nem espera de certificado. O endereço passa a
// funcionar no instante em que a instância existe no banco.
//
// `CLOUDFLARE_WILDCARD_ROUTE=1` é o que diz isso. É uma chave explícita, e não
// uma dedução do tipo "não tem zona, então deve ter curinga": sem curinga de
// verdade, pular os dois passos deixaria o cliente com um endereço que não
// responde — falha silenciosa, do pior tipo, porque só aparece na hora em que a
// pessoa vai usar.
//
// Vale só para o domínio base. O domínio PRÓPRIO do cliente
// (`treinos.marlon.com.br`) continua precisando dos dois passos de sempre: o
// curinga não tem como cobrir um domínio que não é nosso.
const API = "https://api.cloudflare.com/client/v4";
const { BASE_DOMAIN } = require("./domain.js");

function config(env = process.env) {
  return {
    token: env.CLOUDFLARE_API_TOKEN || "",
    accountId: env.CLOUDFLARE_ACCOUNT_ID || "",
    zoneId: env.CLOUDFLARE_ZONE_ID || "",
    project: env.CLOUDFLARE_PAGES_PROJECT || "gofitnow",
    // Para onde o CNAME aponta. O domínio *.pages.dev do projeto.
    target: env.CLOUDFLARE_PAGES_TARGET || "gofitnow.pages.dev",
    // O curinga atende o domínio base — ver o cabeçalho.
    curinga: /^(1|true|sim)$/i.test(String(env.CLOUDFLARE_WILDCARD_ROUTE || "")),
  };
}

// O curinga vale para o domínio base, e só. Host que não termina nele é domínio
// próprio de cliente: aí não há curinga nenhum cobrindo, e os passos de sempre
// continuam valendo.
function usaCuringa(host, env) {
  const c = config(env);
  if (!c.curinga) return false;
  const base = String(BASE_DOMAIN).toLowerCase();
  return String(host || "").toLowerCase().endsWith("." + base);
}

// Diz se dá para tentar. Existe para a tela poder explicar o que falta em vez
// de mostrar um erro de API para o profissional.
function isConfigured(env, host) {
  // Com o curinga atendendo, não há credencial a exigir: não se chama a
  // Cloudflare para nada.
  if (usaCuringa(host, env)) return true;
  const c = config(env);
  return Boolean(c.token && c.accountId && c.zoneId);
}

function missingConfig(env, host) {
  if (usaCuringa(host, env)) return [];
  const c = config(env);
  return ["token", "accountId", "zoneId"].filter((k) => !c[k]);
}

// "Dá para registrar um subdomínio agora?" — a pergunta que a tela da central faz
// ANTES de a pessoa escolher o nome, quando ainda não existe host para consultar.
//
// Com o curinga atendendo, a resposta é sempre sim: não há credencial envolvida.
function subdomainReady(env = process.env) {
  return Boolean(config(env).curinga) || isConfigured(env);
}

function subdomainMissing(env = process.env) {
  return config(env).curinga ? [] : missingConfig(env);
}

// O domínio PRÓPRIO do profissional não precisa de zona: o DNS é dele, e a
// gente só liga o host ao projeto Pages. É por isso que ele funciona com o
// token de Pages que já existe, enquanto o subdomínio ainda espera o de DNS.
function isPagesConfigured(env) {
  const c = config(env);
  return Boolean(c.token && c.accountId);
}

function missingPagesConfig(env) {
  const c = config(env);
  return ["token", "accountId"].filter((k) => !c[k]);
}

async function chamar(fetchImpl, url, opcoes, token) {
  const res = await fetchImpl(url, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opcoes?.headers || {}),
    },
  });

  let corpo;
  try {
    corpo = await res.json();
  } catch (error) {
    return { ok: false, erro: `resposta ilegível da Cloudflare (HTTP ${res.status})` };
  }

  if (!corpo?.success) {
    const msg = (corpo?.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    return { ok: false, erro: msg, codigos: (corpo?.errors || []).map((e) => e.code) };
  }

  return { ok: true, resultado: corpo.result };
}

// Cria o CNAME e liga o domínio ao projeto Pages.
//
// Idempotente por escolha: a Cloudflare responde 81053/81057 quando o registro
// já existe, e isso NÃO é falha — alguém repetindo o cadastro depois de uma
// queda tem de terminar com o domínio no ar, não com um erro.
async function createSubdomain(host, { fetchImpl = fetch, env = process.env } = {}) {
  // O curinga já atende: nada a criar, nada a esperar. Nem uma chamada sai
  // daqui — e é isso que faz o cadastro deixar de depender da Cloudflare.
  if (usaCuringa(host, env)) return { ok: true, host, curinga: true };

  const c = config(env);
  if (!isConfigured(env, host)) {
    return { ok: false, erro: "cloudflare_not_configured", faltando: missingConfig(env, host) };
  }

  const dns = await chamar(
    fetchImpl,
    `${API}/zones/${c.zoneId}/dns_records`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: host,
        content: c.target,
        // Proxied: é o que põe o certificado e o CDN da Cloudflare na frente.
        proxied: true,
        comment: "GoFitNow — domínio de profissional",
      }),
    },
    c.token
  );

  const jaExiste = (r) => (r.codigos || []).some((code) => code === 81053 || code === 81057);
  if (!dns.ok && !jaExiste(dns)) return { ok: false, erro: dns.erro, passo: "dns" };

  const pages = await chamar(
    fetchImpl,
    `${API}/accounts/${c.accountId}/pages/projects/${c.project}/domains`,
    { method: "POST", body: JSON.stringify({ name: host }) },
    c.token
  );

  // 8000009 = "domínio já existe no projeto".
  const jaLigado = (pages.codigos || []).some((code) => code === 8000009);
  if (!pages.ok && !jaLigado) return { ok: false, erro: pages.erro, passo: "pages" };

  return { ok: true, host };
}

// Liga um domínio de FORA ao projeto Pages. Sem passo de DNS: quem aponta o
// CNAME é o dono do domínio, no provedor dele.
//
// O Pages aceitar o host é o que faz o certificado sair; sem isso o domínio
// resolve para a Cloudflare e volta erro de SSL, mesmo com o CNAME certo.
async function addPagesDomain(host, { fetchImpl = fetch, env = process.env } = {}) {
  if (!isPagesConfigured(env)) {
    return { ok: false, erro: "cloudflare_not_configured", faltando: missingPagesConfig(env) };
  }

  const c = config(env);
  const r = await chamar(
    fetchImpl,
    `${API}/accounts/${c.accountId}/pages/projects/${c.project}/domains`,
    { method: "POST", body: JSON.stringify({ name: host }) },
    c.token
  );

  // 8000009 = já está no projeto. Repetir o cadastro tem de terminar no ar.
  const jaLigado = (r.codigos || []).some((code) => code === 8000009);
  if (!r.ok && !jaLigado) return { ok: false, erro: r.erro, passo: "pages" };

  return { ok: true, host };
}

// Desliga o domínio do projeto. O CNAME no provedor do profissional continua
// existindo — esse a gente nunca teve como mexer.
async function removePagesDomain(host, { fetchImpl = fetch, env = process.env } = {}) {
  if (!isPagesConfigured(env)) return { ok: false, erro: "cloudflare_not_configured" };

  const c = config(env);
  const r = await chamar(
    fetchImpl,
    `${API}/accounts/${c.accountId}/pages/projects/${c.project}/domains/${encodeURIComponent(host)}`,
    { method: "DELETE" },
    c.token
  );

  // Já não estar lá é o mesmo resultado que remover.
  if (!r.ok && !/not found|does not exist/i.test(r.erro || "")) return { ok: false, erro: r.erro };
  return { ok: true };
}

// Só consulta: a tela usa para dizer se o certificado já saiu.
async function domainStatus(host, { fetchImpl = fetch, env = process.env } = {}) {
  // Sob o curinga o endereço já responde, com o certificado curinga da zona.
  // Perguntar ao Pages devolveria "não existe" e a tela de espera nunca sairia
  // do lugar.
  if (usaCuringa(host, env)) return { ok: true, status: "active", curinga: true };

  const c = config(env);
  if (!c.token || !c.accountId) return { ok: false, erro: "cloudflare_not_configured" };

  const r = await chamar(
    fetchImpl,
    `${API}/accounts/${c.accountId}/pages/projects/${c.project}/domains/${encodeURIComponent(host)}`,
    { method: "GET" },
    c.token
  );

  if (!r.ok) return { ok: false, erro: r.erro };
  return { ok: true, status: r.resultado?.status || "unknown" };
}

module.exports = {
  config,
  usaCuringa,
  isConfigured,
  missingConfig,
  subdomainReady,
  subdomainMissing,
  isPagesConfigured,
  missingPagesConfig,
  createSubdomain,
  addPagesDomain,
  removePagesDomain,
  domainStatus,
};
