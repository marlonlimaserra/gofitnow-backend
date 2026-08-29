const instanceContext = require("./instance.js");
const { BASE_DOMAIN } = require("./domain.js");

// O ENDEREÇO PÚBLICO DA CASA que fez o pedido.
//
// ── O defeito que isto conserta ───────────────────────────────────────────
//
// A recuperação de senha montava o link com `APP_URL` — um endereço FIXO,
// `app.gofitnow.fit`. Quem pedia a senha em `marlon.gofitnow.fit` recebia um
// e-mail levando para outro lugar: o portal, que não é a casa dele. Relato do
// Marlon: *"que vá para o domínio onde eu solicitei, pois está indo para
// app.gofitnow.fit"*.
//
// O convite de anamnese já fazia certo, e a conta é esta: o registro CENTRAL
// sabe os endereços de cada instância, e o primeiro deles é o oficial — é o que
// cobre o cliente com domínio próprio, que não é `<nome>.gofitnow.fit`.
//
// ── Por que não usar o cabeçalho que o navegador mandou ───────────────────
//
// `X-Instance-Host` vem do cliente, e um link de e-mail é a última coisa que se
// quer montar com dado de cliente: quem conseguisse forjar o cabeçalho faria a
// recuperação de senha apontar para um domínio dele. O nome da instância JÁ foi
// conferido contra o registro pelo portão (`lib/instanceGate.js`); daqui em
// diante o endereço sai do registro, não do pedido.
async function enderecoDaInstancia(app) {
  const instancia = instanceContext.required();

  try {
    const registro = await app.api.center.byInstance(instancia);
    const host = (registro?.hosts || [])[0];
    if (host) return `https://${host}`;
  } catch (erro) {
    // Central fora do ar não pode impedir a recuperação de senha: o endereço
    // montado pelo padrão abaixo funciona para todo cliente que não tem domínio
    // próprio, que é a esmagadora maioria.
    console.error("[endereco] não consegui ler o registro:", erro.message);
  }

  return `https://${instancia}.${BASE_DOMAIN}`;
}

module.exports = { enderecoDaInstancia };
