const instanceContext = require("../lib/instance.js");

// CONECTAR O INSTAGRAM DO PROFISSIONAL AO VAFIT.
//
// *"agora precisamos conectar a conta do Facebook e a conta do Instagram no
// VAFIT"* (26/09/2026).
//
// Três rotas para a pessoa e uma para a Meta:
//
//   GET    /contas-conectadas          a lista, sem token nenhum
//   GET    /contas-conectadas/url      para onde mandar o navegador
//   DELETE /contas-conectadas/:id      desliga
//   GET    /auth/instagram/callback    a volta, chamada pelo Instagram
//
// ── Por que o callback é PÚBLICO e sem sessão ───────────────────────────
//
// Porque quem bate nele é o navegador da pessoa voltando do instagram.com, e
// nessa volta não há cabeçalho de autorização — é uma navegação, não uma
// chamada da aplicação. O que prova que a volta é legítima é o `state`: um
// bilhete de uso único que NÓS emitimos, guardado no banco com TTL, carregando
// de qual cliente ele saiu. Ver `Oauth_model`.
module.exports = function (app) {
  // ── A LISTA ────────────────────────────────────────────────────────────
  app.get("/contas-conectadas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.view");
    if (user === false) return;

    const [contas, chaves] = await Promise.all([
      app.api.contaConectada.lista(req.query.tipo),
      app.api.oauthInstagram.chaves(),
    ]);

    // `ligado` é o que decide se o botão de conectar aparece. Sem as chaves da
    // Meta na central, o botão levaria a uma tela de erro do Instagram — e o
    // que a pessoa leria é que a conta DELA tem problema.
    res.send({ contas, instagram: { ligado: chaves.ligado } });
  });

  // ── PARA ONDE MANDAR O NAVEGADOR ───────────────────────────────────────
  app.get("/contas-conectadas/url", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.manage");
    if (user === false) return;

    try {
      const { ligado, clientId } = await app.api.oauthInstagram.chaves();
      if (!ligado) return res.send({ ligado: false });

      const state = await app.api.oauthInstagram.criarEstado(
        instanceContext.current(),
        req.headers["x-instance-host"],
        req.query.destino,
        // Quem clicou atravessa a ida e a volta: na volta não há sessão, e sem
        // isto a conta ficaria registrada como conectada por ninguém.
        { userId: user._id }
      );

      res.send({ ligado: true, url: app.api.oauthInstagram.urlDeAutorizacao(clientId, state) });
    } catch (erro) {
      console.error("[instagram] não consegui montar o link:", erro.message);
      res.send({ ligado: false });
    }
  });

  // ── DESLIGAR ───────────────────────────────────────────────────────────
  //
  // Apaga dos DOIS lugares: a conta no banco do cliente e a linha do diretório
  // na central. Só o primeiro deixaria o webhook continuar entregando eventos
  // a um cliente que não tem mais token para responder.
  app.delete("/contas-conectadas/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.manage");
    if (user === false) return;

    const conta = await app.api.contaConectada.porId(req.params.id);
    if (!conta) return res.status(404).send({ msg: req.t("errors.notFound") });

    await app.api.center.esquecerContaDaMeta({
      tipo: conta.tipo,
      externalId: conta.externalId,
      instancia: instanceContext.current(),
    });

    await app.api.contaConectada.remover(req.params.id);

    app.insertUserActionHistory(req, user, "integrations.disconnect", {
      category: "integrations",
      extra: { tipo: conta.tipo, conta: conta.usuario || conta.externalId },
    });

    res.send({ ok: true });
  });

  // ── A VOLTA DO INSTAGRAM ───────────────────────────────────────────────
  //
  // Sempre termina em REDIRECT, nunca em JSON: quem está do outro lado é uma
  // aba do navegador, e um JSON aqui deixaria a pessoa olhando chaves e
  // colchetes no meio de um fluxo que ela começou clicando num botão.
  app.get("/auth/instagram/callback", async function (req, res) {
    const semRumo = null;

    const paraTela = (estado, resultado) => {
      const base = app.api.oauthInstagram.enderecoDeVolta(estado);
      const p = new URLSearchParams(resultado);
      // `/configuration/`, em inglês: é a rota do painel (`App.jsx`), e ela
      // NÃO é traduzida de propósito — um endereço que mudasse com o idioma
      // quebraria o link que alguém mandou para outra pessoa.
      return res.redirect(`${base}/configuration/contas-conectadas?${p.toString()}`);
    };

    // A pessoa clicou em "Cancelar" no Instagram. Não é erro: é resposta.
    if (req.query.error) {
      const estado = await app.api.oauthInstagram.consumirEstado(req.query.state);
      return paraTela(estado, { meta: "cancelado" });
    }

    let estado = null;
    try {
      estado = await app.api.oauthInstagram.consumirEstado(req.query.state);
      if (!estado) return paraTela(semRumo, { meta: "expirou" });

      const chaves = await app.api.oauthInstagram.chaves();
      if (!chaves.ligado) return paraTela(estado, { meta: "sem_chaves" });

      const conta = await app.api.oauthInstagram.contaDoCodigo(req.query.code, chaves);
      if (conta.erro) {
        console.error("[instagram] a volta falhou:", conta.erro, conta.detalhe || "");
        return paraTela(estado, { meta: "falhou" });
      }

      // Daqui para baixo tudo acontece DENTRO do cliente que começou o fluxo —
      // o nome veio do bilhete, não de um cabeçalho que alguém possa escrever.
      await instanceContext.run(estado.instancia, async () => {
        const quem = estado.userId ? await app.api.user.data(estado.userId) : null;

        await app.api.contaConectada.guardar({ tipo: "instagram", ...conta }, quem);

        await app.api.center.registrarContaDaMeta({
          tipo: "instagram",
          externalId: conta.externalId,
          instancia: estado.instancia,
        });

        if (quem) {
          app.insertUserActionHistory({ ...req, user: quem }, quem, "integrations.connect", {
            category: "integrations",
            extra: { tipo: "instagram", conta: conta.usuario },
          });
        }
      });

      return paraTela(estado, { meta: "ok", conta: conta.usuario });
    } catch (erro) {
      console.error("[instagram] a volta estourou:", erro.message);
      return paraTela(estado, { meta: "falhou" });
    }
  });
};
