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

module.exports = function (app) {
  // O ESTADO, para a tela se desenhar antes de perguntar qualquer coisa: qual
  // dos três papéis é esta pessoa, quanta coisa some com ela, e se já existe
  // pedido de pé.
  app.get("/me/account/deletion", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const [papel, oQueVaiSumir, pedido] = await Promise.all([
      app.api.user.papelNaExclusao(user),
      app.api.user.oQueVaiSumirNaExclusao(user),
      app.api.user.exclusaoPedida(user),
    ]);

    res.send({
      papel,
      oQueVaiSumir,
      maxMotivo: MAX_MOTIVO,
      pedido: pedido
        ? { pedidaEm: pedido.pedidaEm, estado: pedido.estado, motivo: pedido.motivo || "" }
        : null,
    });
  });

  app.post("/me/account/deletion", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

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
