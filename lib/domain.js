// O endereço de cada profissional. São DOIS caminhos, e eles não se parecem:
//
//   SUBDOMÍNIO — `marlon.gofitnow.fit`. O DNS é nosso, então a gente cria o
//   registro sozinho. Precisa de token com Zone:DNS:Edit.
//
//   DOMÍNIO COMPLETO — `treinos.marlon.com.br`. O DNS é DELE. A gente não cria
//   registro nenhum: só liga o host ao projeto Pages (que o token de Pages já
//   permite) e diz para ele apontar um CNAME para `app.gofitnow.fit`. Depois a
//   gente confere se apontou.
//
// A diferença que importa: o domínio completo funciona sem a credencial de DNS,
// porque o passo de DNS não é nosso.
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || "gofitnow.fit";

// Para onde o profissional aponta o CNAME do domínio dele.
const CNAME_TARGET = process.env.TENANT_CNAME_TARGET || `app.${BASE_DOMAIN}`;

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

// ── Domínio completo ────────────────────────────────────────────────────────

// Um rótulo de DNS solto pode ter 1 caractere; o subdomínio nosso exige 2 por
// escolha de produto, mas `a.com.br` é um domínio legítimo e recusá-lo seria
// inventar regra.
const ROTULO = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// O último rótulo é só letra: separa `marlon.com` de um IP digitado à toa.
const TLD = /^[a-z]{2,63}$/;

// Aceita o que a pessoa realmente cola: com https://, com barra no fim, com
// porta, com ponto final. Tudo isso é o mesmo host, e devolver null aqui viraria
// "domínio inválido" na tela para um domínio perfeitamente válido.
function normalizeDomain(valor) {
  if (typeof valor !== "string") return null;

  let limpo = valor.trim().toLowerCase();
  limpo = limpo.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // esquema
  limpo = limpo.split("/")[0].split("?")[0].split("#")[0]; // caminho
  limpo = limpo.split("@").pop(); // usuário:senha@
  limpo = limpo.split(":")[0]; // porta
  limpo = limpo.replace(/\.+$/, ""); // raiz do DNS escrita à mão

  if (!limpo || limpo.length > 253) return null;

  const rotulos = limpo.split(".");
  if (rotulos.length < 2) return null; // `localhost` não é domínio
  if (!rotulos.every((r) => ROTULO.test(r))) return null;
  if (!TLD.test(rotulos[rotulos.length - 1])) return null;

  return limpo;
}

// Domínio nosso não entra por aqui: `x.gofitnow.fit` tem caminho próprio, e
// deixar passar pelos dois criaria dois donos possíveis para o mesmo host.
function isOwnDomain(host) {
  const nome = typeof host === "string" ? host.trim().toLowerCase() : "";
  return nome === BASE_DOMAIN || nome.endsWith("." + BASE_DOMAIN);
}

// Válido = é um host de verdade E não é nosso.
function isUsableDomain(valor) {
  const host = normalizeDomain(valor);
  return Boolean(host) && !isOwnDomain(host);
}

module.exports = {
  BASE_DOMAIN,
  CNAME_TARGET,
  RESERVADOS,
  normalize,
  isAvailableName,
  hostOf,
  subdomainOf,
  normalizeDomain,
  isOwnDomain,
  isUsableDomain,
};
