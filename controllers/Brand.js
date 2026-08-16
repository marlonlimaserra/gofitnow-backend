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
function baseUrl() {
  return process.env.PUBLIC_API_URL || "https://backend.gofitnow.fit";
}

module.exports = function (app) {
  // A INSTÂNCIA está no caminho porque esta rota é aberta: ela chega sem
  // sessão e sem cabeçalho, e as imagens moram no banco de um cliente. Sem o
  // nome ali, não haveria como saber qual banco abrir.
  //
  // Não é vazamento: este endereço só aparece embutido na tela de entrada
  // daquele cliente, e o host dela já diz de quem é.
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

    res.send(img.data.buffer ? Buffer.from(img.data.buffer) : img.data);
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

    // O TETO SAI DO PLANO, que mora no central.
    //
    // Um número no plano manda, inclusive o zero: "este plano não inclui imagem
    // de marca" é uma venda legítima, e quem a assina ainda pode apontar para
    // uma imagem hospedada fora — o campo de endereço continua na tela.
    //
    // Sem plano, ou com o limite em branco, vale o padrão do produto. É de
    // propósito que "ilimitado" no painel não vire "sem teto nenhum" aqui: o
    // tema usa oito imagens, e uma rota de upload aberta é como se enche um
    // banco por engano.
    const limites = await app.api.center.limitsFor(req.instance);
    const doPlano = limites ? limites.brandImages : null;
    const teto =
      Number.isInteger(doPlano) && doPlano >= 0 ? doPlano : BrandImage.PADRAO_POR_CONTA;

    if (teto === 0) {
      // Mensagem própria, e não a do teto: "você já tem 0 imagens guardadas,
      // salve a aparência para liberar" mandaria fazer uma faxina que não
      // liberaria nada.
      return res.status(409).send({
        msg: req.t("errors.brandImagesNotInPlan"),
        code: "not_in_plan",
      });
    }

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
