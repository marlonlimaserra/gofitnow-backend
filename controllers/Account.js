const { exclusaoPedida } = require("../lib/emailTemplates.js");
const depoisLib = require("../lib/depois.js");

// `app.depois` só existe quando o teste o injeta — em produção ele é undefined,
// e chamá-lo direto estoura DEPOIS do `res.send`, onde o erro não tem para onde
// ir. O `|| depoisLib` é o padrão do Portal.js, e existe por isso.

// PEDIR A EXCLUSÃO DA PRÓPRIA CONTA.
//
// Exigência das duas lojas — diretriz 5.1.1(v) da App Store, e a mesma regra no
// Google Play, que ainda pede um endereço na web funcionando sem instalar o app.
// "Fale com o suporte" é recusa na revisão.
//
// ── NADA AQUI APAGA NADA ──────────────────────────────────────────────────
//
// Decisão do Marlon em 02/09/2026: o pedido vai para a fila do painel, ele
// conversa com a pessoa, e apagar é ato humano. Ver `User_model.pedirExclusaoDaConta`
// para o porquê — resumido: quase todo pedido de exclusão é outro problema com
// outro nome, e apagar no prazo atende o pedido e perde a conversa.
//
// ── AS TRAVAS, E O QUE MUDOU COM ELAS ─────────────────────────────────────
//
// A SENHA continua, mesmo sem apagar nada na hora. Não é sobre o dano imediato:
// é que um pedido registrado no nome de alguém que não pediu inicia uma conversa
// sobre apagar a conta dela, e a sessão do app fica aberta por semanas.
//
// A PALAVRA DIGITADA SAIU. Ela existia porque o toque apagava de verdade; agora
// o toque abre uma conversa que a própria pessoa pode cancelar na mesma tela.
// Exigir que ela escreva "EXCLUIR" para pedir atendimento é atrito sem risco do
// outro lado — e atrito na porta de saída é o tipo de coisa que a revisão da
// loja olha com desconfiança.
//
// O MOTIVO entrou, opcional. É o que ele vai ler antes de ligar.
const MAX_MOTIVO = 2000;

// ── O DONO DA INSTÂNCIA NÃO SE EXCLUI ─────────────────────────────────────
//
// "não permita usuário que é dono da instância excluir; no caso, só ver se o
// e-mail dele é mesmo e-mail que está cadastrado na instância na central."
//
// A razão é de consequência, e é grande: o registro central guarda UM e-mail por
// instância, com índice único, e é por ele que se descobre para onde mandar quem
// chegou sem dizer a instância. Apagar essa conta deixa a instância viva com um
// dono que não existe — ninguém para cobrar, ninguém para avisar, e ninguém que
// consiga entrar para arrumar. A assinatura na Stripe continua correndo.
//
// Quem quer encerrar de verdade encerra a INSTÂNCIA, que é outro caminho e tem
// tela própria no painel.
//
// ── Por que o e-mail, e o que isso custa ──────────────────────────────────
//
// Porque é o que existe: o registro central não guarda o `_id` do usuário dono,
// e não há outro vínculo entre as duas pontas.
//
// O custo é conhecido: trocar o e-mail de login aqui dentro NÃO atualiza o
// registro central, então o dono que trocou de e-mail deixa de ser reconhecido e
// volta a poder se excluir. É o mesmo desalinhamento que impediu esta
// comparação de virar a regra de quem pode assinar (ver `/me/checkout`).
//
// Falhar para qual lado: aqui a comparação é uma TRAVA, e uma trava que não
// dispara é menos grave que uma que dispara errado — ela deixa passar um caso
// raro em vez de barrar o dono legítimo todo dia. Central fora do ar devolve
// `false` pela mesma razão: exclusão de conta é direito da pessoa (LGPD, e o
// Google Play exige o caminho na web), e não pode ficar trancada porque um
// serviço nosso caiu.
async function ehDonoDaInstancia(app, req, user) {
  const meu = String(user?.email || "").trim().toLowerCase();
  if (!meu) return false;

  try {
    const registro = await app.api.center.byInstance(req.instance);
    const doRegistro = String(registro?.email || "").trim().toLowerCase();
    return Boolean(doRegistro) && doRegistro === meu;
  } catch (erro) {
    console.error("[exclusao] não consegui ler o dono no registro:", erro.message);
    return false;
  }
}

