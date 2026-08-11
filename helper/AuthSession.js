// Reads the request's `session` header and validates the token. Replies 401
// and returns false when there is no valid session — callers only need to
// check the return value.
function AuthSession(app) {
  this.app = app;
}

AuthSession.prototype.protect = async function (req, res) {
  const token = req.headers.session;

  if (token === undefined || token === "") {
    res.status(401).send({ msg: req.t("errors.noSession") });
    return false;
  }

  const check = await this.app.api.auth.verify(token);

  if (check === false) {
    res.status(401).send({ msg: req.t("errors.invalidSession") });
    return false;
  }

  return check;
};

module.exports = AuthSession;
