const { createClient } = require("redis");

// O REDIS — o estado que precisa ser o MESMO em todas as máquinas.
//
// ── O que ele resolve, em uma frase ───────────────────────────────────────
//
// Três contadores e o canal de tempo real assumem que existe uma máquina só. Com
// duas, cada uma passa a ter a sua cópia — e nenhuma percebe.
//
//   `rateLimit`          o limite de 60/min vira 60 × número de máquinas
//   `tentativasDeLogin`  errar 3 vezes vira 3 × máquinas antes do desafio
//   `travaDeEnvio`       a trava de 5 minutos deixa passar 1 e-mail por máquina
//   `tempoReal`          o aviso sai da máquina errada e ninguém vê nada
//
// Os três primeiros já resolviam isso DENTRO de uma máquina: quem decide é o
// primário do cluster, e os workers perguntam a ele pelo canal do sistema. O
// Redis é o mesmo desenho um andar acima — o "primário" passa a ser um serviço
// que todas as máquinas enxergam.
//
// ── ELE É OPCIONAL, E ISSO NÃO É PREGUIÇA ─────────────────────────────────
//
// Sem `REDIS_URL`, tudo continua funcionando exatamente como antes, pelo canal
// do cluster. É o que mantém honesto rodar o projeto na máquina de quem
// desenvolve, e o que faz o deploy de hoje não depender de um serviço a mais no
// mesmo minuto em que ele é introduzido.
//
// ── E QUANDO ELE CAI, NADA TRANCA ─────────────────────────────────────────
//
// Toda função aqui devolve `null` quando o Redis não responde, e quem chama
// trata isso como "não sei" — caindo no comportamento local. A escolha é a mesma
// que `lib/desafio.js` já fez: um problema de infraestrutura nossa não pode virar
// a porta trancada para quem não fez nada.
//
// O contrário — falhar FECHADO — seria pior aqui de um jeito específico: com o
// Redis fora do ar ninguém entraria no sistema, e a causa (um serviço auxiliar)
// não aparece em tela nenhuma.
const URL = process.env.REDIS_URL || "";

// Prefixo em tudo. O Redis é um espaço de nomes só, e um dia ele vai ser
// dividido com outra coisa — cache, fila. Sem prefixo, `login:x` de dois
// sistemas é a mesma chave.
const PREFIXO = "gofit:";

let cliente = null;
let ligando = null;
let avisado = false;

// ── SILENCIAR O QUE JÁ FOI DITO ───────────────────────────────────────────
//
// O node-redis reconecta sozinho e emite `error` a cada tentativa. Com o serviço
// fora do ar, isso enche o log com a mesma linha várias vezes por segundo e
// esconde tudo o mais. O primeiro erro é notícia; o milésimo é ruído.
let ultimoErro = 0;
function reclamar(erro) {
  const agora = Date.now();
  if (agora - ultimoErro < 30000) return;
  ultimoErro = agora;
  console.error("[redis]", erro?.message || erro);
}

function ligado() {
  return Boolean(URL);
}

async function conectar() {
  if (!URL) return null;
  if (cliente?.isReady) return cliente;
  if (ligando) return ligando;

  ligando = (async () => {
    const c = createClient({
      url: URL,
      socket: {
        // Sem teto na espera entre tentativas, o node-redis cresce até minutos e
        // o serviço demora a voltar depois de um reinício do Redis.
        reconnectStrategy: (tentativas) => Math.min(tentativas * 200, 3000),
        connectTimeout: 3000,
      },
    });

    c.on("error", reclamar);
    c.on("ready", () => {
      if (!avisado) {
        console.log("[redis] conectado — contadores e tempo real compartilhados");
        avisado = true;
      }
    });

    await c.connect();
    cliente = c;
    return c;
  })().catch((erro) => {
    reclamar(erro);
    ligando = null;
    return null;
  });

  return ligando;
}

