// Porta de entrada das rotas autenticadas: valida a sessão, carrega o usuário
// dono dela e deixa tudo em req._user. Se devolver false, a resposta já foi
// enviada — o controller só precisa dar return.
function ReqProtected(app) {
  this.app = app;
}

// Qualquer usuário logado (trainer ou student).
ReqProtected.prototype.verify = async function (req, res) {
  const verification = await this.app.helpers.authSession.protege(req, res);
  if (verification === false) return false;

  const user = await this.app.api.user.data(verification.user);

  // Token válido apontando pra usuário removido/desativado: derruba a sessão.
  if (!user || user.active === 0) {
    await this.app.api.auth.deleteToken(verification.token);
    res.status(401).send({ msg: "Conta indisponível." });
    return false;
  }

  req._user = this.app.api.user.filter(user);
  req._token = verification.token;

  return req._user;
};

// Rotas que só o trainer acessa (gestão de alunos). Um student logado chega
// aqui com sessão válida — por isso 403, não 401.
ReqProtected.prototype.verifyTrainer = async function (req, res) {
  const user = await this.verify(req, res);
  if (user === false) return false;

  if (user.type !== "trainer") {
    res.status(403).send({ msg: "Disponível apenas para personal trainer." });
    return false;
  }

  return user;
};

// Rotas de administração da plataforma (menu Clientes). `admin` é flag do
// usuário, independente do type.
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
