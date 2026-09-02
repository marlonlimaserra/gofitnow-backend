// O PLANO DESTE CLIENTE, e a vitrine dos outros.
//
// O painel do center é quem cria e ordena os planos; este backend só LÊ, pela
// mesma porta por onde já lê os limites. O que existe aqui são duas perguntas
// que o produto faz:
//
//   "em que plano eu estou?"     — para o selo no topo do app
//   "quais existem?"             — para a tela de escolher
//
// Elas são duas rotas e não uma porque têm frequências muito diferentes: a
// primeira é pedida na abertura de todo app, a segunda só quando alguém toca no
// selo. Juntá-las mandaria a vitrine inteira em toda abertura.
module.exports = function (app) {
  // O plano de quem está pedindo.
  //
  // `null` quando o cliente não tem plano nenhum, e isso NÃO é o mesmo que estar
  // num plano gratuito: o app não mostra selo algum no primeiro caso, porque
  // "não sei em que plano você está" não é uma informação para dar a ninguém.
  app.get("/me/plan", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({ plan: await app.api.center.planFor(req.instance) });
  });

  // A vitrine, e qual deles é o atual.
  //
  // A CHAVE DO ATUAL VAI JUNTO, e não um booleano por linha: quem desenha a tela
  // precisa marcar "este é o seu" mesmo quando o plano atual saiu da vitrine —
  // um plano desativado no painel continua valendo para quem já o assinou, e
  // some da lista. Nesse caso ele vem também, no fim, marcado como fora de
  // catálogo. Sem isso a tela diria "escolha um plano" para quem já tem um, sem
  // mostrar qual.
  app.get("/me/plans", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const [rows, atual] = await Promise.all([
      app.api.center.plansForSale(),
      app.api.center.planFor(req.instance),
    ]);

    const naVitrine = atual && rows.some((p) => p.key === atual.key);

    res.send({
      rows: naVitrine || !atual ? rows : [...rows, { ...atual, foraDoCatalogo: true }],
      current: atual ? atual.key : null,
    });
  });
};
