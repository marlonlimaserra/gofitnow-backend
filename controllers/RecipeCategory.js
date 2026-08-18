// As categorias de dieta, do lado do CLIENTE.
//
// Ele recebe a lista já resolvida — as nossas menos as que escondeu, mais as
// dele — e pode fazer duas coisas: esconder uma nossa, e criar/renomear/apagar
// uma sua.
//
// O que ele não pode é editar as nossas. A razão não é hierarquia: é que as
// receitas do catálogo compartilhado estão classificadas por elas, e se cada
// cliente redefinisse "bulking" a mesma receita significaria coisa diferente em
// cada instalação. A sugestão passaria a sugerir errado sem ninguém entender.
module.exports = function (app) {
  // A lista para USAR — montar plano, filtrar receita. Todo usuário autenticado
  // lê: escolher categoria é trabalho de quem monta o plano, não de quem
  // administra.
  app.get("/recipe-categories", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send(await app.api.recipeCategory.paraCliente());
  });

  // A lista para CONFIGURAR — traz as nossas com o estado de escondida, que a de
  // cima não traz. Sem ela, a tela de configuração não teria como oferecer
  // desocultar o que está oculto: o item simplesmente não estaria lá.
  app.get("/me/recipe-categories", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send(await app.api.recipeCategory.paraConfigurar());
  });

  app.put("/me/recipe-categories/:key/escondida", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.recipeCategory.esconder(req.params.key, req.body?.escondida !== false);

    if (r.erro === "not_found") {
      return res.status(404).send({ msg: req.t("errors.notFound"), code: "not_found" });
    }
    if (r.erro) return res.status(400).send({ msg: req.t("errors.internal"), code: r.erro });

    res.send({ ok: true });
  });

  app.post("/me/recipe-categories", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.recipeCategory.criar(req.body);

    // "reserved" e "duplicated" são coisas diferentes e a mensagem diz qual: uma
    // é "esse nome é nosso", a outra é "você já tem uma assim". Um erro só faria
    // a pessoa tentar de novo com o mesmo nome.
    if (r.erro === "reserved") {
      return res.status(409).send({ msg: req.t("errors.categoryReserved"), code: "reserved" });
    }
    if (r.erro === "duplicated") {
      return res.status(409).send({ msg: req.t("errors.categoryDuplicated"), code: "duplicated" });
    }
    if (r.erro) return res.status(400).send({ msg: req.t("errors.invalidName"), code: r.erro });

    res.status(201).send(r);
  });

  app.put("/me/recipe-categories/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.recipeCategory.renomear(req.params.id, req.body?.name);
    if (r.erro) return res.status(400).send({ msg: req.t("errors.invalidName"), code: r.erro });
    if (!r.ok) return res.status(404).send({ msg: req.t("errors.notFound"), code: "not_found" });

    res.send({ ok: true });
  });

  app.delete("/me/recipe-categories/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const r = await app.api.recipeCategory.apagar(req.params.id);
    if (!r.ok) return res.status(404).send({ msg: req.t("errors.notFound"), code: "not_found" });

    res.send({ ok: true });
  });
};
