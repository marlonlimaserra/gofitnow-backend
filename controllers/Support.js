const { ObjectId } = require("mongodb");
const arquivos = require("../lib/arquivos.js");

// A AJUDA, do lado de quem paga.
//
// "No app web coloque lá no cantinho um ícone que vá para uma página, que mostre
// umas perguntas frequentes e três opções de atendimento."
//
// As três: as próprias perguntas (resolver sozinho), abrir um chamado, e o
// WhatsApp. A ordem na tela é essa de propósito — a mais barata primeiro, para
// os dois lados.
//
// ── NADA AQUI IMPORTA DO PAINEL ───────────────────────────────────────────
//
// A tentação era reusar `Ticket_model` do center-backend, já que a collection é
// a mesma. São dois deploys com dois `package.json`, e um `require` atravessando
// projetos é um acoplamento que quebra no primeiro deploy de um só. O que se
// compartilha é o FORMATO do documento, e ele está escrito nos dois lados.
const MAX_ASSUNTO = 140;
const MAX_TEXTO = 8000;
const MAX_ANEXOS = 6;
const MAX_BYTES = 12 * 1024 * 1024;

// Imagem, áudio e PDF — o que a pessoa fotografa, grava ou exporta. Fechada de
// propósito: executável num campo de chamado não é caso de uso.
const MIMES = {
  "image/png": "imagem",
  "image/jpeg": "imagem",
  "image/webp": "imagem",
  "image/gif": "imagem",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/webm": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "application/pdf": "arquivo",
};

function texto(v, max) {
  return String(v ?? "").trim().slice(0, max);
}

