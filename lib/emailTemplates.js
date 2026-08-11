const { translator } = require("./i18n");

// E-mail bodies.
//
// O idioma vem do DESTINATÁRIO, não de quem disparou: quem lê o e-mail é a
// pessoa que o recebe. Cada função recebe `lang` — o campo gravado na conta
// dela — e cai em pt-BR quando ela nunca escolheu um idioma.
//
// Inline styles only, and a table-free single-column layout: e-mail clients
// strip <style> blocks and support for modern CSS is unreliable.
const BRAND = "#16a34a";

function layout({ lang, title, body, buttonLabel, buttonUrl, footer, fallbackLabel }) {
  return `<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e2e8f0;">
    <div style="font-size:22px;font-weight:800;color:${BRAND};margin-bottom:24px;">GoFitNow</div>

    <h1 style="margin:0 0 12px;font-size:18px;color:#0f172a;">${title}</h1>

    <div style="font-size:14px;line-height:1.6;color:#475569;">${body}</div>

    ${
      buttonUrl
        ? `<div style="margin:28px 0;">
             <a href="${buttonUrl}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">${buttonLabel}</a>
           </div>
           <p style="font-size:12px;color:#94a3b8;line-height:1.5;margin:0 0 8px;">
             ${fallbackLabel}<br>
             <span style="color:#64748b;word-break:break-all;">${buttonUrl}</span>
           </p>`
        : ""
    }

    ${
      footer
        ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.5;">${footer}</p>`
        : ""
    }
  </div>
</body>
</html>`;
}

// Só o primeiro nome, como quem chama alguém. Sem nome nenhum, o cumprimento do
// idioma ("Olá", "Hello") entra no lugar — a frase é montada como "{nome}, ..."
// e não pode começar com vírgula.
function firstNameOf(name, t) {
  return String(name || "").split(" ")[0] || t("email.greeting");
}

// Um e-mail montado a partir de um bloco de chaves: os três têm exatamente a
// mesma forma (subject, title, body, button, footer, text), então a montagem é
// uma só e o que muda é o prefixo e as variáveis.
function build(bloco, lang, vars) {
  const t = translator(lang);
  const v = { ...vars, name: firstNameOf(vars.name, t) };
  const k = (nome) => t(`email.${bloco}.${nome}`, v);

  return {
    subject: k("subject"),
    html: layout({
      lang: t.lang,
      title: k("title"),
      body: k("body"),
      buttonLabel: k("button"),
      buttonUrl: vars.url,
      footer: k("footer"),
      fallbackLabel: t("email.fallbackLink"),
    }),
    text: k("text"),
  };
}

// Password reset. The link carries the token; the e-mail never carries a
// password.
function passwordReset({ lang, name, url, minutes }) {
  return build("reset", lang, { name, url, minutes });
}

// Sent when a trainer grants a student access to the app.
function studentInvite({ lang, name, trainerName, email, url }) {
  return build("invite", lang, { name, trainerName, email, url });
}

// A professional asking an existing account for permission to follow them.
// The person is the one who decides — this e-mail is the whole consent step,
// so it has to be plain about who is asking and what they will see.
function accessRequest({ lang, name, professionalName, professionalEmail, url, days }) {
  return build("request", lang, { name, professionalName, professionalEmail, url, days });
}

module.exports = { passwordReset, studentInvite, accessRequest };
