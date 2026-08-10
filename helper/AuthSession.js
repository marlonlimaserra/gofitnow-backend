// Lê o header `session` da requisição e valida o token. Responde 401 e devolve
// false quando não há sessão válida — quem chama só precisa checar o retorno.
function AuthSession(app) {
  this.app = app;
}

AuthSession.prototype.protege = async function (req, res) {
  const token = req.headers.session;

  if (token === undefined || token === "") {
    res.status(401).send({ msg: "Sessão não informada." });
    return false;
  }

  const verifica = await this.app.api.auth.verificar(token);

  if (verifica === false) {
    res.status(401).send({ msg: "Sessão inválida ou expirada." });
    return false;
  }

  return verifica;
};

module.exports = AuthSession;
