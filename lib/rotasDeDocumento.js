const { pdfDeHtml, pdfDisponivel } = require("./pdf.js");

// AS TRÊS ROTAS DE UM DOCUMENTO — ver, baixar em PDF, mandar por e-mail.
//
// ── Por que uma fábrica, e não duas cópias ────────────────────────────────
//
// A avaliação física e o plano alimentar precisam exatamente das mesmas três
// rotas, com as mesmas travas e os mesmos cuidados. Escritas duas vezes, uma
// delas receberia sozinha a próxima correção — e a que ficasse para trás seria a
// que continua mandando e-mail com uma regra antiga de destinatário.
//
// O que muda entre os dois é só o que este módulo recebe: como carregar, qual
// permissão exigir e como o arquivo se chama.
//
// ── AS QUATRO SAÍDAS, UM HTML SÓ ──────────────────────────────────────────
//
// Ver e imprimir usam o HTML direto — não custam Chromium nenhum. Baixar e o
// anexo do e-mail convertem ESSE MESMO HTML. É o pedido do Marlon: *"a pessoa
// clica ver PDF, aí mostra o html pronto, aí se ela clicar baixar PDF aí o
// servidor gera o PDF com esse html"*.

// O nome do arquivo viaja por WhatsApp, e-mail e pen drive — e cada um reescreve
// o que não entende. Sem acento, sem espaço, e a data em AAAA-MM-DD, que ordena
// sozinha na pasta de quem recebe.
function nomeDeArquivo(prefixo, nome, data) {
  const limpo = String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

  let dia = "";
  if (data) {
    const d = new Date(data);
    if (!Number.isNaN(d.getTime())) dia = d.toISOString().slice(0, 10);
  }

  return [prefixo, limpo, dia].filter(Boolean).join("-") + ".pdf";
}

// `montar(req, res)` devolve `{ trainer, pessoa, html, nome, data }` ou `null`
// quando já respondeu (sem permissão, não encontrado). É onde cada assunto
// resolve o que é seu.
function registrarRotasDeDocumento(app, { base, prefixoDoArquivo, chaveDoAssunto, chaveDeOk, acao, montar }) {
  // VER: devolve o HTML pronto. O navegador mostra e imprime; o app entrega ao
  // `expo-print`, que faz o PDF no próprio aparelho. Nenhum dos dois toca no
  // Chromium do servidor.
  app.get(`/${base}/:id/documento`, async function (req, res) {
    const doc = await montar(req, res);
    if (!doc) return;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // `private, no-store`: é o documento de saúde de um cliente. Proxy
    // compartilhado não pode guardar isto e servir para outra pessoa.
    res.setHeader("Cache-Control", "private, no-store");
    res.send(doc.html);
  });

  // BAIXAR: o servidor converte o MESMO HTML em PDF.
  //
  // Só este caminho paga o Chromium, e de propósito: ver é o caso comum e não
  // deve custar 300 MB de memória; baixar é o caso em que se quer o arquivo.
  app.get(`/${base}/:id/documento.pdf`, async function (req, res) {
    if (!pdfDisponivel()) {
      res.status(503).send({ msg: req.t("errors.pdfUnavailable") });
      return;
    }

    const doc = await montar(req, res);
    if (!doc) return;

    try {
      const pdf = await pdfDeHtml(doc.html);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${nomeDeArquivo(prefixoDoArquivo, doc.nome, doc.data)}"`
      );
      res.send(pdf);
    } catch (error) {
      console.error(`[documento:${base}] pdf falhou:`, error.message);
      res.status(500).send({ msg: req.t("errors.pdfFailed") });
    }
  });

  // ENVIAR POR E-MAIL: o corpo é o mesmo HTML, e o PDF vai anexo quando dá.
  app.post(`/${base}/:id/email`, async function (req, res) {
    const doc = await montar(req, res);
    if (!doc) return;

    // ── O DESTINATÁRIO VEM DO BANCO, NUNCA DO CORPO DO PEDIDO ───────────
    //
    // Aceitar um `to` do cliente transformaria esta rota numa máquina de mandar
    // e-mail com o nosso domínio, com o nosso remetente, para qualquer endereço
    // — e autenticada, então com toda a reputação do domínio junto. O destino é
    // o e-mail da PESSOA dona do documento, resolvido aqui.
    const para = doc.pessoa?.email;
    if (!para) {
      res.status(400).send({ msg: req.t("errors.studentWithoutEmail") });
      return;
    }

    const anexos = [];
    if (pdfDisponivel()) {
      try {
        anexos.push({
          filename: nomeDeArquivo(prefixoDoArquivo, doc.nome, doc.data),
          content: await pdfDeHtml(doc.html),
          contentType: "application/pdf",
        });
      } catch (error) {
        // PDF que não sai não pode impedir o e-mail: o corpo JÁ é o documento
        // inteiro. O anexo é conveniência; a mensagem é o conteúdo.
        console.error(`[documento:${base}] pdf do e-mail falhou:`, error.message);
      }
    }

    const enviado = await app.helpers.mailer.send({
      to: para,
      subject: `${req.t(chaveDoAssunto)} — ${doc.pessoa.name}`,
      html: doc.html,
      attachments: anexos,
    });

    app.insertUserActionHistory(req, doc.trainer, acao, {
      category: base,
      local: { target_type: base, target_id: req.params.id + "" },
      extra: { to: para, anexo: anexos.length > 0 },
    });

    res.send({
      msg: req.t(chaveDeOk),
      anexo: anexos.length > 0,
      preview: enviado?.preview || null,
    });
  });
}

module.exports = { registrarRotasDeDocumento, nomeDeArquivo };
