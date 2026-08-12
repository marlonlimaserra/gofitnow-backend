const { AsyncLocalStorage } = require("node:async_hooks");

// De qual INSTÂNCIA é a requisição que está sendo atendida agora.
//
// Cada cliente tem o próprio banco (`gofitnow_marlon`, `gofitnow_outro`), e os
// modelos precisam saber qual abrir. O jeito óbvio seria passar a instância
// como argumento em cada método de cada modelo — dezessete modelos, e todo
// controller repassando. Um lugar esquecido lê o banco errado em silêncio.
//
// Em vez disso a instância viaja no contexto assíncrono da requisição: o
// middleware abre o escopo, e `config/mongodb.js` lê dele. Nenhum modelo muda de
// assinatura, e não há como esquecer de repassar o que não se passa.
//
// O nome vira parte de um nome de database, então o formato é apertado de
// propósito: só letras minúsculas, números e hífen. Sem isso, um nome vindo de
// fora escolheria em qual banco escrever.
const PADRAO = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Nomes que não podem ser instância porque já são banco nosso ou banco do
// próprio Mongo.
const RESERVADOS = new Set(["admin", "local", "config", "central", "center"]);

const store = new AsyncLocalStorage();

function normalize(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim().toLowerCase();
  if (!PADRAO.test(limpo)) return null;
  return RESERVADOS.has(limpo) ? null : limpo;
}

// Roda `fn` com a instância no contexto. Tudo o que `fn` chamar — inclusive
// depois de um await — vê o mesmo valor.
function run(instance, fn) {
  return store.run({ instance }, fn);
}

// A instância da requisição atual, ou undefined fora de uma.
function current() {
  return store.getStore()?.instance;
}

// Igual a `current()`, mas ESTOURA quando não há instância.
//
// É de propósito: um `undefined` que virasse "o banco padrão" faria uma rota
// sem instância ler dados de alguém. Falhar alto é a única resposta segura.
function required() {
  const nome = current();
  if (!nome) throw new Error("no_instance_in_context");
  return nome;
}

// De onde a instância pode vir, em ordem:
//
//   1. o cabeçalho `X-Instance` — é o caminho explícito, e o que o app usa;
//   2. o subdomínio do host — `marlon.gofitnow.fit` já diz de quem é;
//   3. `?instance=` — só para poder testar com curl sem montar cabeçalho.
//
// A ordem importa: o cabeçalho vence o host porque o app roda em
// `app.gofitnow.fit`, que de propósito não é o endereço de ninguém.
function fromRequest(req, baseDomain = "gofitnow.fit") {
  const header = normalize(req?.headers?.["x-instance"]);
  if (header) return header;

  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "")
    .trim()
    .toLowerCase()
    .split(":")[0];

  const sufixo = "." + baseDomain;
  if (host.endsWith(sufixo)) {
    const rotulo = host.slice(0, -sufixo.length);
    // Só um nível: `a.b.gofitnow.fit` não é instância.
    if (!rotulo.includes(".")) {
      const nome = normalize(rotulo);
      // Endereços NOSSOS não são cliente: `app` é o produto, `backend` é a API.
      // Sem `backend` aqui, uma chamada feita direto para backend.gofitnow.fit
      // resolveria a instância "backend" — que não existe, então seria recusada
      // adiante, mas pelo motivo errado e com a mensagem errada.
      const NOSSOS = ["app", "www", "api", "backend"];
      if (nome && !NOSSOS.includes(nome)) return nome;
    }
  }

  return normalize(req?.query?.instance) || null;
}

module.exports = { run, current, required, normalize, fromRequest, PADRAO, RESERVADOS };
