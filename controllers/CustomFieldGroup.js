// OS GRUPOS DE CAMPOS — as gavetas da ficha.
//
// *"gostaria de poder separar os campos por grupo"* (01/10/2026).
//
// As permissões são as mesmas dos campos, e pelo mesmo motivo: LER é da ficha
// (`people.view`), porque é ela que desenha as gavetas; ESCREVER é de quem
// administra a conta (`users.manage`), porque muda a ficha de todo mundo.
module.exports = function (app) {
  const paraTela = (req) => (g) => ({
    ...g,
    _id: String(g._id),
    // Como nos campos nativos: o padrão nasce sem nome e o rótulo sai da
    // tradução de quem abre. Renomeou, o nome da casa vence.
    name: g.name || (g.rotuloPadrao ? req.t(g.rotuloPadrao) : ""),
  });

  app.get("/custom-field-groups", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const lista = await app.api.customFieldGroup.list();
    res.send({ rows: lista.map(paraTela(req)) });
  });

  const recusa = (req, res, erro) => {
    const porErro = {
      sem_nome: ["customFieldGroupNoName", 400],
      em_uso: ["customFieldGroupTaken", 409],
      padrao: ["customFieldGroupIsDefault", 400],
      nao_encontrado: ["customFieldGroupNotFound", 404],
    };

    const [chave, status] = porErro[erro] || ["customFieldGroupNoName", 400];
    res.status(status).send({ msg: req.t("errors." + chave), code: erro });
  };

  app.post("/custom-field-groups", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.customFieldGroup.insert(req.body || {});
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "create_custom_field_group", {
      category: "configuration",
      local: { target_type: "custom_field_groups", target_id: String(r.id) },
    });

    res.status(201).send(paraTela(req)(await app.api.customFieldGroup.data(r.id)));
  });

  // ── `/ordem` ANTES de `/:id` ────────────────────────────────────────────
  //
  // O Express casa na ordem de registro: com `/:id` em cima, um `PUT
  // /custom-field-groups/ordem` entraria na rota de UM grupo com
  // `id = "ordem"` — que não é ObjectId, então a resposta seria "grupo não
  // encontrado" e a ordem nunca salvaria. Silencioso e chato de achar.
  // A ORDEM das gavetas, numa chamada só. `PUT` numa rota de coleção porque o
  // que se substitui é a ordem INTEIRA — não a de um grupo.
  app.put("/custom-field-groups/ordem", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.customFieldGroup.reordenar((req.body || {}).ids);
    if (!r.ok) return res.status(400).send({ msg: req.t("errors.customFieldGroupNoName") });

    const lista = await app.api.customFieldGroup.list();
    res.send({ rows: lista.map(paraTela(req)) });
  });

  app.put("/custom-field-groups/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.customFieldGroup.update(req.params.id, req.body || {});
    if (r.erro) return recusa(req, res, r.erro);

    res.send(paraTela(req)(await app.api.customFieldGroup.data(req.params.id)));
  });

  app.delete("/custom-field-groups/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.customFieldGroup.remove(req.params.id);
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "delete_custom_field_group", {
      category: "configuration",
      local: { target_type: "custom_field_groups", target_id: String(req.params.id) },
      extra: { movidos: r.movidos },
    });

    // Os campos que estavam dentro voltaram para o grupo padrão — e a tela
    // precisa dizer quantos, senão a pessoa só descobre rolando a lista.
    res.send({ msg: req.t("ok.customFieldGroupRemoved", { quantos: r.movidos }), movidos: r.movidos });
  });
};
