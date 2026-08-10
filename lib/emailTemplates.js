// E-mail bodies. The text the user reads is Portuguese; the code around it is
// English, same convention as the rest of the project.
//
// Inline styles only, and a table-free single-column layout: e-mail clients
// strip <style> blocks and support for modern CSS is unreliable.
const BRAND = "#16a34a";

function layout({ title, body, buttonLabel, buttonUrl, footer }) {
  return `<!doctype html>
<html lang="pt-BR">
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
             Se o botão não funcionar, copie e cole este endereço no navegador:<br>
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

// Password reset. The link carries the token; the e-mail never carries a
// password.
function passwordReset({ name, url, minutes }) {
  const firstName = String(name || "").split(" ")[0] || "Olá";

  return {
    subject: "Redefinir sua senha do GoFitNow",
    html: layout({
      title: `${firstName}, vamos redefinir sua senha`,
      body: `Você pediu para redefinir a senha da sua conta no GoFitNow.
             Clique no botão abaixo para escolher uma nova. O link vale por
             <strong>${minutes} minutos</strong> e só pode ser usado uma vez.`,
      buttonLabel: "Criar nova senha",
      buttonUrl: url,
      footer: `Se não foi você que pediu, ignore este e-mail — sua senha
               continua a mesma e ninguém teve acesso à sua conta.`,
    }),
    text: `${firstName}, você pediu para redefinir a senha do GoFitNow.

Abra este endereço para escolher uma nova senha (vale por ${minutes} minutos e só pode ser usado uma vez):
${url}

Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.`,
  };
}

// Sent when a trainer grants a student access to the app.
function studentInvite({ name, trainerName, email, url }) {
  const firstName = String(name || "").split(" ")[0] || "Olá";

  return {
    subject: "Seu acesso ao GoFitNow está pronto",
    html: layout({
      title: `${firstName}, seu acesso está liberado`,
      body: `<strong>${trainerName}</strong> liberou seu acesso ao GoFitNow.
             Lá você acompanha seus treinos e sua ficha.<br><br>
             Entre com o e-mail <strong>${email}</strong> e a senha que
             ${trainerName} combinou com você.`,
      buttonLabel: "Acessar o GoFitNow",
      buttonUrl: url,
      footer: `Não sabe sua senha? Use a opção "Esqueci minha senha" na tela de
               login, ou fale com o seu personal.`,
    }),
    text: `${firstName}, ${trainerName} liberou seu acesso ao GoFitNow.

Entre em ${url} com o e-mail ${email} e a senha combinada com ${trainerName}.

Não sabe a senha? Use "Esqueci minha senha" na tela de login.`,
  };
}

// A professional asking an existing account for permission to follow them.
// The person is the one who decides — this e-mail is the whole consent step,
// so it has to be plain about who is asking and what they will see.
function accessRequest({ name, professionalName, professionalEmail, url, days }) {
  const firstName = String(name || "").split(" ")[0] || "Olá";

  return {
    subject: `${professionalName} quer acompanhar você no GoFitNow`,
    html: layout({
      title: `${firstName}, ${professionalName} pediu acesso ao seu histórico`,
      body: `<strong>${professionalName}</strong> (${professionalEmail}) quer
             acompanhar você no GoFitNow.<br><br>
             Se você liberar, essa pessoa passa a ver o seu histórico e a montar
             planos junto com os outros profissionais que já cuidam de você.
             Você pode tirar esse acesso quando quiser.<br><br>
             O link vale por <strong>${days} dias</strong>.`,
      buttonLabel: "Ver e responder o pedido",
      buttonUrl: url,
      footer: `Não conhece quem está pedindo? É só ignorar este e-mail — sem a
               sua confirmação ninguém vê nada.`,
    }),
    text: `${firstName}, ${professionalName} (${professionalEmail}) quer acompanhar você no GoFitNow.

Se liberar, essa pessoa passa a ver o seu histórico. Você pode tirar o acesso quando quiser.

Abra este endereço para responder (vale por ${days} dias):
${url}

Não conhece quem está pedindo? Ignore este e-mail — sem a sua confirmação ninguém vê nada.`,
  };
}

module.exports = { passwordReset, studentInvite, accessRequest };
