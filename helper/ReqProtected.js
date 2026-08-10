// Gateway for authenticated routes: validates the session, loads the user who
// owns it and leaves everything on req._user. When it returns false the
// response has already been sent — the controller only needs to return.
function ReqProtected(app) {
  this.app = app;
}

// Any signed-in user (trainer or student).
ReqProtected.prototype.verify = async function (req, res) {
  const session = await this.app.helpers.authSession.protect(req, res);
  if (session === false) return false;

  const user = await this.app.api.user.data(session.user);

  // Valid token pointing at a removed/disabled user: drop the session.
  if (!user || user.active === 0) {
    await this.app.api.auth.deleteToken(session.token);
    res.status(401).send({ msg: "Conta indisponível." });
    return false;
  }

  req._user = this.app.api.user.filter(user);
  req._token = session.token;

  return req._user;
};

// Routes only a trainer can reach (student management). A signed-in student
// gets here with a valid session — hence 403, not 401.
ReqProtected.prototype.verifyTrainer = async function (req, res) {
  const user = await this.verify(req, res);
  if (user === false) return false;

  if (user.type !== "trainer") {
    res.status(403).send({ msg: "Disponível apenas para personal trainer." });
    return false;
  }

  return user;
};

// Platform administration routes (the Clients menu). `admin` is a flag on the
// user, independent of type.
ReqProtected.prototype.verifyAdmin = async function (req, res) {
  const user = await this.verify(req, res);
  if (user === false) return false;

  if (user.admin !== true) {
    res.status(403).send({ msg: "Acesso restrito ao administrador." });
    return false;
  }

  return user;
};

module.exports = ReqProtected;
