const limiteDoPlano = require("../lib/limiteDoPlano.js");
const dominio = require("../lib/domain.js");
const arquivos = require("../lib/arquivos.js");
const BrandImage = require("../model/BrandImage_model.js");
const instanceContext = require("../lib/instance.js");

// As imagens da marca: a logo e as fotos da tela de entrada.
//
// A LEITURA é pública, e tem de ser: a tela de entrada aparece antes de
// qualquer sessão. É a diferença que separa esta rota da foto de perfil.
//
// Sendo pública, o id é OPACO: um id sequencial deixaria alguém varrer os
// endereços e descobrir quantas imagens existem. O nome da instância está no
// caminho por necessidade — sem ele não há como saber qual banco abrir — e não
// revela nada que o host da tela de entrada já não diga.
// Vem de `lib/domain.js` desde 16/09/2026: estava cravado no domínio antigo
// aqui, e cada logo enviada nascia com uma URL de `gofitnow.fit` dentro do tema
// do cliente. Ver o comentário de `apiBaseUrl`.
const baseUrl = dominio.apiBaseUrl;

const logoDaCasa = require("../lib/logoDaCasa.js");

module.exports = function (app) {
  // A INSTÂNCIA está no caminho porque esta rota é aberta: ela chega sem
  // sessão e sem cabeçalho, e as imagens moram no banco de um cliente. Sem o
  // nome ali, não haveria como saber qual banco abrir.
  //
  // Não é vazamento: este endereço só aparece embutido na tela de entrada
  // daquele cliente, e o host dela já diz de quem é.
  // ── A NOSSA LOGO, a que se lê em PAPEL BRANCO ───────────────────────────
  //
  // *"ficaria igual o do financeiro, tem a logo padrão da empresa né"*.
  //
  // O extrato financeiro já sai com ela: quem monta aquele HTML é o servidor, e
  // `lib/logoDaCasa.js` resolve "a da casa, ou a nossa" antes de embutir. As
  // folhas montadas na TELA não tinham como chegar nela — e a do frontend
  // (`/logo.png`) não serve: ela é a arte de FUNDO ESCURO, com o corredor e o
  // "FIT" em branco, que some no papel.
  //
  // Esta rota entrega a MESMA arte que o documento usa: `assets/logo.png`, com a
  // chapa escura assada dentro do PNG. Assada, ela é conteúdo e não decoração —
  // imprime em qualquer navegador, com ou sem "gráficos de fundo" marcado.
  //
  // Aberta e sem instância: é a nossa marca, a mesma para todo mundo, e já sai
  // embutida em todo e-mail e PDF que este servidor gera.
  app.get("/public/logo.png", function (req, res) {
    const uri = logoDaCasa.nossaLogo();
    if (!uri) return res.status(404).end();

    const bytes = Buffer.from(uri.split(",")[1] || "", "base64");

    // Uma semana, e `immutable`: a arte muda com o deploy, e um deploy que a
    // troque troca o arquivo inteiro. Nenhum navegador precisa perguntar por
    // ela duas vezes na mesma semana.
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.send(bytes);
  });

  app.get("/public/brand/:instance/:id", async function (req, res) {
    const instance = instanceContext.normalize(req.params.instance);
    if (!instance) return res.status(404).end();

    const img = await instanceContext.run(instance, () =>
      app.api.brandImage.data(req.params.id)
    );
    // 404 seco: nem mensagem traduzida, que aqui não há quem leia.
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';

    // `public` porque é isto mesmo — a mesma imagem para todo mundo que abre o
    // endereço do profissional. O id nunca é reaproveitado (uma troca gera
    // outro documento), então o cache pode ser longo sem segurar imagem velha.
    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    // Os BYTES podem estar no R2 — ver lib/arquivos.js. Note que isto
    // acontece DEPOIS do 304: quando o navegador já tem a versão
    // cacheada, não há ida ao bucket nenhuma.
    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.send(bytes);
  });

  app.post("/me/brand/image", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    // Uma chave de API não sobe imagem de marca, pelo mesmo motivo de não
    // escolher domínio: é decisão de marca, e o dono está na tela.
    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const parsed = app.api.brandImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidBrandImage") });

    // ── O PLANO DECIDE SE PODE, E O PRODUTO DECIDE QUANTAS ────────────────
    //
    // Era um NÚMERO no plano: "imagens da marca, vazio usa o padrão do sistema,
    // 24". O Marlon apontou o problema em 30/08/2026 — ninguém escolhe um plano
    // por 24 imagens. A pergunta que se vende é "posso deixar com a minha
    // cara?", e ela é sim ou não.
    //
    // Então o plano responde só isso, e o TETO volta a ser do produto: 24, para
    // uma rota de upload aberta não virar um jeito de encher o banco por engano.
    // Quem tem a chave desligada ainda pode apontar para uma imagem hospedada
    // fora — o campo de endereço continua na tela.
    if (await limiteDoPlano.barrouChave(app, req, res, "appearance")) return;

    const teto = BrandImage.PADRAO_POR_CONTA;

    if ((await app.api.brandImage.count(user._id)) >= teto) {
      return res.status(409).send({
        msg: req.t("errors.tooManyBrandImages", { max: teto }),
        code: "too_many",
      });
    }

    const salvo = await app.api.brandImage.save(user._id, parsed.mime, parsed.buffer);

    app.insertUserActionHistory(req, user, "upload_brand_image", {
      category: "admin",
      local: { target_type: "brand_images", target_id: salvo.id },
      extra: { size: parsed.buffer.length, mime: parsed.mime },
    });

    // Devolve a URL pronta, e não o id: quem chamou vai gravá-la no tema, e o
    // tema guarda URL — inclusive de imagem hospedada fora daqui.
    res.send({ url: `${baseUrl()}/public/brand/${req.instance}/${salvo.id}` });
  });
};