module.exports = function (app) {
  // O ESTADO, para a tela se desenhar antes de perguntar qualquer coisa: qual
  // dos três papéis é esta pessoa, quanta coisa some com ela, e se já existe
  // pedido de pé.
  app.get("/me/account/deletion", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const [papel, oQueVaiSumir, pedido, dono] = await Promise.all([
      app.api.user.papelNaExclusao(user),
      app.api.user.oQueVaiSumirNaExclusao(user),
      app.api.user.exclusaoPedida(user),
      ehDonoDaInstancia(app, req, user),
    ]);

    res.send({
      papel,
      oQueVaiSumir,
      maxMotivo: MAX_MOTIVO,
      // A tela usa isto para NÃO oferecer o caminho. A trava de verdade é no
      // POST abaixo — esconder botão não é proteção.
      dono,
      pedido: pedido
        ? { pedidaEm: pedido.pedidaEm, estado: pedido.estado, motivo: pedido.motivo || "" }
        : null,
    });
  });

  app.post("/me/account/deletion", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    if (await ehDonoDaInstancia(app, req, user)) {
      // 403: a sessão está boa, o poder não existe. E antes de pedir a senha —
      // pedi-la para recusar depois faria a pessoa digitar a senha dela para
      // ouvir que nunca podia.
      return res.status(403).send({
        msg: req.t("errors.deletionOwnerBlocked"),
        code: "dono_da_instancia",
      });
    }

    const senha = String(req.body?.senha || "");
    if (!senha) {
      return res.status(400).send({
        msg: req.t("errors.deletionNeedsPassword"),
        code: "senha_faltando",
      });
    }

    if (!(await app.api.user.conferirSenha(String(user._id), senha))) {
      // 403 e não 401: 401 faz o cliente achar que a SESSÃO caiu e mandar a
      // pessoa para o login, perdendo o que ela escreveu por causa de um erro
      // de digitação na senha.
      return res.status(403).send({
        msg: req.t("errors.deletionWrongPassword"),
        code: "senha_errada",
      });
    }

    const motivo = String(req.body?.motivo || "").trim().slice(0, MAX_MOTIVO);
    const r = await app.api.user.pedirExclusaoDaConta(user, motivo);

    if (!r.feito) {
      return res.status(503).send({ msg: req.t("errors.deletionFailed"), code: "falhou" });
    }

    res.send({ ok: true, papel: r.papel, pedidaEm: r.pedidaEm, jaExistia: r.jaExistia });

    // ── O E-MAIL, DEPOIS DE RESPONDER ───────────────────────────────────
    //
    // Vai para TODOS os papéis agora, e não só para o dono como na versão que
    // agendava. A razão passou a valer para os três: se alguém entrou na conta
    // de outra pessoa e pediu a exclusão, este e-mail é a única chance dela
    // saber antes de a conversa acontecer.
    //
    // Não repete quando o pedido já existia: apertar o botão de novo não pode
    // encher a caixa de entrada de quem já foi avisado.
    if (r.jaExistia || !user.email) return;

    const mail = exclusaoPedida({
      lang: req.lang,
      name: user.name,
      url: `https://${req.headers.host}/conta/excluir`,
    });

    (app.depois || depoisLib)(`aviso de pedido de exclusão em ${req.instance}`, () =>
      app.helpers.mailer.send({ to: user.email, ...mail })
    );
  });

  // DESISTIR.
  //
  // Sem senha, e é de propósito: cancelar não destrói nada, e a pessoa que
  // chegou aqui já provou quem é ao entrar. Pedir senha para PARAR é atrito no
  // lado errado.
  app.delete("/me/account/deletion", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const ok = await app.api.user.cancelarExclusaoDaConta(user);
    if (!ok) return res.status(404).send({ msg: req.t("errors.deletionNothingScheduled") });

    res.send({ ok: true });
  });
};
