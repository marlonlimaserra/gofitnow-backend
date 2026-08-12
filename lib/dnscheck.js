const dns = require("node:dns").promises;

// Confere se o domínio do profissional já aponta para a gente.
//
// Por que não basta olhar o CNAME: na RAIZ de um domínio (`marlon.com.br`, sem
// nada na frente) o DNS proíbe CNAME, e os provedores resolvem isso com ALIAS /
// ANAME / "CNAME achatado" — o nome some e sobram só os endereços. Um teste que
// só olhasse CNAME diria "não apontou" para quem apontou certo.
//
// Por isso são dois caminhos, nesta ordem:
//   1. o CNAME bate com o alvo;
//   2. os endereços do domínio são os mesmos endereços do alvo.
//
// `resolver` é injetável para o teste não depender de rede nem de DNS real.
const semPonto = (v) => String(v || "").trim().toLowerCase().replace(/\.+$/, "");

async function pointsTo(host, target, { resolver = dns } = {}) {
  const alvo = semPonto(target);
  const nome = semPonto(host);
  if (!nome || !alvo) return { ok: false, erro: "invalid" };

  // 1. CNAME direto.
  let cname = null;
  try {
    const nomes = (await resolver.resolveCname(nome)).map(semPonto);
    cname = nomes[0] || null;
    if (nomes.includes(alvo)) return { ok: true, via: "cname", found: cname };
  } catch (error) {
    // Sem CNAME não é erro: é o caso da raiz do domínio. Segue para os IPs.
  }

  // 2. Mesmos endereços que o alvo.
  try {
    const [meus, deles] = await Promise.all([resolver.resolve4(nome), resolver.resolve4(alvo)]);
    const conjunto = new Set(deles);
    if (meus.some((ip) => conjunto.has(ip))) {
      return { ok: true, via: "ip", found: cname || meus[0] || null };
    }
    return { ok: false, erro: "wrong_target", found: cname || meus[0] || null };
  } catch (error) {
    // NXDOMAIN e ENODATA são o caso normal de quem ainda não criou o registro.
    return { ok: false, erro: cname ? "wrong_target" : "not_found", found: cname };
  }
}

module.exports = { pointsTo };
