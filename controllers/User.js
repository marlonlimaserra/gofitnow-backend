module.exports = function (app) {
  // The signed-in user's own profile — works for both types. For a student it
  // also returns who their trainer is, which the screen shows.
  app.get("/me", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const payload = { ...user };

    if (user.type === "student" && user.trainer) {
      const trainer = await app.api.user.data(user.trainer);
      if (trainer) {
        payload.trainerInfo = {
          _id: trainer._id,
          name: trainer.name,
          email: trainer.email,
        };
      }
    }

    res.send(payload);
  });

  app.put("/me", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { name, email } = req.body || {};

    if (name !== undefined && String(name).trim().length < 2) {
      res.status(400).send({ msg: "Informe seu nome." });
      return;
    }

    if (email !== undefined) {
      if (!app.validator.isEmail(String(email).trim())) {
        res.status(400).send({ msg: "E-mail inválido." });
        return;
      }
      const exists = await app.api.user.dataByEmail(email);
      if (exists && String(exists._id) !== String(user._id)) {
        res.status(409).send({ msg: "Esse e-mail já está em uso." });
        return;
      }
    }

    // Name and e-mail only. The password has its own route (/auth/password);
    // `type`, `admin` and `active` are not something you change on yourself.
    await app.api.user.updateSelf(user._id, { name, email });

    const updated = await app.api.user.data(user._id);
    res.send(await app.api.user.withRole(updated));
  });
};
