// BUSCAR A FOTO DE PERFIL DO WHATSAPP e usá-la como avatar.
//
// "Apenas para o sistema conseguir pegar a foto do WhatsApp quando algum
// profissional fizer cadastro."
//
// Roda quando uma PESSOA é cadastrada com telefone. Escolha dele em 03/09/2026,
// e a certa: o cadastro do profissional não pede telefone, e a foto vale mais
// numa lista de 216 pessoas — reconhecer alguém numa lista longa é o problema que
// ela resolve.
//
// ── NADA AQUI PODE DERRUBAR UM CADASTRO ───────────────────────────────────
//
// É a regra que molda o arquivo inteiro. Toda função engole o próprio erro e
// devolve vazio, porque:
//
//   o uazapi é API NÃO OFICIAL e a conexão dele cai — número desconectado,
//   sessão expirada, WhatsApp derrubando o pareamento;
//
//   e a alternativa a não ter foto é a inicial do nome, que é o que a tela já
//   desenha há meses.
//
// Perder a foto é perder um enfeite. Perder o cadastro é perder o trabalho de
// quem digitou.
//
// ── E NUNCA É ESPERADO PELA RESPOSTA ──────────────────────────────────────
//
// Quem chama usa `app.depois(...)`: o cadastro responde e a foto chega depois,
// na próxima vez que a lista carregar. Uma ida ao WhatsApp no caminho crítico
// somaria segundos a um formulário — e segundos num "salvar" fazem a pessoa
// clicar de novo.
//
// ── A CÓPIA DO CLIENTE UAZAPI É DE PROPÓSITO ──────────────────────────────
//
// O `lib/uazapi.js` da central tem a mesma conversa. Não é importado daqui: são
// dois deploys com dois `package.json`, e um `require` atravessando projetos
// quebra no primeiro deploy de um só. O que se compartilha é o FORMATO, e ele
// está escrito nos dois lados — mesma escolha dos chamados de suporte.
//
// A diferença é o escopo: lá tem o teste de conexão, que é da tela; aqui só a
// busca da foto, que é o que o produto usa.
const { ObjectId } = require("mongodb");

const TEMPO_LIMITE = 10000;
const CAMINHO_FOTO = "/chat/GetNameAndImageURL";

// Teto dos bytes que aceito baixar.
//
// Foto de perfil do WhatsApp é pequena — a maior que já vi tem uns 100 KB. Um
// teto de 2 MB cobre folgado e ainda protege de um host respondendo outra coisa
// (um HTML de erro, um redirecionamento para uma página inteira).
const MAX_BYTES = 2 * 1024 * 1024;

const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

// A configuração vive na central, na mesma collection `settings` que guarda o
// OAuth e a Resend — lida direto do banco, sem chamada HTTP entre os dois.
// Central fora do ar devolve DESLIGADO, como o desafio e o OAuth: uma falha de
// leitura não pode virar erro num cadastro.
const NOMES = ["whatsapp.uazapi.enabled", "whatsapp.uazapi.host", "whatsapp.uazapi.token"];

async function configuracao(app) {
  try {
    const db = await app.mongodb.centralDb();
    const docs = await db.collection("settings").find({ key: { $in: NOMES } }).toArray();
    const v = Object.fromEntries(docs.map((d) => [d.key, d.value]));

    const host = String(v["whatsapp.uazapi.host"] || "").trim().replace(/\/+$/, "");
    const token = String(v["whatsapp.uazapi.token"] || "").trim();

    // Ligado só com o TRIO completo. Ligado sem host ou sem token faria uma
    // requisição condenada em todo cadastro, e o log encheria de erro que não é
    // erro — é configuração pela metade.
    return {
      ligado: Boolean(v["whatsapp.uazapi.enabled"]) && Boolean(host) && Boolean(token),
      host,
      token,
    };
  } catch (erro) {
    return { ligado: false };
  }
}

// A URL da foto, pelo número. Vazio em qualquer problema.
async function urlDaFoto({ host, token }, numero) {
  const so = String(numero || "").replace(/\D/g, "");
  // Menos de 10 dígitos não é telefone brasileiro com DDD — nem consulto.
  if (so.length < 10) return "";

  try {
    const res = await fetch(host + CAMINHO_FOTO, {
      method: "POST",
      headers: { token, "Content-Type": "application/json" },
      body: JSON.stringify({ number: so }),
      signal: AbortSignal.timeout(TEMPO_LIMITE),
    });

    if (!res.ok) return "";
    const d = await res.json().catch(() => null);
    if (!d) return "";

    // Os nomes de campo variam entre versões do uazapi; tento os que já vi e
    // desisto em silêncio. Se um dia nenhum servir, é o botão de testar na
    // central que mostra o corpo cru e diz qual é o certo.
    return String(d.imageUrl || d.image || d.profilePictureUrl || d.urlImage || "").trim();
  } catch (erro) {
    return "";
  }
}

// Baixa os bytes da URL que o uazapi devolveu.
//
// A URL é do CDN do WhatsApp e expira; por isso os bytes são copiados para o
// nosso R2 em vez de a URL ser guardada. Guardar a URL daria uma foto que
// funciona hoje e vira quadrado vazio em algumas horas.
async function baixar(url) {
  if (!/^https:\/\//i.test(url)) return null;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TEMPO_LIMITE) });
    if (!res.ok) return null;

    const mime = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!MIMES.has(mime)) return null;

    // O `content-length` é conferido ANTES de ler o corpo: é o que evita puxar
    // 40 MB para descobrir no fim que era grande demais.
    const tamanho = Number(res.headers.get("content-length"));
    if (Number.isFinite(tamanho) && tamanho > MAX_BYTES) return null;

    const bytes = Buffer.from(await res.arrayBuffer());
    // E de novo depois, porque o cabeçalho pode faltar ou mentir.
    if (!bytes.length || bytes.length > MAX_BYTES) return null;

    return { mime, bytes };
  } catch (erro) {
    return null;
  }
}

// ── O QUE OS CADASTROS CHAMAM ─────────────────────────────────────────────
//
// Devolve `true` se gravou uma foto. O valor serve para o script de recuperação
// contar; nas rotas ninguém olha.
//
// Não sobrescreve foto existente, e é o cuidado principal: quem já tem avatar o
// escolheu, e o WhatsApp não tem autoridade para trocar o que uma pessoa
// colocou. Só preenche vazio.
async function buscarParaPessoa(app, userId, telefone) {
  if (!userId || !telefone) return false;

  const cfg = await configuracao(app);
  if (!cfg.ligado) return false;

  try {
    const users = await app.api.user.collection();
    if (!ObjectId.isValid(String(userId))) return false;

    const dono = await users.findOne(
      { _id: new ObjectId(String(userId)) },
      { projection: { avatarAt: 1 } }
    );
    if (!dono || dono.avatarAt) return false;

    const url = await urlDaFoto(cfg, telefone);
    if (!url) return false;

    const foto = await baixar(url);
    if (!foto) return false;

    // `avatar.save` faz o resto: R2 na pasta do cliente, `avatarAt` no usuário
    // (que é o que as telas leem) e o espelho na central. Reusar em vez de
    // escrever aqui é o que garante que a foto do WhatsApp e a que a pessoa
    // sobe vivam no mesmo lugar.
    await app.api.avatar.save(String(userId), foto.mime, foto.bytes);
    return true;
  } catch (erro) {
    console.warn("[fotoWhatsapp] não consegui a foto:", erro?.message);
    return false;
  }
}

module.exports = { buscarParaPessoa, configuracao, urlDaFoto, baixar, MAX_BYTES };
