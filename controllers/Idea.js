const Idea = require("../model/Idea_model.js");

// AS IDEIAS, do lado de quem sugere e vota.
//
// *"Gostaria de um botão para ver ideias, e poder sugerir ideias."*
//
// ── QUEM PODE ENTRAR AQUI ─────────────────────────────────────────────────
//
// `verify` e não `can`: qualquer pessoa com sessão. É de propósito, e é o mesmo
// que a ajuda já faz com os chamados — quem tem uma ideia sobre o produto pode
// ser o dono, o professor que usa a tela oito horas por dia, ou a recepcionista
// que sofre com um campo mal posto. Exigir uma permissão aqui filtraria
// justamente quem mais tem o que dizer.
//
// ── O QUE VAI PARA O CENTRAL, E O QUE NÃO VAI ─────────────────────────────
//
// Sobe `instance` + `userId` + nome. A instância é o que separa um cliente do
// outro na hora de contar voto (dois bancos podem ter dois usuários com o mesmo
// `_id`); o nome é copiado porque o central não tem como fazer join com quinze
// bancos para desenhar uma lista.
//
// E ela NÃO volta: a lista devolve só o nome de quem sugeriu e de quem votou.
// Mandar a instância contaria a um cliente quem são os outros clientes.
function quemE(req, user) {
  return {
    instance: req.instance,
    userId: String(user._id),
    nome: String(user.name || user.email || "").trim(),
  };
}

const MENSAGENS = {
  sem_titulo: "errors.ideaNoTitle",
  muitas_hoje: "errors.ideaTooMany",
  sem_texto: "errors.ideaCommentEmpty",
  muitos_hoje: "errors.ideaCommentTooMany",
  nao_encontrado: "errors.ideaNotFound",
  sem_autor: "errors.ideaNotFound",
};

module.exports = function (app) {
  // O QUADRO.
  //
  // Ordem, busca e estado vêm por query porque são o endereço da tela: com eles
  // na URL, "as mais votadas" é um link que se manda para alguém.
  app.get("/me/ideas", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const rows = await app.api.idea.listar(quemE(req, user), {
      ordem: req.query.ordem,
      busca: req.query.busca,
      estado: req.query.estado,
    });

    res.send({ rows, maxTitulo: Idea.MAX_TITULO, maxDetalhes: Idea.MAX_DETALHES });
  });

  // Uma ideia, com quem votou.
  app.get("/me/ideas/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const doc = await app.api.idea.data(req.params.id, quemE(req, user));
    if (!doc) return res.status(404).send({ msg: req.t("errors.ideaNotFound") });

    res.send(doc);
  });

  // SUGERIR.
  app.post("/me/ideas", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.idea.criar(req.body || {}, quemE(req, user));
    if (!r.ok) {
      // 429 no teto por dia, e 400 no resto: são conversas diferentes. "Volte
      // amanhã" não é o mesmo que "corrija o título", e um 400 nos dois casos
      // faria a tela mostrar a mensagem de campo inválido para quem escreveu um
      // título perfeito.
      const codigo = r.erro === "muitas_hoje" ? 429 : 400;
      return res.status(codigo).send({ msg: req.t(MENSAGENS[r.erro] || "errors.saveFailed") });
    }

    const doc = await app.api.idea.data(r.id, quemE(req, user));

    app.insertUserActionHistory(req, user, "create_idea", {
      category: "other",
      local: { target_type: "idea_posts", target_id: r.id },
      extra: { titulo: String(req.body?.titulo || "").slice(0, 120) },
    });

    res.status(201).send(doc);
  });

  // ── COMENTAR ────────────────────────────────────────────────────────────
  //
  // Devolve o FIO INTEIRO, e não só a linha nova.
  //
  // A tela poderia acrescentar a linha que ela mesma acabou de escrever, e ficaria
  // errada no caso que mais importa: alguém comentou nos últimos segundos e essa
  // linha não está na tela dela. Devolvendo o fio, quem comenta vê a conversa
  // como ela está — inclusive a resposta que chegou enquanto digitava.
  app.post("/me/ideas/:id/comentarios", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // `pai` é o comentário respondido, quando é uma resposta. Ele vai no corpo e
    // não na URL: a rota é a mesma ("comentar nesta ideia"), e o pai é um detalhe
    // do que está sendo escrito — não um lugar diferente do sistema.
    const r = await app.api.idea.comentar(
      req.params.id,
      req.body?.texto,
      quemE(req, user),
      req.body?.pai
    );
    if (!r.ok) {
      // 429 no teto por dia; 404 na ideia que não existe; 400 no texto vazio. As
      // três são conversas diferentes, e um código só faria a tela dizer a frase
      // errada em dois dos três casos.
      const codigo = r.erro === "muitos_hoje" ? 429 : r.erro === "nao_encontrado" ? 404 : 400;
      return res.status(codigo).send({ msg: req.t(MENSAGENS[r.erro] || "errors.saveFailed") });
    }

    res.status(201).send({ fio: r.fio, comentarios: r.comentarios });
  });

  // Apagar o PRÓPRIO comentário. O dono está no filtro do banco, e não numa
  // conferência antes do delete — ver o comentário no modelo.
  //
  // O 404 de "não é seu" é o mesmo de "não existe", de propósito: responder
  // "existe, mas não é seu" conta a quem tentou que aquele id é de alguém.
  app.delete("/me/ideas/comentarios/:comentarioId", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.idea.apagarComentario(req.params.comentarioId, quemE(req, user));
    if (!r.ok) return res.status(404).send({ msg: req.t("errors.ideaNotFound") });

    res.send({ fio: r.fio, comentarios: r.comentarios });
  });

  // VOTAR — a mesma rota tira o voto.
  //
  // Ver o comentário em `alternarVoto`: duas rotas fariam a tela adivinhar o
  // estado atual, e ela erra quando a aba está aberta desde ontem.
  app.post("/me/ideas/:id/voto", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.idea.alternarVoto(req.params.id, quemE(req, user));
    if (!r.ok) return res.status(404).send({ msg: req.t(MENSAGENS[r.erro] || "errors.ideaNotFound") });

    res.send({ votei: r.votei, votos: r.votos });
  });
};
