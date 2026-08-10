const nodemailer = require("nodemailer");

// Outgoing e-mail. Everything comes from the environment, so switching
// provider (Gmail → Resend → SES) means changing four variables, never code:
//
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL
//
// With SMTP_HOST unset it falls back to Ethereal: nodemailer creates a
// throwaway test inbox on the fly, the message is really delivered there and
// the log prints a URL to read it. Nothing reaches the real world — that is
// how the flow is developed and tested without any credential.
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

// Base URL of the frontend, used to build links inside the e-mails.
Mailer.prototype.appUrl = function () {
  return (process.env.APP_URL || "https://app.gofitnow.fit").replace(/\/+$/, "");
};

Mailer.prototype.send = async function ({ to, subject, html, text }) {
  const transport = await this.getTransport();

  const from =
    process.env.SMTP_FROM ||
    (process.env.SMTP_USER ? `GoFitNow <${process.env.SMTP_USER}>` : "GoFitNow <nao-responda@gofitnow.fit>");

  const info = await transport.sendMail({ from, to, subject, html, text });

  // In test mode the preview URL is the only way to read what was sent.
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log("[mailer] preview: " + preview);

  return { messageId: info.messageId, preview: preview || null };
};

module.exports = Mailer;
