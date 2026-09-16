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
// 13/09/2026: `vafit.app`. Trocar a marca de endereço era trocar ESTA constante,
// e é o que está sendo feito — o parágrafo abaixo já previa o dia.
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || "vafit.app";

// OS DOMÍNIOS QUE SÃO NOSSOS — dois desde 25/08/2026.
//
// `shapeapp.fit` é o domínio da marca nova; `gofitnow.fit` continua vivo porque
// é o endereço que os clientes já têm salvo. A distinção que importa:
//
//   LER   aceita os dois. `bruna.shapeapp.fit` e `bruna.gofitnow.fit` são a
//         MESMA cliente, e é o que faz o endereço novo funcionar no instante em
//         que a rota do Worker sobe, sem mexer em cadastro nenhum.
//
//   ESCREVER usa só o BASE_DOMAIN. O endereço que a gente MOSTRA e o registro
//         de DNS que a gente CRIA continuam num domínio só — dois endereços
//         canônicos para a mesma cliente dividiriam o que o Google entende dela
//         e confundiriam quem copia o link para o WhatsApp.
//
// Trocar a marca de endereço um dia é trocar esta constante, não a lista.
// 10/09/2026: `vafit.app` entra na lista de leitura, ao lado dos dois que já
// estavam. O BASE_DOMAIN (o que a gente MOSTRA e o DNS que a gente CRIA) não
// muda — a regra do parágrafo acima vale igual para o terceiro.
//
// ── 13/09/2026: O BASE_DOMAIN VIROU `vafit.app`, E A LISTA FICOU LITERAL ───
//
// Ela era `${BASE_DOMAIN},shapeapp.fit,vafit.app`, derivada. Com a troca, essa
// expressão daria `vafit.app,shapeapp.fit,vafit.app` — e `gofitnow.fit` SAIRIA
// da lista de leitura.
//
// O estrago disso não é um endereço a menos: é `bruna.gofitnow.fit` deixar de
// ser reconhecido como a Bruna. Todo cliente tem o endereço antigo salvo no
// navegador e no atalho da tela inicial, e a tela deles viraria "domínio não
// identificado" no mesmo deploy. Por isso a lista agora é escrita por extenso,
// e `gofitnow.fit` não sai dela — nem quando a marca trocar de novo.
const BASE_DOMAINS = (
  process.env.TENANT_BASE_DOMAINS || `${BASE_DOMAIN},gofitnow.fit,shapeapp.fit`
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Para onde o profissional aponta o CNAME do domínio dele.
const CNAME_TARGET = process.env.TENANT_CNAME_TARGET || `app.${BASE_DOMAIN}`;

// ── O ENDEREÇO PÚBLICO DESTE BACKEND ──────────────────────────────────────
//
// Ele entra em coisas que ficam GUARDADAS e que outras pessoas abrem: a URL da
// logo dentro do tema, o callback que o cliente cola no console do Google, o
// endereço da API na documentação de chave.
//
// ── Por que ele virou uma função aqui ─────────────────────────────────────
//
// Porque estava cravado como "https://backend.gofitnow.fit" em QUATRO arquivos,
// cada um com o seu nome de variável de ambiente (`PUBLIC_API_URL`,
// `BACKEND_URL`), e nenhuma delas definida no servidor. Resultado: depois da
// troca para vafit.app, todo upload de logo continuou nascendo com URL do
// domínio antigo — e eu passei a manhã de 16/09/2026 consertando no banco as
// que já tinham nascido assim, enquanto o código seguia produzindo mais.
//
// Derivado do `BASE_DOMAIN`, ele acompanha a próxima troca sozinho. As duas
// variáveis antigas continuam sendo lidas para não quebrar nenhum ambiente que
// as tenha.
function apiBaseUrl() {
  const dita = process.env.PUBLIC_API_URL || process.env.BACKEND_URL;
  return String(dita || `https://backend.${BASE_DOMAIN}`).replace(/\/+$/, "");
}

// Nomes que o produto usa ou pode vir a usar. Deixar alguém tomar "api" seria
// entregar um endereço nosso.
const RESERVADOS = new Set([
  "www", "api", "app", "admin", "backend", "mail", "email", "smtp", "imap",
  "cdn", "static", "assets", "img", "images", "files", "docs", "help", "support",
  "status", "blog", "shop", "pay", "billing", "login", "auth", "account",
  "dashboard", "painel", "teste", "test", "dev", "staging", "homolog", "gofitnow",
  "central", "site", "portal", "worker", "workers",
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
  const base = BASE_DOMAINS.find((d) => semPorta.endsWith("." + d));
  if (!base) return null;

  const nome = semPorta.slice(0, -("." + base).length);
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
  return BASE_DOMAINS.some((d) => nome === d || nome.endsWith("." + d));
}

// Válido = é um host de verdade E não é nosso.
function isUsableDomain(valor) {
  const host = normalizeDomain(valor);
  return Boolean(host) && !isOwnDomain(host);
}

module.exports = {
  BASE_DOMAIN,
  BASE_DOMAINS,
  CNAME_TARGET,
  apiBaseUrl,
  RESERVADOS,
  normalize,
  isAvailableName,
  hostOf,
  subdomainOf,
  normalizeDomain,
  isOwnDomain,
  isUsableDomain,
};
