const Oauth = require("./Oauth_model.js");

// CONECTAR A PÁGINA DO FACEBOOK DO PROFISSIONAL.
//
// Irmão do `OauthInstagram_model`: mesma ideia (a pessoa já está logada e
// autoriza o VAFIT a falar pela conta dela), outro caminho por completo.
//
// ── Facebook Login for Business, e o que muda ────────────────────────────
//
// Este app tem o caso de uso "Facebook Login for Business", que NÃO aceita
// `scope=` na URL: ele exige um `config_id` — uma CONFIGURAÇÃO salva no
// console, com as permissões escolhidas lá dentro. Mandar `scope` aqui devolve
// "Esta app precisa de, pelo menos, um supported permission", que é um erro
// que fala de permissão e não de configuração.
//
// A configuração usada é "Página do profissional" (26/09/2026), do tipo USER
// ACCESS TOKEN. A alternativa, system-user, exigiria que CADA profissional
// tivesse um portfólio empresarial — a maioria não tem, e seria uma porta
// fechada logo no primeiro passo.
//
// O número dela vive na central (`meta.facebookConfigId`) e não aqui: criar
// outra configuração no console é uma tela, e um número cravado no código
// exigiria deploy para acompanhar.
//
// ── O que se guarda é o token DA PÁGINA, não o da pessoa ─────────────────
//
// O token de usuário some quando a pessoa troca a senha ou sai da empresa. O
// da Página, derivado de um token longo de usuário, não expira — e é ele que
// responde mensagem. Guardar o do usuário faria a integração morrer no dia em
// que o dono mexesse na própria conta, sem relação com o VAFIT.
const GRAPH = "https://graph.facebook.com";

// O que a Meta manda para a Página quando algo acontece nela. Os mesmos
// campos assinados no webhook do app (ver `scripts/ligarWebhook.js`): assinar
// a Página com um conjunto diferente faria chegar evento que ninguém trata.
const CAMPOS_DO_WEBHOOK = "messages,messaging_postbacks,feed";

function OauthPagina_model(app) {
  Oauth.call(this, app);
}

Oauth.herdar(OauthPagina_model, "pagina");

// O RETORNO é `/auth/meta/callback`, e não `/auth/pagina/callback`.
//
// Ele está cadastrado assim no console do app de integração, e o cadastro
// veio primeiro — mudar este nome aqui derrubaria o fluxo com "URI não
// corresponde", que não diz qual dos dois lados está errado.
OauthPagina_model.prototype.callback = function () {
  return `${Oauth.BACKEND}/auth/meta/callback`;
};

OauthPagina_model.prototype.nomesDasChaves = function () {
  return ["meta.appId", "meta.appSecret", "meta.facebookConfigId", "meta.graphVersion"];
};

OauthPagina_model.prototype.chaves = async function () {
  let docs = [];
  try {
    const col = await this.settings();
    docs = await col.find({ key: { $in: this.nomesDasChaves() } }).toArray();
  } catch (erro) {
    console.error("[pagina] não consegui ler as chaves:", erro.message);
    return { ligado: false, clientId: "", clientSecret: "", configId: "", versao: "" };
  }

  const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  const clientId = String(v["meta.appId"] || "").trim();
  const clientSecret = String(v["meta.appSecret"] || "").trim();
  const configId = String(v["meta.facebookConfigId"] || "").trim();

  // O `configId` entra no `ligado`: sem ele a tela de consentimento abre e
  // recusa, e o que a pessoa lê é que a conta DELA tem problema.
  return {
    ligado: Boolean(clientId && clientSecret && configId),
    clientId,
    clientSecret,
    configId,
    versao: String(v["meta.graphVersion"] || "").trim(),
  };
};

const FORMATO_VERSAO = /^v\d{1,3}\.\d{1,3}$/;
const VERSAO_PADRAO = "v26.0";

OauthPagina_model.prototype.versao = function (chaves) {
  const v = String(chaves?.versao || "").trim();
  return FORMATO_VERSAO.test(v) ? v : VERSAO_PADRAO;
};

