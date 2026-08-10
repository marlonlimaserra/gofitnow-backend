// Gateway for authenticated routes: validates the session, loads the user who
// owns it together with the permissions of their role, and leaves everything
// on req._user. When it returns false the response has already been sent — the
// controller only needs to return.
//
// Authorization is by PERMISSION, never by "is this an admin". A route asks
// for a key from lib/permissions.js and any role carrying that key passes,
// which is what lets a second admin-equivalent type exist without touching
// a single route.
function ReqProtected(app) {
  this.app = app;
}

// Any signed-in user. `req._user.permissions` is always an array — empty for
// someone whose role grants nothing, never undefined, so callers can check it
// without guarding first.
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

  req._user = await this.app.api.user.withRole(user);
  req._token = session.token;

  return req._user;
};

ReqProtected.prototype.has = function (user, permission) {
  return !!user && Array.isArray(user.permissions) && user.permissions.includes(permission);
};

// The guard every protected route uses. A signed-in user missing the
// permission gets 403 (the session is fine, the power is not) — never 401,
// which would send the frontend to the login screen for no reason.
ReqProtected.prototype.can = async function (req, res, permission) {
  const user = await this.verify(req, res);
  if (user === false) return false;

  if (!this.has(user, permission)) {
    res.status(403).send({
      msg: "Seu tipo de usuário não tem permissão para isso.",
      permission: permission,
    });
    return false;
  }

  return user;
};

// Routes that need EVERY key in the list — used where one action touches two
// areas at once.
ReqProtected.prototype.canAll = async function (req, res, permissions) {
  const user = await this.verify(req, res);
  if (user === false) return false;

  const missing = permissions.filter((p) => !this.has(user, p));
  if (missing.length > 0) {
    res.status(403).send({
      msg: "Seu tipo de usuário não tem permissão para isso.",
      permission: missing[0],
    });
    return false;
  }

  return user;
};

module.exports = ReqProtected;
