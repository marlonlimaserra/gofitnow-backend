const fields = require("../lib/autoFillFields.js");

module.exports = function (app) {
  // "Auto preencher": os valores que o profissional guardou campo a campo.
  //
  // Só de sessão, sem permissão específica: é preferência de quem está logado
  // sobre o próprio teclado, não acesso a dado de ninguém. Quem não pode criar
  // treino simplesmente nunca vê os campos que oferecem isso.

  // O catálogo de campos, para a tela do perfil se montar sozinha.
  app.get("/auto-fill/fields", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({ fields: fields.localized(req.t) });
  });

  app.get("/auto-fill", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // Com `?field=` devolve a lista daquele campo (é o que o formulário pede);
    // sem ele, tudo agrupado (é o que o perfil desenha).
    if (req.query.field) {
      res.send(await app.api.autoFill.list(user._id, req.query.field));
      return;
    }

    res.send(await app.api.autoFill.listGrouped(user._id));
  });

  app.post("/auto-fill", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { field, value } = req.body || {};

    if (!fields.isValid(field)) {
      res.status(400).send({ msg: req.t("errors.invalidField") });
      return;
    }
    if (!value || String(value).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireText") });
      return;
    }
    if (String(value).trim().length > 500) {
      res.status(400).send({ msg: req.t("errors.textTooLong") });
      return;
    }

    const saved = await app.api.autoFill.insert(user._id, field, value);
    res.status(201).send(saved);
  });

  app.delete("/auto-fill/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const ok = await app.api.autoFill.delete(user._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.optionNotFound") });
      return;
    }

    res.send({ msg: req.t("ok.optionRemoved") });
  });
};