function limparAnexos(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((a) => {
      const chave = String(a?.chave || "");
      if (!chave.startsWith("gofitnow/tickets/")) return null;
      return {
        chave,
        nome: texto(a.nome, 120),
        mime: texto(a.mime, 100),
        tamanho: Number(a.tamanho) || 0,
        tipo: ["imagem", "audio"].includes(a.tipo) ? a.tipo : "arquivo",
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ANEXOS);
}

module.exports = function (app) {
  // ── A TELA DE AJUDA, NUMA CHAMADA SÓ ────────────────────────────────────
  //
  // Perguntas, WhatsApp e a lista de chamados juntos. Quem abre a tela de ajuda
  // está com um problema; fazê-la pagar três latências para desenhar é somar um
  // problema.
  app.get("/me/support", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const [faq, whatsapp, tickets] = await Promise.all([
      app.api.support.faq(),
      app.api.support.whatsapp(),
      app.api.support.meus(req.instance),
    ]);

    res.send({ faq, whatsapp, tickets });
  });

  // Só o número de não lidos — é o selinho do ícone, pedido em toda abertura.
  // Separado da tela inteira porque a tela é rara e o selinho é constante.
  app.get("/me/support/unread", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({ unread: await app.api.support.naoLidos(req.instance) });
  });

  app.get("/me/tickets/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const doc = await app.api.support.data(req.instance, req.params.id);
    if (!doc) return res.status(404).send({ msg: req.t("errors.ticketNotFound") });

    // Abrir marca como lido, e só o lado do cliente.
    await app.api.support.marcarLido(req.instance, req.params.id);

    res.send(doc);
  });

  // ── ABRIR UM CHAMADO ────────────────────────────────────────────────────
  app.post("/me/tickets", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const assunto = texto(req.body?.assunto, MAX_ASSUNTO);
    const corpo = texto(req.body?.texto, MAX_TEXTO);
    const anexos = limparAnexos(req.body?.anexos);

    if (!assunto) return res.status(400).send({ msg: req.t("errors.ticketNoSubject") });
    if (!corpo && !anexos.length) return res.status(400).send({ msg: req.t("errors.ticketNoMessage") });

    const tickets = await app.api.support.tickets();
    const agora = new Date();

    // O número é por cliente e sequencial: "o chamado 3" é uma frase que
    // funciona; um ObjectId não é.
    const numero = (await tickets.countDocuments({ instance: req.instance })) + 1;

    const autor = { id: String(user._id), nome: user.name || "", email: user.email || "" };

    const r = await tickets.insertOne({
      instance: req.instance,
      numero,
      assunto,
      status: "aberto",
      autor,
      criadoEm: agora,
      atualizadoEm: agora,
      ultimaMensagemEm: agora,
      novoParaSuporte: true,
      novoParaCliente: false,
    });

    const msgs = await app.api.support.mensagens();
    await msgs.insertOne({
      ticket: r.insertedId,
      instance: req.instance,
      de: "cliente",
      autor,
      texto: corpo,
      anexos,
      criadoEm: agora,
    });

    app.insertUserActionHistory(req, user, "open_ticket", {
      category: "admin",
      local: { target_type: "tickets", target_id: String(r.insertedId) },
      extra: { assunto, numero },
    });

    res.status(201).send(await app.api.support.data(req.instance, String(r.insertedId)));
  });

  // ── RESPONDER ───────────────────────────────────────────────────────────
  app.post("/me/tickets/:id/messages", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const corpo = texto(req.body?.texto, MAX_TEXTO);
    const anexos = limparAnexos(req.body?.anexos);
    if (!corpo && !anexos.length) return res.status(400).send({ msg: req.t("errors.ticketNoMessage") });

    // A instância no filtro: um id de outro cliente não abre nem recebe resposta.
    const doc = await app.api.support.data(req.instance, req.params.id);
    if (!doc) return res.status(404).send({ msg: req.t("errors.ticketNotFound") });

    const agora = new Date();
    const msgs = await app.api.support.mensagens();

    await msgs.insertOne({
      ticket: doc._id,
      instance: req.instance,
      de: "cliente",
      autor: { id: String(user._id), nome: user.name || "" },
      texto: corpo,
      anexos,
      criadoEm: agora,
    });

    const tickets = await app.api.support.tickets();
    await tickets.updateOne(
      { _id: doc._id, instance: req.instance },
      {
        $set: {
          // Escrever num chamado fechado REABRE: quem volta a escrever está
          // dizendo que não estava resolvido.
          status: "aberto",
          atualizadoEm: agora,
          ultimaMensagemEm: agora,
          novoParaSuporte: true,
          novoParaCliente: false,
        },
      }
    );

    res.send(await app.api.support.data(req.instance, req.params.id));
  });

  // ── OS ANEXOS ───────────────────────────────────────────────────────────
  //
  // Sobem antes da mensagem e devolvem a chave. Dois passos e não um: uma
  // mensagem com três anexos seria um corpo de vários megabytes, e o primeiro
  // erro de rede jogaria fora o texto junto com os arquivos.
  app.post("/me/tickets/anexo", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const casa = /^data:([^;,]+);base64,(.+)$/s.exec(String(req.body?.arquivo || ""));
    if (!casa) return res.status(400).send({ msg: req.t("errors.invalidFile") });

    // O mime vem do CABEÇALHO do data URI e é conferido antes de qualquer coisa:
    // confiar no nome do arquivo deixaria um `.png` que é outra coisa entrar.
    const mime = casa[1].toLowerCase().split(";")[0];
    const tipo = MIMES[mime];
    if (!tipo) return res.status(400).send({ msg: req.t("errors.ticketFileType") });

    const bytes = Buffer.from(casa[2], "base64");
    if (!bytes.length) return res.status(400).send({ msg: req.t("errors.invalidFile") });
    if (bytes.length > MAX_BYTES) return res.status(400).send({ msg: req.t("errors.ticketFileTooBig") });

    // Nome SORTEADO no bucket: dois clientes mandando `foto.png` não podem
    // disputar a mesma chave. O nome original fica no documento, para mostrar.
    const id = require("crypto").randomUUID().replace(/-/g, "");
    const chave = arquivos.chaveNossa("tickets", id);

    const gravou = await arquivos.guardar(chave, bytes, mime);
    if (!gravou) return res.status(502).send({ msg: req.t("errors.ticketUploadFailed") });

    res.send({
      chave,
      id,
      nome: texto(req.body?.nome, 120),
      mime,
      tipo,
      tamanho: bytes.length,
    });
  });

  // Servir um anexo. PASSA PELA SESSÃO e confere que o anexo é de um chamado
  // DESTE cliente — a chave é sorteada, mas "difícil de adivinhar" não é
  // controle de acesso.
  app.get("/me/tickets/anexo/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const id = String(req.params.id || "");
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();

    const chave = arquivos.chaveNossa("tickets", id);

    const msgs = await app.api.support.mensagens();
    const dono = await msgs.findOne({ instance: req.instance, "anexos.chave": chave });
    if (!dono) return res.status(404).end();

    const achado = await arquivos.ler(chave);
    if (!achado) return res.status(404).end();

    res.setHeader("Content-Type", achado.mime || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(achado.bytes);
  });
};
