// O QUE CADA PESSOA É — pelo lado de quem responde.
//
// O catálogo vem da central (`user_categories`, publicado pelo painel) e a resposta
// mora no documento do usuário, aqui na instância. Ver o comentário do modelo: são
// duas coisas em dois lugares de propósito.
//
// ── Por que a lista é filtrada pelo tipo ──────────────────────────────────
//
// Um aluno não escolhe "endocrinologista", e um profissional não escolhe "aluno".
// Oferecer a lista inteira nos dois casos é erro de cadastro esperando acontecer —
// e o erro contamina a estatística que o site vai exibir.
module.exports = function (app) {
  // A LISTA para o formulário. Qualquer sessão: quem preenche o próprio cadastro
  // precisa dela, e não há nada aqui que já não esteja no site.
  app.get("/user-categories", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // `tipo` na query permite ao profissional pedir a lista do ALUNO que ele está
    // cadastrando, em vez de sempre receber a dele. Sem isso, o formulário de
    // cadastrar aluno ofereceria "Nutricionista" e "Academia".
    const tipo = req.query.tipo === "student" ? "student" : req.query.tipo ? "trainer" : user.type;

    res.send(await app.api.userCategory.paraTipo(tipo));
  });

  // A pessoa dizendo o que ELA é. Sem permissão nenhuma além de estar logada: é
  // resposta sobre si mesma.
  app.put("/me/category", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.userCategory.gravar(user._id, (req.body || {}).category, user.type);

    if (r.erro === "invalid_category") {
      // 400 com o código: a lista veio do servidor, então chave inválida aqui é
      // formulário desatualizado ou chamada à mão — e nos dois casos a tela precisa
      // saber que foi a CHAVE, não a rota.
      return res.status(400).send({ msg: req.t("errors.invalidCategory"), code: "invalid_category" });
    }
    if (r.erro) return res.status(404).send({ msg: req.t("errors.userNotFound") });

    res.send({ ok: true, category: r.category });
  });

  // A categoria de OUTRA pessoa — o profissional respondendo pelo aluno que ele
  // cadastrou, que é o caso mais comum: o aluno não entra na configuração.
  app.put("/users/:id/category", async function (req, res) {
    const admin = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (admin === false) return;

    const alvo = await app.api.user.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.userNotFound") });

    // O tipo é o do ALVO, e não o de quem está gravando: um profissional marcando a
    // categoria de um aluno tem de poder escolher "Aluno" — que não está na lista
    // dele.
    const r = await app.api.userCategory.gravar(alvo._id, (req.body || {}).category, alvo.type);

    if (r.erro === "invalid_category") {
      return res.status(400).send({ msg: req.t("errors.invalidCategory"), code: "invalid_category" });
    }
    if (r.erro) return res.status(404).send({ msg: req.t("errors.userNotFound") });

    app.insertUserActionHistory(req, admin, "set_user_category", {
      category: "admin",
      local: { target_type: "users", target_id: String(alvo._id) },
      extra: { category: r.category },
    });

    res.send({ ok: true, category: r.category });
  });
};
