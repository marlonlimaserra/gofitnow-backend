module.exports = function (app) {
  // Reading the audit trail. Writing it is not a route: it happens inside the
  // action being recorded, so nothing can log something that did not run.

  app.get("/action-history", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "logs.view");
    if (user === false) return;

    res.send(
      await app.api.actionHistory.list({
        user: req.query.user,
        action: req.query.action,
        category: req.query.category,
        targetType: req.query.targetType,
        targetId: req.query.targetId,
        search: req.query.search,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
        skip: req.query.skip,
      })
    );
  });

  // Everything that ever happened to one record — the view that answers "who
  // changed this person's data?" without scrolling the whole history.
  app.get("/action-history/:targetType/:targetId", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "logs.view");
    if (user === false) return;

    res.send(
      await app.api.actionHistory.list({
        targetType: req.params.targetType,
        targetId: req.params.targetId,
        limit: req.query.limit,
        skip: req.query.skip,
      })
    );
  });
};