OauthPagina_model.prototype.urlDeAutorizacao = function (chaves, state) {
  const p = new URLSearchParams({
    client_id: chaves.clientId,
    // `config_id` no lugar de `scope`: é a diferença do Login for Business.
    config_id: chaves.configId,
    redirect_uri: this.callback(),
    response_type: "code",
    state,
  });
  return `https://www.facebook.com/${this.versao(chaves)}/dialog/oauth?${p.toString()}`;
};

OauthPagina_model.prototype.provaDoSegredo = function (token, segredo) {
  return this.app.crypto.createHmac("sha256", String(segredo)).update(String(token)).digest("hex");
};

OauthPagina_model.prototype.trocarCodigo = async function (code, chaves) {
  const chamar = this.app.facebookFetch || fetch;

  const p = new URLSearchParams({
    client_id: chaves.clientId,
    client_secret: chaves.clientSecret,
    redirect_uri: this.callback(),
    code: String(code),
  });

  const r = await chamar(`${GRAPH}/${this.versao(chaves)}/oauth/access_token?${p.toString()}`);
  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    throw new Error(`token ${r.status}: ${texto.slice(0, 200)}`);
  }
  return r.json();
};

// ── AS PÁGINAS QUE A PESSOA ADMINISTRA ───────────────────────────────────
//
// Uma pessoa pode administrar várias, e a escolha de quais conectar já foi
// feita na tela de consentimento da Meta — ela lista as Páginas e a pessoa
// marca. O que volta aqui é o resultado dessa escolha, e não "tudo o que ela
// tem": pedir de novo seria perguntar duas vezes a mesma coisa.
//
// `instagram_business_account` vem junto porque é grátis nesta mesma chamada
// e diz se aquela Página tem um Instagram profissional pendurado — o que
// permite, mais tarde, ligar os dois sem uma segunda autorização.
// ── QUANTAS PÁGINAS CABEM ────────────────────────────────────────────────
//
// *"tem gente com mais de 200 páginas de Facebook"* (26/09/2026). A Graph
// devolve no máximo 100 por vez e entrega o resto em `paging.next` — sem
// seguir, quem tem 200 veria só as 100 primeiras e as outras sumiriam sem
// aviso nenhum.
//
// O teto existe para uma conta absurda não virar um laço eterno de rede. Ao
// bater nele a lista volta MARCADA (`truncada`), e a tela diz que há mais —
// nunca fingir que aquilo é tudo.
const POR_PAGINA = 100;
const TETO_DE_PAGINAS = 500;

OauthPagina_model.prototype.paginas = async function (tokenDoUsuario, chaves) {
  const chamar = this.app.facebookFetch || fetch;

  const p = new URLSearchParams({
    fields: "id,name,username,access_token,picture{url},instagram_business_account{id,username}",
    limit: String(POR_PAGINA),
    access_token: String(tokenDoUsuario),
    appsecret_proof: this.provaDoSegredo(tokenDoUsuario, chaves.clientSecret),
  });

  let url = `${GRAPH}/${this.versao(chaves)}/me/accounts?${p.toString()}`;
  const paginas = [];
  let truncada = false;

  while (url) {
    const r = await chamar(url);
    if (!r.ok) {
      const texto = await r.text().catch(() => "");
      return { erro: `graph_${r.status}`, detalhe: texto.slice(0, 200) };
    }

    const dados = await r.json();
    for (const item of Array.isArray(dados.data) ? dados.data : []) paginas.push(item);

    if (paginas.length >= TETO_DE_PAGINAS) {
      truncada = true;
      break;
    }

    // `paging.next` já vem com token e cursor dentro. Remontar a URL à mão
    // seria reimplementar a paginação da Meta — e errar o cursor devolve a
    // mesma página para sempre.
    url = dados.paging?.next || null;
  }

  return { paginas: paginas.slice(0, TETO_DE_PAGINAS), truncada };
};

