// Arreio para testar rota sem banco.
//
// Os controllers só tocam em `app.api.*`, `app.helpers.*` e no par req/res —
// nunca no MongoDB direto. Então dá para montar um `app` de mentira, plugar o
// controller de verdade nele e exercitar a REGRA: o status que ele devolve, a
// mensagem, e o que ele chegou a mandar para o modelo.
//
// Isto não substitui um teste com banco; ele cobriria consulta e índice, que
// aqui não existem. Cobre o que quebra calado: uma validação que passa quando
// devia barrar.
const { fromAcceptLanguage, translator } = require("../../lib/i18n");
const instanceContext = require("../../lib/instance.js");

// Um express suficiente para os controllers: eles chamam app.get/post/put/delete
// com (rota, handler) e nada mais.
// O resto do que vier (`cloudflare`, `dnscheck`) entra no app como está: são as
// integrações de rede, e um teste que as deixasse passar bateria na internet.
function fakeApp({ api = {}, helpers = {}, ...extras } = {}) {
  const rotas = [];
  const app = {
    api,
    helpers,
    ...extras,
    validator: require("validator"),
    moment: require("moment"),
    crypto: require("crypto"),
    // O log de auditoria nunca deve derrubar uma rota, então aqui ele só
    // registra o que foi chamado, para os testes poderem afirmar sobre isso.
    registrados: [],
    insertUserActionHistory(req, user, action, data) {
      app.registrados.push({ action, data });
    },
  };

  for (const metodo of ["get", "post", "put", "patch", "delete"]) {
    app[metodo] = (caminho, handler) => rotas.push({ metodo, caminho, handler });
  }

  app._rotas = rotas;
  return app;
}

// Encontra a rota registrada e a executa, devolvendo o que a resposta recebeu.
// Casa `:param` posicionalmente, que é tudo que este projeto usa.
// `instance` é a instância em cujo contexto o handler roda.
//
// Em produção NENHUMA rota fechada roda fora de um contexto de instância — o
// middleware (lib/instanceGate.js) o estabelece antes de qualquer handler, e os
// modelos leem dele para saber qual banco abrir. Um harness que chamasse o handler
// solto testaria uma situação que não existe, e faria `instanceContext.required()`
// estourar em teste enquanto funciona no ar.
async function call(
  app,
  metodo,
  caminho,
  { body, params, query, headers, instance = "marlon" } = {}
) {
  const rota = app._rotas.find(
    (r) => r.metodo === metodo.toLowerCase() && mesmaRota(r.caminho, caminho)
  );
  if (!rota) throw new Error(`rota não registrada: ${metodo.toUpperCase()} ${caminho}`);

  const cabecalhos = { ...headers };
  const lang = fromAcceptLanguage(cabecalhos["accept-language"]);

  const req = {
    body: body || {},
    params: params || paramsDe(rota.caminho, caminho),
    query: query || {},
    headers: cabecalhos,
    lang,
    t: translator(lang),
  };

  // Os cabeçalhos ficam guardados porque em algumas rotas eles SÃO a regra: o
  // cache de uma imagem pública e o de uma foto de sessão não podem ser o
  // mesmo, e isso não aparece no corpo da resposta.
  const resposta = { status: 200, body: undefined, enviou: false, headers: {} };
  const res = {
    status(code) {
      resposta.status = code;
      return res;
    },
    setHeader(nome, valor) {
      resposta.headers[String(nome).toLowerCase()] = valor;
      return res;
    },
    send(payload) {
      resposta.body = payload;
      resposta.enviou = true;
      return res;
    },
    json(payload) {
      return res.send(payload);
    },
    end() {
      resposta.enviou = true;
      return res;
    },
  };

  await instanceContext.run(instance, () => rota.handler(req, res));
  return { ...resposta, req };
}

function partes(caminho) {
  return caminho.split("/").filter(Boolean);
}

function mesmaRota(padrao, real) {
  const a = partes(padrao);
  const b = partes(real);
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.startsWith(":") || p === b[i]);
}

function paramsDe(padrao, real) {
  const a = partes(padrao);
  const b = partes(real);
  const out = {};
  a.forEach((p, i) => {
    if (p.startsWith(":")) out[p.slice(1)] = b[i];
  });
  return out;
}

// Helper de permissão que sempre libera, devolvendo o usuário dado. Os testes
// que querem provar a NEGAÇÃO usam o ReqProtected de verdade.
//
// `pedidas` guarda as permissões exigidas em cada chamada, para um teste poder
// afirmar que a rota está protegida pela chave certa — esconder o menu não é
// proteção, quem protege é isto.
function permiteTudo(user) {
  const pedidas = [];
  return {
    pedidas,
    helpers: {
      ReqProtected: {
        async verify() {
          return user;
        },
        async can(req, res, permission) {
          pedidas.push(permission);
          return user;
        },
        async canAll(req, res, permissions) {
          pedidas.push(...permissions);
          return user;
        },
      },
    },
  };
}

module.exports = { fakeApp, call, permiteTudo };
