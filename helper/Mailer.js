const nodemailer = require("nodemailer");
const { enviarPelaResend } = require("../lib/resend.js");

// A SAÍDA DE E-MAIL — três caminhos, nesta ordem.
//
//   1. RESEND, se a central tiver isso ligado e com chave. É o caminho de
//      produção, e é configurado por TELA (painel › Configuração › E-mail).
//   2. SMTP do `.env` (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM).
//   3. ETHEREAL, quando não há nem um nem outro: o nodemailer cria uma caixa
//      descartável, a mensagem chega de verdade lá e o log imprime o endereço
//      para lê-la. Nada alcança o mundo real — é assim que o fluxo se
//      desenvolve e se testa sem credencial nenhuma.
//
// ── Por que a Resend vem de tela e o SMTP de arquivo ─────────────────────
//
// Trocar credencial no `.env` é entrar no VPS, editar e reiniciar o processo. No
// intervalo, e-mail nenhum sai — inclusive o de recuperação de senha, que é
// exatamente o que alguém trancado do lado de fora precisa. A chave da Resend
// mora na central, na mesma collection `settings` que as chaves de entrada
// social, e a troca vale no próximo envio.
//
// O SMTP continua existindo, e não por nostalgia: é o que segura o envio se a
// conta da Resend for suspensa ou a central estiver fora do ar.
function Mailer(app) {
  this.app = app;
  this.transport = null;
  this.testMode = !process.env.SMTP_HOST;
}

Mailer.prototype.getTransport = async function () {
  if (this.transport) return this.transport;

  if (this.testMode) {
    const account = await nodemailer.createTestAccount();
    this.transport = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    console.log("[mailer] no SMTP_HOST — using Ethereal test inbox");
    return this.transport;
  }

  const port = Number(process.env.SMTP_PORT) || 587;

  this.transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    // 465 is implicit TLS; 587 starts plain and upgrades via STARTTLS.
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  return this.transport;
};

// A CONFIGURAÇÃO DA CENTRAL.
//
// Mesma collection que o OAuth lê (`settings`, do banco da central) e mesmo
// contrato: só leitura, e central fora do ar não pode derrubar o envio — cai
// para o SMTP, que é justamente o caminho que não depende dela.
//
// Sem cache, como no OAuth: uma consulta a mais por e-mail enviado é barata
// perto de "troquei a chave e continua saindo pela antiga".
Mailer.prototype.configuracaoDaCentral = async function () {
  const nomes = ["email.enabled", "email.resendApiKey", "email.from", "email.fromName"];

  try {
    const db = await this.app.mongodb.centralDb();
    const docs = await db.collection("settings").find({ key: { $in: nomes } }).toArray();
    const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));

    const apiKey = String(v["email.resendApiKey"] || "").trim();
    const from = String(v["email.from"] || "").trim();

    return {
      // Ligado só com o conjunto COMPLETO. Ligado sem chave, ou sem remetente,
      // faria toda mensagem morrer num erro da API — e o SMTP, que talvez
      // funcionasse, nem seria tentado.
      usarResend: Boolean(v["email.enabled"]) && Boolean(apiKey) && Boolean(from),
      apiKey,
      from,
      fromName: String(v["email.fromName"] || "").trim(),
    };
  } catch (erro) {
    console.error("[mailer] não consegui ler a configuração da central:", erro.message);
    return { usarResend: false };
  }
};

// Base URL of the frontend, used to build links inside the e-mails.
Mailer.prototype.appUrl = function () {
  return (process.env.APP_URL || "https://app.gofitnow.fit").replace(/\/+$/, "");
};

// `attachments` é `[{ filename, content, contentType }]`, com `content` em
// Buffer. Os dois caminhos o aceitam: o nodemailer usa o Buffer direto, e o de
// Resend converte para base64 (JSON não carrega byte cru).
//
// Entrou para a avaliação física e o plano alimentar irem por e-mail com o PDF
// junto. O PDF é gerado no SERVIDOR, a partir do mesmo HTML que vira o corpo da
// mensagem (ver `lib/pdf.js` e `lib/documentoAvaliacao.js`) — foi o pedido do
// Marlon, para a folha ser idêntica no site e no app.
Mailer.prototype.send = async function ({ to, subject, html, text, attachments }) {
  // ── A RESEND PRIMEIRO, e o SMTP como rede de segurança ────────────────
  //
  // Uma falha aqui NÃO derruba o envio: cai para o SMTP. É o caso de conta
  // suspensa ou domínio que deixou de estar verificado — situações em que o
  // segundo caminho ainda funciona, e desistir na primeira seria perder e-mail
  // que tinha como sair.
  const config = await this.configuracaoDaCentral();

  if (config.usarResend) {
    try {
      return await enviarPelaResend({ ...config, to, subject, html, text, attachments });
    } catch (erro) {
      console.error("[mailer] resend falhou, tentando SMTP:", erro.message);
    }
  }

  const transport = await this.getTransport();

  const from =
    process.env.SMTP_FROM ||
    (process.env.SMTP_USER ? `GoFitNow <${process.env.SMTP_USER}>` : "GoFitNow <nao-responda@gofitnow.fit>");

  const info = await transport.sendMail({
    from,
    to,
    subject,
    html,
    text,
    ...(attachments?.length ? { attachments } : {}),
  });

  // In test mode the preview URL is the only way to read what was sent.
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log("[mailer] preview: " + preview);

  return { messageId: info.messageId, preview: preview || null };
};

module.exports = Mailer;
