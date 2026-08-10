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

    const { name, email, peopleSingular, peoplePlural } = req.body || {};

    if (name !== undefined && String(name).trim().length < 2) {
      res.status(400).send({ msg: "Informe seu nome." });
      return;
    }

    // Free text, but bounded: this word lands in menus, titles and buttons, so
    // an empty one would leave blanks on screen and a long one would break the
    // layout everywhere at once.
    for (const [value, field] of [
      [peopleSingular, "singular"],
      [peoplePlural, "plural"],
    ]) {
      if (value === undefined) continue;
      const clean = String(value).trim();
      if (clean.length < 3 || clean.length > 20) {
        res.status(400).send({
          msg: `Use entre 3 e 20 letras para o ${field} (ex.: aluno / alunos).`,
        });
        return;
      }
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

    // Name, e-mail and the vocabulary. The password has its own route
    // (/auth/password); `type`, `role`, `admin` and `active` are not something
    // you change on yourself — that would make every permission optional.
    await app.api.user.updateSelf(user._id, { name, email, peopleSingular, peoplePlural });

    const updated = await app.api.user.data(user._id);
    res.send(await app.api.user.withRole(updated));
  });
};
