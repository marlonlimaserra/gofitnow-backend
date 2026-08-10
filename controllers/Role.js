const permissions = require("../lib/permissions.js");

module.exports = function (app) {
  // The "Tipos de usuário" menu. Whoever holds roles.manage can grant any
  // permission, including roles.manage itself — that is the point of the
  // screen, and it is why the guards below refuse to let the last such account
  // take that power away from itself.

  // The catalog the screen renders its checkboxes from. Reading it needs
  // roles.view and nothing more: it is a list of capability names, not data.
  app.get("/permissions", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.view");
    if (user === false) return;

    res.send({ groups: permissions.GROUPS });
  });

  app.get("/roles", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.view");
    if (user === false) return;

    res.send(await app.api.role.list());
  });

  app.get("/roles/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.view");
    if (user === false) return;

    const role = await app.api.role.data(req.params.id);
    if (!role) {
      res.status(404).send({ msg: "Tipo de usuário não encontrado." });
      return;
    }

    res.send({ ...role, totalUsers: await app.api.role.countUsers(role._id) });
  });

  app.post("/roles", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const { name, description, permissions: list } = req.body || {};

    if (!name || String(name).trim().length < 2) {
      res.status(400).send({ msg: "Informe o nome do tipo." });
      return;
    }

    const exists = await app.api.role.dataByName(name);
    if (exists) {
      res.status(409).send({ msg: "Já existe um tipo com esse nome." });
      return;
    }

    const id = await app.api.role.insert({ name, description, permissions: list });
    res.status(201).send(await app.api.role.data(id));
  });

  app.put("/roles/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const target = await app.api.role.data(req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Tipo de usuário não encontrado." });
      return;
    }

    const body = req.body || {};

    // Administrador is the way back in. If it could lose a permission, an
    // unlucky edit would leave the platform with a screen nobody can open and
    // no account able to fix it.
    if (target.system === true && target.name === app.api.role.adminName) {
      res.status(409).send({
        msg: "O tipo Administrador não pode ser alterado. Crie outro tipo para ajustar permissões.",
      });
      return;
    }

    if (body.name !== undefined) {
      if (String(body.name).trim().length < 2) {
        res.status(400).send({ msg: "Informe o nome do tipo." });
        return;
      }
      const exists = await app.api.role.dataByName(body.name);
      if (exists && String(exists._id) !== String(target._id)) {
        res.status(409).send({ msg: "Já existe um tipo com esse nome." });
        return;
      }
    }

    // Editing your OWN type is allowed, but not in a way that removes the last
    // account able to manage permissions — that is a one-way door.
    const losesManage =
      body.permissions !== undefined &&
      (target.permissions || []).includes("roles.manage") &&
      !permissions.sanitize(body.permissions).includes("roles.manage");

    if (losesManage) {
      const others = await app.api.role.countActiveUsersWith("roles.manage", user._id);
      const iUseIt = String(user.role) === String(target._id);

      if (iUseIt && others === 0) {
        res.status(409).send({
          msg: "Este é o único tipo que ainda gerencia permissões, e é o seu. Dê essa permissão a outro tipo antes.",
        });
        return;
      }
    }

    await app.api.role.update(req.params.id, body);
    res.send(await app.api.role.data(req.params.id));
  });

  app.delete("/roles/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const target = await app.api.role.data(req.params.id);
    if (!target) {
      res.status(404).send({ msg: "Tipo de usuário não encontrado." });
      return;
    }

    if (target.system === true) {
      res.status(409).send({ msg: "Os tipos padrão do sistema não podem ser excluídos." });
      return;
    }

    // Deleting a type in use would leave those accounts with no permissions at
    // all — they would still log in and find every screen gone.
    const inUse = await app.api.role.countUsers(target._id);
    if (inUse > 0) {
      res.status(409).send({
        msg:
          inUse +
          (inUse === 1 ? " usuário usa" : " usuários usam") +
          " este tipo. Mude o tipo dessas contas antes de excluir.",
      });
      return;
    }

    await app.api.role.delete(req.params.id);
    res.send({ msg: "Tipo removido." });
  });
};
