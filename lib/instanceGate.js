const instanceContext = require("./instance.js");

// De qual INSTÂNCIA é esta requisição.
//
// Tem de vir ANTES de qualquer coisa que toque o banco: os modelos leem a
// instância do contexto assíncrono, e fora dele eles estouram de propósito.
//
// As rotas abertas são a exceção que prova a regra — elas não têm instância e
// nem precisam: `/public/theme` é resolvido por host e `/` é só um ping. Sem
// esta lista, elas responderiam 400 pedindo um cabeçalho que ninguém tem como
// mandar de uma tela de login.
const SEM_INSTANCIA = [/^\/$/, /^\/public\//, /^\/internal\//];

// Recebe o `app` para alcançar `app.api.center` — o registro é a única coisa
// que separa um nome bem formado de um cliente que existe.
function criar(app) {
  return async function instanceGate(req, res, next) {
    const caminho = req.path || "";
    if (SEM_INSTANCIA.some((r) => r.test(caminho))) return next();

    // De onde vem a instância, em ordem:
    //
    //   1. `X-Instance` — quem integra por chave de API e sabe o nome.
    //   2. `X-Instance-Host` — o app do navegador dizendo em que endereço ELE está.
    //      Necessário porque a chamada dele sai para backend.gofitnow.fit: o Host que
    //      chega aqui é o do backend, e o subdomínio da tela não atravessa sozinho.
    //   3. o Host desta requisição, para quem aponta o próprio endereço direto na API.
    //   4. `?instance=`, último recurso, útil em teste manual.
    //
    // Os dois primeiros vêm do cliente e valem o que qualquer cabeçalho vale: nada,
    // até serem conferidos contra o registro logo abaixo.
    let instance = instanceContext.fromRequest(req);

    try {
      if (!instance && req.headers["x-instance-host"]) {
        // Resolvido no SERVIDOR, contra o registro. O navegador diz o endereço, não
        // a instância — senão bastaria trocar um cabeçalho para escolher o banco.
        instance = await app.api.center.instanceForHost(req.headers["x-instance-host"]);
      }

      if (!instance) {
        // 400 e não 401: não é falta de credencial, é falta de endereço. A mensagem
        // diz COMO mandar, senão quem integra fica adivinhando.
        return res.status(400).send({
          msg: req.t("errors.noInstance"),
          code: "no_instance",
        });
      }

      // O nome ser BEM FORMADO não é o mesmo que ele ser de alguém.
      //
      // `fromRequest` só sabe ler: `bruna.gofitnow.fit` dá o nome "bruna", que passa
      // em qualquer validação de formato. Sem conferir na central, esse nome abriria
      // o banco `gofitnow_bruna` — que o Mongo cria na primeira escrita — e passaria
      // a existir um cliente que ninguém cadastrou, com login e dados próprios.
      //
      // Vale igual para `X-Instance`: ele vem de fora e qualquer um escreve o que
      // quiser nele. Este é o único lugar que separa "pediu" de "tem".
      const conhecida = await app.api.center.isActive(instance);
      if (!conhecida) {
        // 404: este endereço não é de ninguém. Não é 401 nem 403 — não há
        // credencial que resolva, e dizer "não autorizado" mandaria a pessoa
        // procurar a senha.
        return res.status(404).send({
          msg: req.t("errors.unknownInstance"),
          code: "unknown_instance",
        });
      }
    } catch (error) {
      // A central inalcançável FECHA a porta, não abre.
      //
      // Deixar passar quando não se consegue conferir é o pior dos dois: seria
      // exatamente nesse minuto que um subdomínio inventado funcionaria. 503 diz a
      // verdade — é indisponibilidade nossa, não erro de quem chamou.
      console.error("[instance] não consegui conferir a instância na central:", error.message);
      return res.status(503).send({
        msg: req.t("errors.internal"),
        code: "instance_check_failed",
      });
    }

    req.instance = instance;
    // Daqui para dentro, tudo o que rodar nesta requisição vê a instância.
    instanceContext.run(instance, next);
  };
}

module.exports = criar;
module.exports.SEM_INSTANCIA = SEM_INSTANCIA;
