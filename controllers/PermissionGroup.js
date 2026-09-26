// GRUPOS DE PERMISSÃO — o que SOMA ao tipo de usuário.
//
// *"crie em Configuração, embaixo de Permissão, um chamado Grupo de permissão;
// aí nesse grupo posso pôr permissões igual faço no usuário, aí posso pôr
// usuários nesse grupo, aí as permissões se somam"* (26/09/2026).
//
// ── A PERMISSÃO É A MESMA DE TIPOS DE USUÁRIO, e de propósito ────────────
//
// `roles.view` para ver, `roles.manage` para mexer. Tipo e grupo respondem à
// MESMA pergunta de segurança — quem pode dar poder a quem —, e separá-las
// criaria o pior dos dois mundos: alguém sem `roles.manage` que ainda assim
// consegue fabricar um grupo com o financeiro inteiro dentro e se pôr nele.
//
// Uma chave nova também apareceria desmarcada em todos os tipos já salvos, o
// que faria a tela sumir para quem hoje administra — um defeito que se
// apresenta como "sumiu o menu".
module.exports = function (app) {
  app.get("/permission-groups", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.view");
    if (user === false) return;

    // A contagem vem JUNTA: a lista mostra "3 usuários" em cada linha, e sem
    // isto seriam N idas ao banco para desenhar uma tela.
    const [grupos, contagem] = await Promise.all([
      app.api.permissionGroup.list(),
      app.api.permissionGroup.contagemDeUsuarios(),
    ]);

    res.send(grupos.map((g) => ({ ...g, userCount: contagem[String(g._id)] || 0 })));
  });

  // QUEM PODE ENTRAR NUM GRUPO — a lista para marcar na tela.
  //
  // Rota própria, e não `/users`: aquela exige `users.view`, e quem administra
  // permissões pode não administrar contas. Sem isto, a tela abriria com a
  // lista de membros vazia para metade de quem tem acesso a ela — e salvar
  // nesse estado esvaziaria o grupo.
  //
  // Devolve o MÍNIMO: id, nome, e-mail e o tipo. É uma lista para marcar
  // caixinha, não um cadastro.
  //
  // Antes de `/:id` de propósito: o Express casa na ordem, e `usuarios` seria
  // lido como um id.
  app.get("/permission-groups/usuarios", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.view");
    if (user === false) return;

    const todos = await app.api.user.listAll({ type: "trainer" });

    res.send(
      todos.map((u) => ({
        _id: String(u._id),
        name: u.name,
        email: u.email || "",
        roleName: u.roleName || "",
        active: u.active,
      }))
    );
  });

  app.get("/permission-groups/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.view");
    if (user === false) return;

    const grupo = await app.api.permissionGroup.data(req.params.id);
    if (!grupo) return res.status(404).send({ msg: req.t("errors.notFound") });

    // Os MEMBROS vêm com o grupo: a tela de edição precisa marcar quem já está
    // dentro, e pedi-los numa segunda chamada faria as caixas nascerem
    // desmarcadas por um instante — bastaria salvar nesse instante para
    // esvaziar o grupo.
    const membros = await app.api.permissionGroup.usuariosDe(req.params.id);

    res.send({ ...grupo, users: membros.map((m) => String(m._id)) });
  });

  app.post("/permission-groups", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const { name, description, permissions: lista, users, accounts } = req.body || {};

    if (!name || String(name).trim().length < 2) {
      return res.status(400).send({ msg: req.t("errors.requireGroupName") });
    }

    const existe = await app.api.permissionGroup.dataByName(name);
    if (existe) {
      return res.status(409).send({ msg: req.t("errors.groupNameTaken") });
    }

    const id = await app.api.permissionGroup.insert({ name, description, permissions: lista, accounts });
    if (Array.isArray(users)) await app.api.permissionGroup.definirUsuarios(id, users);

    const criado = await app.api.permissionGroup.data(id);

    app.insertUserActionHistory(req, user, "create_permission_group", {
      category: "admin",
      local: { target_type: "permission_groups", target_id: id + "" },
      extra: { name: criado.name, permissions: criado.permissions },
    });

    res.status(201).send(criado);
  });

  app.put("/permission-groups/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const antes = await app.api.permissionGroup.data(req.params.id);
    if (!antes) return res.status(404).send({ msg: req.t("errors.notFound") });

    const { name, description, permissions: lista, users, accounts } = req.body || {};

    if (name !== undefined && String(name).trim().length < 2) {
      return res.status(400).send({ msg: req.t("errors.requireGroupName") });
    }

    if (name !== undefined) {
      const outro = await app.api.permissionGroup.dataByName(name);
      if (outro && String(outro._id) !== String(req.params.id)) {
        return res.status(409).send({ msg: req.t("errors.groupNameTaken") });
      }
    }

    await app.api.permissionGroup.update(req.params.id, { name, description, permissions: lista, accounts });
    if (Array.isArray(users)) await app.api.permissionGroup.definirUsuarios(req.params.id, users);

    const depois = await app.api.permissionGroup.data(req.params.id);

    app.insertUserActionHistory(req, user, "update_permission_group", {
      category: "admin",
      local: { target_type: "permission_groups", target_id: req.params.id + "" },
      extra: { name: depois.name },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/permission-groups/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const grupo = await app.api.permissionGroup.data(req.params.id);
    if (!grupo) return res.status(404).send({ msg: req.t("errors.notFound") });

    // ── A TRAVA DA ÚLTIMA PORTA ──────────────────────────────────────────
    //
    // Se este grupo é o que dá `roles.manage` a quem está mexendo nele, apagá-lo
    // tranca a casa: ninguém mais consegue abrir esta tela para desfazer. A
    // mesma trava existe em Tipos de usuário, e pela mesma razão.
    if ((grupo.permissions || []).includes("roles.manage") && !user.admin) {
      const semGrupo = (user.permissions || []).filter((p) => p === "roles.manage").length;
      const soPorAqui = semGrupo && (await estaNoGrupo(app, user._id, req.params.id));
      const doTipo = await app.api.role.grants(user.role, "roles.manage");

      if (soPorAqui && !doTipo) {
        return res.status(409).send({ msg: req.t("errors.lastManagerGroup"), code: "last_manager" });
      }
    }

    await app.api.permissionGroup.delete(req.params.id);

    app.insertUserActionHistory(req, user, "delete_permission_group", {
      category: "admin",
      local: { target_type: "permission_groups", target_id: req.params.id + "" },
      extra: { name: grupo.name },
    });

    res.send({ ok: true });
  });
};

async function estaNoGrupo(app, userId, groupId) {
  const membros = await app.api.permissionGroup.usuariosDe(groupId);
  return membros.some((m) => String(m._id) === String(userId));
}
