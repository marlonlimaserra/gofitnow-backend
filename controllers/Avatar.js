module.exports = function (app) {
  // A foto de perfil.
  //
  // A LEITURA é por uma URL própria e pública para quem está logado, porque é
  // isso que deixa o navegador cachear a imagem em vez de trazê-la dentro de
  // cada resposta de usuário. A ESCRITA é só da própria conta.

  app.get("/avatars/:userId", async function (req, res) {
    // Exige sessão: é a foto de um usuário identificado, não um asset público.
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const avatar = await app.api.avatar.data(req.params.userId);
    if (!avatar) {
      res.status(404).send({ msg: req.t("errors.noPhotoShort") });
      return;
    }

    // `private` porque é conteúdo de uma sessão: um proxy compartilhado não
    // pode guardar isto e servir para outra pessoa. O ETag deixa o navegador
    // revalidar em vez de baixar de novo, e a URL leva a versão (?v=), então o
    // cache longo não segura uma foto trocada.
    res.setHeader("Content-Type", avatar.mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("ETag", '"' + new Date(avatar.updatedAt).getTime() + '"');

    if (req.headers["if-none-match"] === '"' + new Date(avatar.updatedAt).getTime() + '"') {
      res.status(304).end();
      return;
    }

    res.send(avatar.data.buffer ? Buffer.from(avatar.data.buffer) : avatar.data);
  });

  app.post("/me/avatar", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const parsed = app.api.avatar.parseDataUri((req.body || {}).image);
    if (!parsed) {
      res.status(400).send({ msg: req.t("errors.invalidImage") });
      return;
    }

    const at = await app.api.avatar.save(user._id, parsed.mime, parsed.buffer);

    app.insertUserActionHistory(req, user, "update_avatar", {
      category: "auth",
      local: { target_type: "users", target_id: user._id + "" },
      extra: { size: parsed.buffer.length, mime: parsed.mime },
    });

    res.send({ msg: req.t("ok.photoUpdated"), avatarAt: at });
  });

  app.delete("/me/avatar", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const ok = await app.api.avatar.delete(user._id);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.noPhoto") });
      return;
    }

    app.insertUserActionHistory(req, user, "delete_avatar", {
      category: "auth",
      local: { target_type: "users", target_id: user._id + "" },
    });

    res.send({ msg: req.t("ok.photoRemoved") });
  });
};
