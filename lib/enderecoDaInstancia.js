const instanceContext = require("./instance.js");
const dominio = require("./domain.js");

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

// ── QUAL DOS ENDEREÇOS, QUANDO HÁ MAIS DE UM ──────────────────────────────
//
// Era o PRIMEIRO da lista, e isso quebrou no dia 13/09/2026, quando o domínio
// oficial virou `vafit.app`: o registro de todo cliente tinha sido escrito
// quando o oficial era `gofitnow.fit`, então o primeiro host de todos eles
// continua sendo o antigo. O link de recuperação de senha, o convite de
// anamnese, o retorno do checkout e o "voltar" do portal da Stripe passaram
// todos a mandar para a marca velha — e o portal foi onde apareceu, porque é o
// único que escreve o nome da marca do lado do botão.
//
// A ordem agora é por SIGNIFICADO, e não por posição:
//
//   1. o domínio PRÓPRIO do cliente, se ele tiver um. É a marca dele, e ela
//      ganha da nossa sempre — é para isso que ele paga o plano que a habilita.
//   2. o host sob o domínio oficial de HOJE (`BASE_DOMAIN`).
//   3. qualquer host registrado. Melhor um endereço velho que funciona do que
//      nenhum.
//   4. o montado a partir do nome, para quem ainda não tem host registrado.
//
// Trocar o oficial de novo passa a ser trocar uma variável, e não caçar os
// lugares que leem `hosts[0]`.
function melhorHost(hosts, instancia) {
  const lista = (hosts || []).map((h) => String(h || "").trim().toLowerCase()).filter(Boolean);

  const proprio = lista.find((h) => !dominio.isOwnDomain(h));
  if (proprio) return proprio;

  const oficial = lista.find((h) => h.endsWith("." + dominio.BASE_DOMAIN));
  if (oficial) return oficial;

  // Nenhum host sob o domínio de hoje, mas o cliente EXISTE e tem nome. O
  // endereço montado é melhor que o host antigo: o curinga atende os dois, e o
  // que a pessoa lê tem de ser a marca de agora.
  if (instancia) return dominio.hostOf(instancia);

  return lista[0] || null;
}

async function enderecoDaInstancia(app) {
  const instancia = instanceContext.required();

  try {
    const registro = await app.api.center.byInstance(instancia);
    const host = melhorHost(registro?.hosts, instancia);
    if (host) return `https://${host}`;
  } catch (erro) {
    // Central fora do ar não pode impedir a recuperação de senha: o endereço
    // montado pelo padrão abaixo funciona para todo cliente que não tem domínio
    // próprio, que é a esmagadora maioria.
    console.error("[endereco] não consegui ler o registro:", erro.message);
  }

  return `https://${instancia}.${dominio.BASE_DOMAIN}`;
}

module.exports = { enderecoDaInstancia, melhorHost };
