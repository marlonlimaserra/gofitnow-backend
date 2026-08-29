const { translator } = require("./i18n");

// E-mail bodies.
//
// O idioma vem do DESTINATÁRIO, não de quem disparou: quem lê o e-mail é a
// pessoa que o recebe. Cada função recebe `lang` — o campo gravado na conta
// dela — e cai em pt-BR quando ela nunca escolheu um idioma.
//
// Inline styles only, and a table-free single-column layout: e-mail clients
// strip <style> blocks and support for modern CSS is unreliable.
// ── A MARCA DA CASA, e não uma cor cravada ───────────────────────────────
//
// O e-mail era lima sobre grafite: as cores do ShapeApp, que a marca foi por um
// dia em 24/08/2026. Ficaram aqui depois que ela voltou — e-mail não tem
// variável de CSS, então cada cor precisa ser escrita, e escrever é esquecer.
//
// Agora ele recebe a marca de QUEM ENVIA. Cada casa tem a sua (é o produto
// inteiro: o cliente escolhe cor e logo), e um e-mail que chega com a cor de
// outra pessoa denuncia que o sistema é alugado.
//
// `scale(brand)` é a MESMA função que pinta o botão do produto e o do site — o
// botão do e-mail e o botão da tela são o mesmo pixel, sem ninguém combinar.
const theme = require("./theme.js");

// A logo padrão, para a casa que não subiu a dela.
//
// URL pública e absoluta, e não `data:` URI: cliente de e-mail bloqueia imagem
// embutida com mais frequência do que imagem hospedada, e um `data:` de 260 kB
// engorda toda mensagem. O endereço é o do site, servido pela Cloudflare.
const LOGO_PADRAO = "https://gofitnow.fit/logo.png";

// A altura do wordmark no e-mail. Em pontos e no atributo `height`, não só no
// CSS: o Outlook ignora `style` em `<img>` e desenha a imagem no tamanho
// original — 1214 px de largura estourando a caixa.
const ALTURA_LOGO = 34;

function marca(tema) {
  const t = theme.sanitize(tema);
  const escala = theme.scale(t.brand);

  return {
    // 600 no botão e 700 no texto: a mesma dupla que o produto usa. O 600 tem
    // contraste suficiente com o branco do texto do botão em qualquer marca que
    // a paleta gere.
    botao: escala[600] || t.brand,
    texto: escala[700] || t.brand,
    logo: t.logo || LOGO_PADRAO,
  };
}

function layout({ lang, title, body, buttonLabel, buttonUrl, footer, fallbackLabel, tema }) {
  const m = marca(tema);

  return `<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:0;background:#f1f5f9;">
  <!-- TABELA, e não div com flex: Outlook não implementa nem flex nem grid, e a
       mensagem sairia com tudo empilhado à esquerda. -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;">

          <!-- A FAIXA da marca. É ela que faz o e-mail ser reconhecido antes de
               ser lido — e é o que faltava: a versão anterior abria com o nome
               em texto, que é indistinguível de qualquer remetente. -->
          <tr>
            <td align="center" style="background:${m.botao};padding:22px 24px;">
              <img src="${m.logo}" alt="" height="${ALTURA_LOGO}" style="height:${ALTURA_LOGO}px;width:auto;display:block;border:0;" />
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 12px;font-size:19px;line-height:1.35;color:#0f172a;font-weight:700;">${title}</h1>

              <div style="font-size:15px;line-height:1.65;color:#475569;">${body}</div>

              ${
                buttonUrl
                  ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0;">
                       <tr>
                         <td align="center" style="border-radius:10px;background:${m.botao};">
                           <a href="${buttonUrl}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">${buttonLabel}</a>
                         </td>
                       </tr>
                     </table>
                     <p style="font-size:12px;color:#94a3b8;line-height:1.55;margin:0;">
                       ${fallbackLabel}<br>
                       <a href="${buttonUrl}" style="color:${m.texto};word-break:break-all;">${buttonUrl}</a>
                     </p>`
                  : ""
              }

              ${
                footer
                  ? `<p style="margin:26px 0 0;padding-top:18px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.55;">${footer}</p>`
                  : ""
              }
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
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
function build(bloco, lang, vars, tema) {
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
      tema,
    }),
    text: k("text"),
  };
}

// Password reset. The link carries the token; the e-mail never carries a
// password.
function passwordReset({ lang, name, url, minutes, tema }) {
  return build("reset", lang, { name, url, minutes }, tema);
}

// O convite para a pessoa responder a própria anamnese.
//
// Leva o NOME DO PROFISSIONAL no corpo, e isso não é cortesia: um e-mail pedindo
// histórico de saúde tem de dizer quem está pedindo, senão é indistinguível de
// golpe — e a pessoa certa é justamente a que não vai clicar.
function anamnesisInvite({ lang, name, professional, url, days, tema }) {
  return build("anamnesis", lang, { name, professional, url, days }, tema);
}

// Sent when a trainer grants a student access to the app.
module.exports = { passwordReset, anamnesisInvite };
