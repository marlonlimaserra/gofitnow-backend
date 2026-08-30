// Reads the request's `session` header and validates the token. Replies 401
// and returns false when there is no valid session — callers only need to
// check the return value.
function AuthSession(app) {
  this.app = app;
}

// O token do cabeçalho, sem validar nada.
//
// Existe para a sessão guardada poder montar a chave ANTES de ir ao banco — é o
// token que identifica a entrada no cache. Separado do `protect` de propósito:
// ler o cabeçalho e VALIDAR são coisas diferentes, e quem chama esta aqui não
// está autorizando ninguém.
AuthSession.prototype.tokenDe = function (req) {
  const token = req?.headers?.session;
  return typeof token === "string" && token !== "" ? token : "";
};

AuthSession.prototype.protect = async function (req, res) {
  const token = this.tokenDe(req);

  if (!token) {
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
