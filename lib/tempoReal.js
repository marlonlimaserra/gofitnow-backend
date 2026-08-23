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

// ── A ANAMNESE AO VIVO ─────────────────────────────────────────────────────
//
// O segundo motivo deste canal existir: a pessoa responde a anamnese pelo link,
// no celular dela, e o profissional vê cada letra aparecer na tela dele.
//
// Parece enfeite e não é: quem está do outro lado do telefone com o paciente
// consegue guiar a resposta ("põe o nome do remédio também"), e quem só vai ler
// depois percebe na hora que a pessoa está respondendo — em vez de descobrir uma
// hora depois que chegou.
//
// A conexão da PESSOA é diferente de todas as outras aqui: ela não tem sessão,
// não tem conta e não entra em sala nenhuma. Ela só EMITE, e o que ela emite o
// servidor traduz para a sala do profissional daquele link. Assim o token do
// formulário não vira uma porta para escutar nada.
//
// NADA É GRAVADO enquanto ela digita. O que vale é o envio, no fim: isto aqui é
// uma janela para o profissional, não uma segunda forma de salvar — e um
// rascunho salvo a cada tecla encheria a trilha de auditoria de uma consulta com
// mil linhas.
const CAMPOS_AO_VIVO = new Set([
  "mainComplaint", "conditions", "medications", "allergies", "surgeries", "familyHistory",
  "activity", "preferences", "aversions", "restrictions", "whoCooks", "exams", "notes",
  "sleepHours", "water", "mealsPerDay",
  "sleepQuality", "alcohol", "smoking", "bowel", "stress",
]);

// O teto de cada mensagem. Não é desconfiança da pessoa: é o que impede um
// `paste` de um PDF inteiro de virar uma mensagem de 2 MB no WebSocket do
// profissional a cada tecla seguinte.
const TETO_DE_TEXTO = 4000;

// Quantas mensagens por segundo cada conexão pode mandar.
//
// Vinte é folgado para quem digita (um humano rápido faz oito toques por
// segundo, e a tela ainda junta as teclas antes de mandar) e apertado para um
// laço: sem isto, uma aba com defeito inundaria a tela do profissional.
const POR_SEGUNDO = 20;

function podeFalar(socket) {
  const agora = Date.now();
  const janela = socket.data.janela || { desde: agora, quantas: 0 };

  if (agora - janela.desde > 1000) {
    janela.desde = agora;
    janela.quantas = 0;
  }

  janela.quantas += 1;
  socket.data.janela = janela;

  return janela.quantas <= POR_SEGUNDO;
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
      const { session, host, instance, anamnesisToken } = socket.handshake.auth || {};

      // ── A CONEXÃO DA PESSOA, pelo token do formulário ──────────────────
      //
      // Sem sessão, sem sala: ela existe para emitir. O servidor resolve de quem
      // é o link e guarda no socket — o cliente nunca diz para quem está
      // falando, senão o token de um formulário viraria um jeito de escrever na
      // tela de qualquer profissional.
      if (!session && anamnesisToken) {
        const nome = await instanciaDo(app, host, instance);
        if (!nome) return next(new Error("instancia_desconhecida"));

        const link = await instanceContext.run(nome, () =>
          app.api.anamnesisLink.byToken(anamnesisToken)
        );
        if (!link) return next(new Error("link_invalido"));

        socket.data.instancia = nome;
        socket.data.anamnese = {
          trainer: String(link.trainer),
          student: String(link.student),
        };
        return next();
      }

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

  // O que a pessoa digita, indo para a tela de quem a acompanha.
  //
  // Dois eventos e nada mais: o texto de um campo e onde ela está. O `foco` é o
  // que faz a fotinha dela aparecar no campo certo na tela do profissional — sem
  // isso, o texto mudando sozinho num formulário de dezoito campos é um
  // fantasma.
  io.on("connection", (socket) => {
    const daPessoa = socket.data.anamnese;
    if (!daPessoa) return;

    // ── ELA ENTROU ────────────────────────────────────────────────────────
    //
    // Avisado na CONEXÃO, e não na primeira tecla. A diferença é o que o
    // profissional faz com a informação: "entrou" é o momento de fechar o
    // dialog do link e olhar a tela; "digitou" chega depois, quando ela já está
    // escrevendo. Esperar a primeira tecla perderia o instante em que ele ainda
    // podia falar com ela ("abriu? qualquer dúvida me chama").
    avisar(socket.data.instancia, daPessoa.trainer, "anamnese:entrou", {
      student: daPessoa.student,
    });

    // E saiu. Serve para o selo de presença apagar na hora em que ela fecha a
    // aba, em vez de esperar o silêncio de vinte segundos da tela.
    socket.on("disconnect", () => {
      avisar(socket.data.instancia, daPessoa.trainer, "anamnese:saiu", {
        student: daPessoa.student,
      });
    });

    const repassar = (evento) => (dados) => {
      if (!podeFalar(socket)) return;

      const campo = String(dados?.campo || "");
      // Campo fora da lista não passa. É a mesma regra do modelo, e aqui ela
      // também impede que a tela do profissional receba uma chave inventada.
      if (campo && !CAMPOS_AO_VIVO.has(campo)) return;

      avisar(socket.data.instancia, daPessoa.trainer, evento, {
        student: daPessoa.student,
        campo,
        // O valor só existe no evento de digitar; no de foco ele nem vem.
        ...(dados && "valor" in dados
          ? { valor: String(dados.valor ?? "").slice(0, TETO_DE_TEXTO) }
          : {}),
      });
    };

    socket.on("anamnese:digitando", repassar("anamnese:digitando"));
    socket.on("anamnese:foco", repassar("anamnese:foco"));
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

module.exports = { iniciar, avisar, ativo, parar, sala, CAMPOS_AO_VIVO, POR_SEGUNDO, podeFalar };
