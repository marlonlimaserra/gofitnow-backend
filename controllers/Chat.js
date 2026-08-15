module.exports = function (app) {
  // As conversas.
  //
  // A autorização aqui tem DOIS degraus, e os dois são necessários:
  //
  //   permissão  → esta conta pode usar o chat
  //   participar → esta conta é uma das duas desta conversa
  //
  // A permissão sozinha deixaria qualquer profissional abrir a conversa de
  // qualquer outro só trocando o id na URL. Ter permissão é poder conversar,
  // não é poder ler conversa alheia.
  async function conversaDoUsuario(req, res, permissao) {
    const user = await app.helpers.ReqProtected.can(req, res, permissao);
    if (user === false) return false;

    const conversa = await app.api.chat.data(req.params.id);
    if (!conversa || !app.api.chat.isMember(conversa, user._id)) {
      // 404 e não 403: dizer "existe, mas não é sua" já entrega que a conversa
      // existe e com quem, para quem só estava tentando ids.
      res.status(404).send({ msg: req.t("errors.conversationNotFound") });
      return false;
    }

    return { user, conversa };
  }

  // Os nomes e avatares dos outros participantes, buscados de uma vez.
  //
  // Uma consulta para a lista inteira em vez de uma por linha: com trinta
  // conversas na tela seriam trinta idas ao banco para escrever trinta nomes.
  async function comPessoas(user, conversas) {
    const outros = conversas.map((c) => app.api.chat.otherOf(c, user._id)).filter(Boolean);
    const pessoas = await app.api.user.briefByIds(outros);

    return conversas.map((c) => {
      const outro = app.api.chat.otherOf(c, user._id);
      const pessoa = pessoas[String(outro)];

      return {
        _id: c._id,
        lastMessage: c.lastMessage || "",
        lastKind: c.lastKind || null,
        lastAt: c.lastAt || null,
        // Se a última foi minha, a lista mostra "Você: …" — é o que diz, de
        // relance, se a bola está com o outro lado.
        lastFromMe: String(c.lastFrom || "") === String(user._id),
        unread: (c.unread || {})[String(user._id)] || 0,
        person: pessoa
          ? { _id: outro, name: pessoa.name, avatarAt: pessoa.avatarAt || null }
          : null,
      };
    });
  }

  app.get("/chat/conversations", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "chat.view");
    if (user === false) return;

    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const conversas = await app.api.chat.listOf(user._id, { limit, skip });

    res.send({
      rows: await comPessoas(user, conversas),
      total: await app.api.chat.countOf(user._id),
      unread: await app.api.chat.unreadTotal(user._id),
    });
  });

  // Só o número da bolinha.
  //
  // Separada da listagem porque é ela que a tela consulta de tempos em tempos,
  // com o chat fechado. Trazer trinta conversas e os nomes de todo mundo a cada
  // consulta, para desenhar um número, seria desperdício repetido o dia inteiro.
  app.get("/chat/unread", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "chat.view");
    if (user === false) return;

    res.send({ unread: await app.api.chat.unreadTotal(user._id) });
  });

  // Abre a conversa com alguém — a que já existe, ou uma nova.
  //
  // Sempre a mesma rota: a tela não tem como saber se as duas contas já se
  // falaram, e obrigá-la a procurar antes de criar seria fazer o cliente
  // resolver uma pergunta que o servidor responde melhor.
  app.post("/chat/conversations", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "chat.send");
    if (user === false) return;

    const outroId = String((req.body || {}).personId || "");

    // Conversa consigo mesmo não é conversa. Sem esta guarda, os dois membros
    // seriam o mesmo id e "o outro" não existiria — o contador de não lido não
    // teria para quem subir.
    if (!outroId || outroId === String(user._id)) {
      res.status(400).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    // A pessoa tem de existir NESTE cliente. Cada um tem o próprio banco, então
    // um id de fora simplesmente não é encontrado — mas a checagem é explícita
    // para a resposta ser 404 e não uma conversa com um fantasma.
    const outro = await app.api.user.data(outroId);
    if (!outro) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return;
    }

    const conversa = await app.api.chat.openWith(user._id, outroId);
    const [linha] = await comPessoas(user, [conversa]);

    res.send(linha);
  });

  app.get("/chat/conversations/:id/messages", async function (req, res) {
    const ctx = await conversaDoUsuario(req, res, "chat.view");
    if (ctx === false) return;

    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const rows = await app.api.chat.messagesOf(req.params.id, {
      before: req.query.before,
      limit,
    });

    res.send({ rows, me: ctx.user._id });
  });

  app.post("/chat/conversations/:id/messages", async function (req, res) {
    const ctx = await conversaDoUsuario(req, res, "chat.send");
    if (ctx === false) return;

    const corpo = req.body || {};

    // O anexo é lido ANTES de gravar: um tipo recusado tem de virar 400 com o
    // motivo certo, e não uma mensagem vazia gravada na conversa.
    let anexo;
    if (corpo.file) {
      anexo = app.api.chat.parseAttachment(corpo.file);
      if (!anexo) {
        res.status(400).send({ msg: req.t("errors.invalidAttachment") });
        return;
      }
    }

    const mensagem = await app.api.chat.send(req.params.id, ctx.user._id, corpo.body, anexo);
    if (!mensagem) {
      res.status(400).send({ msg: req.t("errors.emptyMessage") });
      return;
    }

    // Sem registro no histórico de ações: mensagem é conteúdo, não
    // administração. Uma conversa de trinta linhas viraria trinta entradas e
    // afogaria tudo o mais que a conta fez no dia — e o conteúdo já está
    // guardado, na conversa.
    res.status(201).send(mensagem);
  });

  // O arquivo de uma mensagem.
  //
  // Passa pela MESMA regra de participação das outras rotas: quem não é da
  // conversa não lê o anexo dela, mesmo tendo o id da mensagem.
  app.get("/chat/messages/:messageId/file", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "chat.view");
    if (user === false) return;

    const arquivo = await app.api.chat.fileOf(req.params.messageId);
    if (!arquivo) {
      res.status(404).send({ msg: req.t("errors.noPhotoShort") });
      return;
    }

    const conversa = await app.api.chat.data(arquivo.conversation);
    if (!conversa || !app.api.chat.isMember(conversa, user._id)) {
      res.status(404).send({ msg: req.t("errors.conversationNotFound") });
      return;
    }

    // Como o arquivo é SERVIDO importa tanto quanto quem pode lê-lo.
    //
    // `nosniff` impede o navegador de adivinhar o tipo pelo conteúdo — sem ele,
    // um arquivo declarado como texto e cheio de HTML seria interpretado como
    // página, na nossa origem. E só imagem e áudio abrem embutidos: todo o
    // resto vai como anexo, para nada de terceiros ser renderizado aqui dentro.
    const embutido = arquivo.mime.startsWith("image/") || arquivo.mime.startsWith("audio/");
    const nome = String(arquivo.name || "arquivo").replace(/"/g, "");

    res.setHeader("Content-Type", arquivo.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${embutido ? "inline" : "attachment"}; filename="${nome}"`
    );
    // Conteúdo de uma sessão: um proxy compartilhado não pode guardar isto e
    // servir para outra pessoa. Imutável porque a mensagem não se edita.
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");

    res.send(arquivo.data.buffer ? Buffer.from(arquivo.data.buffer) : arquivo.data);
  });

  app.post("/chat/conversations/:id/read", async function (req, res) {
    const ctx = await conversaDoUsuario(req, res, "chat.view");
    if (ctx === false) return;

    await app.api.chat.markRead(req.params.id, ctx.user._id);
    res.send({ unread: await app.api.chat.unreadTotal(ctx.user._id) });
  });
};