// ── ASSINAR A PÁGINA NO WEBHOOK ──────────────────────────────────────────
//
// Sem este passo TUDO funciona e nada chega: a conta aparece conectada, o
// token é válido, e nenhuma mensagem entra. É o defeito mais confuso desta
// integração, e por isso ele é um passo com nome próprio em vez de uma linha
// escondida no meio do callback.
//
// Quem assina é o token DA PÁGINA, não o do usuário — e a permissão que
// autoriza é `pages_manage_metadata`, que está na configuração do console.
OauthPagina_model.prototype.assinarWebhook = async function (pagina, chaves) {
  const chamar = this.app.facebookFetch || fetch;

  const p = new URLSearchParams({
    subscribed_fields: CAMPOS_DO_WEBHOOK,
    access_token: String(pagina.access_token),
  });

  const r = await chamar(`${GRAPH}/${this.versao(chaves)}/${pagina.id}/subscribed_apps?${p.toString()}`, {
    method: "POST",
  });

  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    return { ok: false, detalhe: texto.slice(0, 200) };
  }

  const dados = await r.json().catch(() => ({}));
  return { ok: dados.success === true };
};

// ── O CÓDIGO VIRA UMA LISTA PARA ESCOLHER, E NADA MAIS ───────────────────
//
// Aqui NÃO se grava e NÃO se assina. Foi o erro da primeira versão: ela
// conectava tudo o que voltasse, e *"tem gente com mais de 200 páginas"*.
// Conectar 200 Páginas que ninguém pediu enche a tela, assina 200 webhooks e
// faz chegar mensagem de lugar nenhum.
//
// O que sai daqui é uma LISTA. Quem escolhe é a pessoa, no diálogo, e só o
// que ela marcar é gravado e assinado (ver `controllers/ContasConectadas.js`).
// O contrário de assinar. Chamado quando a pessoa DESMARCA uma Página que
// estava conectada: sem isto a Meta continuaria mandando evento de uma conta
// que não existe mais aqui, e o webhook os guardaria sem dono para sempre.
//
// Falhar aqui não impede desconectar: o que manda é o que a pessoa quis. O
// evento órfão é barulho; a Página presa seria um defeito.
OauthPagina_model.prototype.desassinarWebhook = async function (conta, chaves) {
  const chamar = this.app.facebookFetch || fetch;

  const p = new URLSearchParams({ access_token: String(conta.token || "") });
  const r = await chamar(
    `${GRAPH}/${this.versao(chaves)}/${conta.externalId}/subscribed_apps?${p.toString()}`,
    { method: "DELETE" }
  );

  return { ok: r.ok };
};

OauthPagina_model.prototype.contasDoCodigo = async function (code, chaves) {
  const resposta = await this.trocarCodigo(code, chaves);
  if (!resposta?.access_token) return { erro: "sem_access_token" };

  const { paginas, truncada, erro, detalhe } = await this.paginas(resposta.access_token, chaves);
  if (erro) return { erro, detalhe };
  if (!paginas.length) return { erro: "nenhuma_pagina" };

  const contas = [];
  for (const pagina of paginas) {
    contas.push({
      tipo: "facebook",
      externalId: String(pagina.id),
      // O token DA PÁGINA. Ver o cabeçalho: o do usuário morre quando a pessoa
      // troca a senha; este, não.
      token: String(pagina.access_token || ""),
      // Sem validade: token de Página derivado de token longo não expira. O
      // campo fica `null` de propósito, e a tela não mostra aviso de prazo.
      expiraEm: null,
      usuario: String(pagina.username || ""),
      nome: String(pagina.name || ""),
      foto: String(pagina.picture?.data?.url || ""),
      escopos: CAMPOS_DO_WEBHOOK.split(","),
      instagramVinculado: pagina.instagram_business_account
        ? {
            id: String(pagina.instagram_business_account.id),
            usuario: String(pagina.instagram_business_account.username || ""),
          }
        : null,
    });
  }

  return { contas, truncada };
};

module.exports = OauthPagina_model;
module.exports.TETO_DE_PAGINAS = TETO_DE_PAGINAS;
module.exports.CAMPOS_DO_WEBHOOK = CAMPOS_DO_WEBHOOK;
