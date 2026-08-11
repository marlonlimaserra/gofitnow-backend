// O subdomínio de cada profissional: `marlon.gofitnow.fit`.
//
// É por ele que a tela de login sabe de quem é o tema — antes de existir
// sessão, o host é a única coisa que identifica alguém.
//
// SUBDOMÍNIO nosso, não domínio próprio do profissional. A diferença é prática:
// um subdomínio deste domínio a gente cria sozinho no DNS; um domínio dele
// exigiria que ele apontasse o DNS, e aí a tela teria de esperar e verificar.
// Domínio próprio pode vir depois, por cima disto.
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || "gofitnow.fit";

// Nomes que o produto usa ou pode vir a usar. Deixar alguém tomar "api" seria
// entregar um endereço nosso.
const RESERVADOS = new Set([
  "www", "api", "app", "admin", "backend", "mail", "email", "smtp", "imap",
  "cdn", "static", "assets", "img", "images", "files", "docs", "help", "support",
  "status", "blog", "shop", "pay", "billing", "login", "auth", "account",
  "dashboard", "painel", "teste", "test", "dev", "staging", "homolog", "gofitnow",
]);

// Rótulo de DNS: letras, números e hífen; nunca começa nem termina com hífen; de
// 2 a 63 caracteres. Sem acento, porque o host viaja em ASCII.
const PADRAO = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

function normalize(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim().toLowerCase();
  if (limpo.length < 2 || limpo.length > 63) return null;
  return PADRAO.test(limpo) ? limpo : null;
}

function isAvailableName(valor) {
  const nome = normalize(valor);
  if (!nome) return false;
  return !RESERVADOS.has(nome);
}

function hostOf(subdominio) {
  const nome = normalize(subdominio);
  return nome ? `${nome}.${BASE_DOMAIN}` : null;
}

// O caminho de volta: do host que chegou na requisição para o subdomínio.
// Devolve null para o app principal e para qualquer host de fora — nenhum deles
// pertence a um profissional.
function subdomainOf(host) {
  if (typeof host !== "string") return null;

  // O navegador manda a porta em desenvolvimento.
  const semPorta = host.trim().toLowerCase().split(":")[0];
  const sufixo = "." + BASE_DOMAIN;
  if (!semPorta.endsWith(sufixo)) return null;

  const nome = semPorta.slice(0, -sufixo.length);
  // Só um nível: "a.b.gofitnow.fit" não é subdomínio de profissional.
  if (nome.includes(".")) return null;
  if (!isAvailableName(nome)) return null;

  return normalize(nome);
}

module.exports = { BASE_DOMAIN, RESERVADOS, normalize, isAvailableName, hostOf, subdomainOf };
