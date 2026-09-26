const { pdfDeHtml, pdfDisponivel } = require("./pdf.js");
const travaDeEnvio = require("./travaDeEnvio.js");
const notificacoes = require("./notificacoes.js");

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

    // ── E SE ELA NÃO QUISER RECEBER DOCUMENTO POR E-MAIL? ───────────────
    //
    // *"vários e-mails que vamos enviar vai verificar essas notificações"*.
    // Quem desligou "documentos" nas preferências não recebe — e quem mandou
    // fica sabendo, em vez de achar que mandou. O documento continua
    // disponível: ver na tela, baixar em PDF e imprimir não dependem disto.
    if (!notificacoes.querReceber(doc.pessoa, "documento")) {
      res.status(409).send({
        msg: req.t("errors.notificationOff"),
        code: "notification_off",
      });
      return;
    }

    // ── A TRAVA: o MESMO documento não sai duas vezes em cinco minutos ──
    //
    // A chave é o documento, e não a rota: dez profissionais mandando dez
    // documentos diferentes no mesmo minuto é uso normal; o mesmo documento dez
    // vezes é dedo nervoso ou abuso. Cada envio custa cota da Resend e, pior,
    // reputação do domínio — quem recebe o mesmo PDF vinte vezes marca como
    // spam, e isso estraga a entrega para todos os outros clientes.
    const trava = `doc:${base}:${req.params.id}`;
    const config = await travaDeEnvio.configuracao(app);
    const faltam = config.ligada ? await travaDeEnvio.faltamSegundos(trava, config.janela) : 0;

    if (faltam > 0) {
      res.status(429).send({
        msg: req.t("errors.emailTooSoon", { seconds: faltam }),
        code: "email_too_soon",
        retryAfter: faltam,
      });
      return;
    }

    // As FOTOS entram como anexo embutido: elas aparecem no corpo (pelo `cid`) e
    // na lista de anexos, que é exatamente o que foi pedido — "nos dois".
    const anexos = [...(doc.fotos || [])];

    if (pdfDisponivel()) {
      try {
        anexos.push({
          filename: nomeDeArquivo(prefixoDoArquivo, doc.nome, doc.data),
          // ── O PDF SAI DA VERSÃO `data:`, e isto é o conserto ─────────
          //
          // Gerá-lo a partir do corpo do e-mail deixava o anexo SEM FOTO
          // NENHUMA: aquele HTML usa `cid:`, e o Chromium não tem a mensagem
          // MIME para resolver — só a página.
          content: await pdfDeHtml(doc.html),
          contentType: "application/pdf",
        });
      } catch (error) {
        // PDF que não sai não pode impedir o e-mail: o corpo JÁ é o documento
        // inteiro. O anexo é conveniência; a mensagem é o conteúdo.
        console.error(`[documento:${base}] pdf do e-mail falhou:`, error.message);
      }
    }

    // MARCA ANTES de mandar, e não depois.
    //
    // Entre o `send` e o retorno há segundos de rede, e dois cliques rápidos
    // caberiam nesse vão — as duas chamadas achariam a trava livre e as duas
    // mandariam. Marcar antes fecha a janela; o custo é que uma falha de envio
    // também segura os cinco minutos, o que é o lado certo para errar.
    if (config.ligada) travaDeEnvio.marcarEnvio(trava);

    const enviado = await app.helpers.mailer.send({
      to: para,
      subject: `${req.t(chaveDoAssunto)} — ${doc.pessoa.name}`,
      // E o CORPO sai da versão `cid:`, pelo motivo inverso: o Gmail descarta
      // `data:`. Cada saída recebe a versão que ela sabe ler.
      html: doc.htmlDeEmail || doc.html,
      attachments: anexos,
    });

    app.insertUserActionHistory(req, doc.trainer, acao, {
      category: base,
      local: { target_type: base, target_id: req.params.id + "" },
      extra: { to: para, anexo: anexos.length > 0, fotos: (doc.fotos || []).length },
    });

    res.send({
      msg: req.t(chaveDeOk),
      anexo: anexos.length > 0,
      preview: enviado?.preview || null,
    });
  });
}

module.exports = { registrarRotasDeDocumento, nomeDeArquivo };
