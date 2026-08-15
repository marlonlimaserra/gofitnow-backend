const { Server } = require("socket.io");
const instanceContext = require("./instance.js");

// O canal de TEMPO REAL: o servidor falando com a tela sem ela perguntar.
//
// Ele nasceu para uma coisa só, e vale escrever qual: quando o assistente age
// pela porta MCP, quem faz o trabalho é o servidor — a tela não sabe de nada.
// Sem este canal, a pessoa pede "acrescenta remada baixa", o exercício entra no
// banco, e ela continua olhando a mesma tela parada, achando que não funcionou.
//
// Com ele, o servidor avisa: "abra este treino e destaque este exercício". A
// tela vai sozinha. Parece que o assistente está mexendo nela — e é melhor que
// antes, porque ele não está: ele mexeu no dado, que é o que importa.
//
// ── A sala é da PESSOA ─────────────────────────────────────────────────────
//
// Não da instância. O banco já é por cliente, mas dentro dele há cinco
// professores: um não pode ver a tela do outro pular. A sala leva a instância
// no nome porque dois bancos diferentes podem, em tese, ter o mesmo id.
//
// ── Um núcleo ──────────────────────────────────────────────────────────────
//
// Com vários workers, a conexão da pessoa fica presa a UM processo, e a
// ferramenta MCP pode rodar em outro — o aviso sairia do lugar errado e ninguém
// veria nada. Hoje o servidor tem um núcleo só e o cluster roda um worker, então
// emitir em memória alcança todo mundo. No dia do segundo núcleo, isto precisa
// de um adaptador (`@socket.io/cluster-adapter`, pelo IPC, ou Redis) — e é o
// mesmo problema que o limite de chamadas já resolve à mão em `rateLimit.js`.
let io = null;

function sala(instancia, userId) {
  return `u:${instancia}:${userId}`;
}

// Sobe o canal em cima do servidor HTTP que já existe.
//
// `app` entra para a autenticação poder usar os mesmos modelos da API: quem
// entra aqui é quem entraria numa rota protegida, com o mesmo token.
function iniciar(servidorHttp, app) {
  io = new Server(servidorHttp, {
    path: "/tempo-real",
    // A tela mora noutro domínio (Cloudflare Pages) e o backend responde em
    // `backend.gofitnow.fit`: sem isto, o navegador barra a conexão.
    cors: { origin: true, credentials: true },
    // Só WebSocket: o polling de reserva do socket.io abriria uma requisição a
    // cada poucos segundos por pessoa conectada, que é justamente o custo que
    // este canal existe para tirar.
    transports: ["websocket"],
  });

  io.use(async (socket, next) => {
    try {
      const { session, host, instance } = socket.handshake.auth || {};
      if (!session) return next(new Error("sem_sessao"));

      // A instância é resolvida como no resto do sistema: pelo endereço da
      // tela, no registro central. O cliente NÃO escolhe o banco — ele diz onde
      // está, e o servidor traduz.
      const nome = await instanciaDo(app, host, instance);
      if (!nome) return next(new Error("instancia_desconhecida"));

      const user = await instanceContext.run(nome, async () => {
        // `verify` é o mesmo caminho do cabeçalho `session` nas rotas: um
        // segundo jeito de validar token seria um segundo jeito de errar.
        const check = await app.api.auth.verify(session);
        if (!check) return null;
        return await app.api.user.data(check.user);
      });

      if (!user || user.active === 0) return next(new Error("sessao_invalida"));

      socket.data.instancia = nome;
      socket.data.userId = String(user._id);
      socket.join(sala(nome, user._id));

      next();
    } catch (error) {
      next(new Error("falha"));
    }
  });

  return io;
}

async function instanciaDo(app, host, instance) {
  // Chave de API manda o nome direto; a tela manda o endereço dela.
  if (instance) return instanceContext.normalize(instance);

  const registro = await app.api.center.byHost(String(host || ""));
  if (!registro || registro.active === false || registro.active === 0) return null;

  return registro.instance;
}

// Avisa UMA pessoa.
//
// Silencioso de propósito quando o canal não está de pé ou ninguém está
// ouvindo: isto é enfeite de tela. Uma ferramenta que falhasse porque o aviso
// não saiu seria uma ferramenta que depende do navegador estar aberto.
function avisar(instancia, userId, evento, dados) {
  if (!io || !instancia || !userId) return false;

  io.to(sala(instancia, userId)).emit(evento, dados);
  return true;
}

function ativo() {
  return Boolean(io);
}

// Só para os testes: sem isto um caso vaza servidor para o seguinte.
function parar() {
  if (io) io.close();
  io = null;
}

module.exports = { iniciar, avisar, ativo, parar, sala };
