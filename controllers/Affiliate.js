// O PROGRAMA DE AFILIADO do profissional.
//
// Uma rota, de leitura. O acordo é entre nós e ele: quanto ele ganha, quem ele
// trouxe e quanto já saiu são registros nossos, e o app só os mostra.
//
// ── Quem pode ver ─────────────────────────────────────────────────────────
//
// `users.manage`, a mesma que guarda o vocabulário e o idioma da conta — e pelo
// mesmo motivo escrito lá: uma permissão nova para uma tela só seria mais um item
// no catálogo sem ninguém para atribuí-lo.
//
// Não é `verify` (qualquer sessão) de propósito: isto é dinheiro da CONTA. Uma
// secretária com acesso à agenda não precisa saber quanto o dono ganha de indicação.
module.exports = function (app) {
  app.get("/me/affiliate", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const painel = await app.api.affiliate.painel();

    // Sem registro no central é o caso do desenvolvimento local e de um cliente
    // criado à mão. Devolve o esqueleto em vez de 404: a tela abre explicando que
    // ainda não há código, o que é melhor que uma tela de erro sobre algo que a
    // pessoa não pode resolver.
    if (!painel) {
      return res.send({
        alias: "",
        indicadoPor: null,
        programa: await app.api.affiliate.regra(),
        indicadas: [],
        comissoes: { aPagarCents: 0, pagoCents: 0, quantas: 0 },
      });
    }

    res.send(painel);
  });
};
