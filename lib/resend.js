// MANDAR UM E-MAIL PELA RESEND.
//
// ── Por que `fetch` cru e não o SDK oficial ───────────────────────────────
//
// O SDK da Resend é uma casca fina sobre um `POST` só. Trazê-lo custaria uma
// dependência a mais no VPS, e — o que pesa mais — um lugar a mais onde uma
// atualização pode mudar comportamento de envio de e-mail sem ninguém pedir.
// O Node 24 tem `fetch` embutido; a API cabe nesta função.
//
// ── O que este módulo NÃO faz ─────────────────────────────────────────────
//
// Não decide se deve usar a Resend, não lê configuração e não tem estado. Quem
// escolhe o caminho é o `Mailer`. Aqui é só "traduza isto para a API deles e
// diga o que aconteceu" — e é por isso que dá para testar sem rede e sem banco.

const ENDERECO = "https://api.resend.com/emails";
const TEMPO_LIMITE_MS = 15 * 1000;

// O remetente no formato que a API espera. `Nome <endereco>` quando há nome,
// só o endereço quando não há — mandar `<endereco>` com nome vazio é recusado.
function remetente(de, nome) {
  const endereco = String(de || "").trim();
  const rotulo = String(nome || "").trim();
  if (!endereco) return "";
  return rotulo ? `${rotulo} <${endereco}>` : endereco;
}

// Os anexos vão em base64. O nosso PDF já chega como Buffer (é o que o
// `pdfDeHtml` devolve), e o nodemailer aceitava o Buffer direto — a conversão
// existe porque a API da Resend é JSON, e JSON não carrega byte cru.
//
// ── O `cid` é o que faz a imagem APARECER NO CORPO ────────────────────────
//
// O Gmail descarta `<img src="data:…">`. O caminho que funciona é o anexo
// embutido: a foto viaja como anexo com um `Content-ID`, e o corpo a referencia
// por `cid:`. A Resend chama esse campo de `content_id`; o nodemailer chama de
// `cid`. Aqui o nome interno é `cid`, e cada caminho traduz o seu.
//
// Anexo com `content_id` cumpre os dois papéis de uma vez: ele aparece no corpo E
// na lista de anexos.
function anexos(lista) {
  return (lista || []).map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : String(a.content || ""),
    ...(a.cid ? { content_id: a.cid } : {}),
    ...(a.contentType ? { content_type: a.contentType } : {}),
  }));
}

async function enviarPelaResend({ apiKey, from, fromName, to, subject, html, text, attachments }, buscar = fetch) {
  const de = remetente(from, fromName);
  if (!de) throw new Error("remetente não configurado");

  // Um envio que trava seguraria a resposta da rota até o cliente desistir, e a
  // pessoa clicaria em enviar de novo — dois e-mails para quem recebe.
  const desistir = AbortSignal.timeout(TEMPO_LIMITE_MS);

  const resposta = await buscar(ENDERECO, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: de,
      to: Array.isArray(to) ? to : [to],
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(attachments?.length ? { attachments: anexos(attachments) } : {}),
    }),
    signal: desistir,
  });

  const corpo = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    // ── A MENSAGEM DELES, e não um "falhou ao enviar" ───────────────────
    //
    // O erro mais comum aqui é domínio não verificado, e a resposta diz isso com
    // todas as letras. Trocar por um texto genérico obrigaria a abrir log de
    // servidor para descobrir algo que a própria API já explicou.
    const motivo = corpo?.message || corpo?.name || `HTTP ${resposta.status}`;
    const erro = new Error(`resend: ${motivo}`);
    erro.status = resposta.status;
    throw erro;
  }

  return { messageId: corpo?.id || null, preview: null };
}

module.exports = { enviarPelaResend, remetente };
