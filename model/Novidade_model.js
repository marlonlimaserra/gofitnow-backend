// AS NOVIDADES DO PRODUTO, do lado de quem usa.
//
// ── MORA NO CENTRAL, e aqui é SÓ LEITURA ──────────────────────────────────
//
// A notícia é sobre o produto, e o produto é um só — mesma razão das ideias e
// dos chamados (ver Idea_model.js). Quem escreve é o painel, na tela Novidades;
// quem lê é isto, por `centralDb()`.
//
// O formato do documento está escrito dos DOIS lados, de propósito:
// `ChangelogPost_model.js` do center-backend é o outro. A tentação é importar de
// lá; são dois deploys com dois `package.json`, e um `require` atravessando
// projetos quebra no primeiro deploy de um só.
//
// ── A MESMA COLEÇÃO QUE ALIMENTA O SITE ───────────────────────────────────
//
// `changelog_posts` já era lida por `/public/changelog/posts`, que o site
// consome em /novidades. Não criei uma coleção paralela, e a razão é a que
// motivou a tela: se a notícia do lançamento fosse um segundo lugar para
// escrever, o Marlon escreveria no site e esqueceria no app — ou o contrário, e
// aí o cliente que liberou o módulo leria uma notícia que a página pública não
// tem.
//
// Uma notícia, dois públicos. O que muda é só o `modulo`, que o site ignora.
function Novidade_model(app) {
  this.app = app;
}

// Quantas o app mostra. Vinte cobre mais de um ano de lançamentos e não faz
// ninguém rolar uma lista de história do produto — quem quer tudo tem a página
// pública, que pagina.
const QUANTAS = 20;

Novidade_model.prototype.collection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("changelog_posts");
};

// ── O QUE CHEGA NO APP ────────────────────────────────────────────────────
//
// `status: active` e data até HOJE — o mesmo filtro do site, e pelo mesmo
// motivo: a data no futuro é agendamento, e um post agendado aparecendo no app
// antes da hora vaza o lançamento para o cliente antes do anúncio.
//
// A projeção é fechada à mão em vez de devolver o documento: o post tem campos
// que são do editor (etiquetas internas, quem escreveu) e não do cliente.
Novidade_model.prototype.publicadas = async function () {
  const col = await this.collection();

  return col
    .find(
      { status: "active", date: { $lte: new Date() } },
      {
        projection: {
          title: 1, html: 1, version: 1, date: 1,
          features: 1, improvements: 1, fixes: 1, deprecated: 1,
          docUrl: 1, videoUrl: 1,
          // Qual módulo esta notícia LANÇA, quando lança algum. É o campo que o
          // site ignora e que faz aparecer o botão aqui.
          modulo: 1,
        },
      }
    )
    .sort({ date: -1 })
    .limit(QUANTAS)
    .toArray();
};

module.exports = Novidade_model;

// ── QUANTAS SÃO NOVAS PARA ESTA PESSOA ────────────────────────────────────
//
// Rota própria e barata, no mesmo desenho do selo da ajuda (ver
// `BotaoDeAjuda.jsx` e `getSupportUnread`): o ícone do topo é desenhado em toda
// abertura, e mandar vinte notícias com corpo em HTML para pintar um pontinho
// seria pagar caro por pouco.
//
// Uma `countDocuments` com o mesmo filtro da lista, mais o corte da data.
Novidade_model.prototype.naoLidas = async function (vistasEm) {
  const col = await this.collection();

  const filtro = { status: "active", date: { $lte: new Date() } };

  // Sem marca, tudo é novo — é a primeira visita de quem nunca abriu a tela.
  // `$gt` e não `$gte`: a notícia que a pessoa acabou de ler tem data igual ou
  // anterior ao instante em que ela leu, e `$gte` a devolveria como nova para
  // sempre no caso de as duas coincidirem.
  if (vistasEm) {
    const d = new Date(vistasEm);
    if (!Number.isNaN(d.getTime())) filtro.date.$gt = d;
  }

  return col.countDocuments(filtro);
};