// O cliente pronto, ou `null`. Nunca lança.
async function pegar() {
  try {
    const c = await conectar();
    return c?.isReady ? c : null;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// ── JANELA DESLIZANTE, num conjunto ordenado ──────────────────────────────
//
// Cada chamada vira um membro do conjunto com o horário como PONTUAÇÃO. Contar
// "quantas nos últimos 60 segundos" é apagar o que saiu da janela e contar o que
// sobrou — duas operações, sem trazer a lista para cá.
//
// Elas vão num `multi` porque precisam ser atômicas entre si: duas máquinas
// contando ao mesmo tempo, sem isso, veem o estado uma da outra pela metade.
//
// O membro é `horário-aleatório` porque conjunto não guarda repetido: duas
// chamadas no mesmo milissegundo viraram uma só, e o limite deixaria passar
// mais do que promete.
async function registrarNaJanela(chave, janelaMs) {
  const c = await pegar();
  if (!c) return null;

  const k = PREFIXO + chave;
  const agora = Date.now();

  try {
    const [, , quantas] = await c
      .multi()
      .zRemRangeByScore(k, 0, agora - janelaMs)
      .zAdd(k, { score: agora, value: `${agora}-${Math.random().toString(36).slice(2, 8)}` })
      .zCard(k)
      // O prazo é renovado a cada uso: chave parada some sozinha, e nada aqui
      // precisa de faxina.
      .pExpire(k, janelaMs)
      .exec();

    return { quantas: Number(quantas), agora };
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// Só CONTAR, sem registrar. É o que a tela de login pergunta antes de desenhar o
// desafio — perguntar não pode contar como tentativa.
async function contarNaJanela(chave, janelaMs) {
  const c = await pegar();
  if (!c) return null;

  const k = PREFIXO + chave;
  try {
    const [, quantas] = await c
      .multi()
      .zRemRangeByScore(k, 0, Date.now() - janelaMs)
      .zCard(k)
      .exec();

    return Number(quantas);
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// O horário da chamada MAIS ANTIGA ainda na janela. É o que diz quando abre a
// próxima vaga, sem trazer a lista inteira.
async function maisAntigaNaJanela(chave, janelaMs) {
  const c = await pegar();
  if (!c) return null;

  const k = PREFIXO + chave;
  try {
    await c.zRemRangeByScore(k, 0, Date.now() - janelaMs);
    const primeiros = await c.zRangeWithScores(k, 0, 0);
    return primeiros?.length ? Number(primeiros[0].score) : 0;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

async function esquecer(chaves) {
  const c = await pegar();
  if (!c) return null;

  try {
    const lista = (Array.isArray(chaves) ? chaves : [chaves]).map((k) => PREFIXO + k);
    if (lista.length) await c.del(lista);
    return true;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// ── UMA MARCA COM PRAZO ───────────────────────────────────────────────────
//
// Para a trava de envio: gravar "isto saiu agora" e saber quanto falta para
// poder sair de novo. `pTTL` devolve o que resta em milissegundos.
async function marcarComPrazo(chave, janelaMs) {
  const c = await pegar();
  if (!c) return null;

  try {
    await c.set(PREFIXO + chave, String(Date.now()), { PX: janelaMs });
    return true;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// Quanto falta, em milissegundos. Zero quando não há marca — isto é, pode sair.
async function faltaDoPrazo(chave) {
  const c = await pegar();
  if (!c) return null;

  try {
    const resta = await c.pTTL(PREFIXO + chave);
    // -2 é "não existe", -1 é "existe sem prazo". Os dois viram zero: sem prazo
    // não deveria acontecer aqui, e travar para sempre por causa de uma chave
    // torta seria pior que deixar sair.
    return resta > 0 ? resta : 0;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// ── TEXTO COM PRAZO, e conjuntos ──────────────────────────────────────────
//
// Para a sessão guardada: o usuário resolvido vira JSON numa chave por token, e
// os tokens de cada pessoa ficam num conjunto — que é o que permite apagar todos
// de uma vez quando a conta muda.
async function guardarTexto(chave, texto, ttlMs) {
  const c = await pegar();
  if (!c) return null;

  try {
    await c.set(PREFIXO + chave, texto, { PX: ttlMs });
    return true;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

async function lerTexto(chave) {
  const c = await pegar();
  if (!c) return null;

  try {
    return (await c.get(PREFIXO + chave)) || null;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// O prazo é renovado a cada acréscimo. Sem isso o conjunto sobreviveria aos
// tokens que ele lista, e sobraria lixo apontando para chaves que não existem.
async function somarAoConjunto(chave, valor, ttlMs) {
  const c = await pegar();
  if (!c) return null;

  try {
    await c.multi().sAdd(PREFIXO + chave, valor).pExpire(PREFIXO + chave, ttlMs).exec();
    return true;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

async function membrosDoConjunto(chave) {
  const c = await pegar();
  if (!c) return null;

  try {
    return await c.sMembers(PREFIXO + chave);
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// ── GUARDAR BYTES ─────────────────────────────────────────────────────────
//
// Para o PDF. Um cliente SEPARADO, porque ele precisa devolver `Buffer` e não
// texto: `withTypeMapping({ 36: Buffer })` muda a tradução de resposta em massa
// do cliente inteiro, e os contadores acima querem número e texto.
//
// (36 é o código do tipo "bulk string" no protocolo do Redis. Sem esse mapa, o
// node-redis decodifica os bytes como UTF-8 e um PDF volta corrompido — o
// arquivo abre e o leitor diz que está danificado.)
//
// TETO POR ITEM: um PDF gigante não pode ocupar o espaço de todos os outros. A
// avaliação com fotos é o caso grande, e acima do teto simplesmente não se
// guarda — gerar de novo é lento, mas encher a memória é pior para todo mundo.
const TETO_POR_ITEM = 8 * 1024 * 1024;

let clienteBytes = null;
let ligandoBytes = null;

async function pegarBytes() {
  if (!URL) return null;
  if (clienteBytes?.isReady) return clienteBytes;
  if (ligandoBytes) return ligandoBytes;

  ligandoBytes = (async () => {
    const c = createClient({ url: URL, socket: { connectTimeout: 3000 } }).withTypeMapping({
      36: Buffer,
    });
    c.on("error", reclamar);
    await c.connect();
    clienteBytes = c;
    return c;
  })().catch((erro) => {
    reclamar(erro);
    ligandoBytes = null;
    return null;
  });

  return ligandoBytes;
}

async function guardarBytes(chave, buffer, ttlMs) {
  if (!Buffer.isBuffer(buffer) || buffer.length > TETO_POR_ITEM) return null;

  const c = await pegarBytes();
  if (!c) return null;

  try {
    await c.set(PREFIXO + chave, buffer, { PX: ttlMs });
    return true;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

async function lerBytes(chave) {
  const c = await pegarBytes();
  if (!c) return null;

  try {
    const v = await c.get(PREFIXO + chave);
    return Buffer.isBuffer(v) && v.length ? v : null;
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

// Dois clientes NOVOS para o adaptador do socket.io.
//
// Ele exige um par dedicado: o cliente que assina um canal entra em modo de
// assinatura e não atende mais comando comum. Compartilhar o cliente de cima
// faria os contadores pararem de responder no instante em que o tempo real
// subisse.
async function parAdaptador() {
  if (!URL) return null;

  try {
    const pub = createClient({ url: URL });
    pub.on("error", reclamar);
    await pub.connect();

    const sub = pub.duplicate();
    sub.on("error", reclamar);
    await sub.connect();

    return { pub, sub };
  } catch (erro) {
    reclamar(erro);
    return null;
  }
}

async function fechar() {
  for (const c of [cliente, clienteBytes]) {
    try {
      if (c?.isOpen) await c.quit();
    } catch (erro) {
      // Fechar o que já caiu não é problema.
    }
  }
  cliente = null;
  ligando = null;
  clienteBytes = null;
  ligandoBytes = null;
  avisado = false;
}

module.exports = {
  ligado,
  pegar,
  registrarNaJanela,
  contarNaJanela,
  maisAntigaNaJanela,
  esquecer,
  marcarComPrazo,
  faltaDoPrazo,
  guardarBytes,
  lerBytes,
  guardarTexto,
  lerTexto,
  somarAoConjunto,
  membrosDoConjunto,
  TETO_POR_ITEM,
  parAdaptador,
  fechar,
  PREFIXO,
};
