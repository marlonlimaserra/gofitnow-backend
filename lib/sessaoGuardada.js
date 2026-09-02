const redis = require("./redis.js");
const instanceContext = require("./instance.js");

// A SESSÃO GUARDADA POR UM MINUTO.
//
// ── O que ela economiza ───────────────────────────────────────────────────
//
// Toda requisição autenticada faz TRÊS idas ao Mongo antes de a rota começar:
// achar a sessão pelo token, achar o usuário, achar o papel (as permissões).
// Medido no servidor em 30/08/2026: 1,7 ms, contra 0,14 ms de uma leitura no
// Redis.
//
// Não é um problema que alguém sinta hoje. O que ele é: trabalho repetido em
// TODA requisição, numa máquina de um núcleo — e é isso que decide até onde ela
// aguenta antes de precisar de uma segunda.
//
// ── POR QUE UM MINUTO, E NÃO DEZ ──────────────────────────────────────────
//
// Porque o prazo é o TETO do estrago. Tudo que este cache pode errar — uma
// permissão revogada que ainda vale, uma conta desativada que ainda entra — dura
// no máximo o prazo. Sessenta segundos economiza quase tudo o que dez minutos
// economizariam (as requisições vêm em rajada, não espalhadas) e custa
// sessenta vezes menos no pior caso.
const PRAZO_MS = 60 * 1000;

// ── A CHAVE, e o ajuste que o desenho do Marlon precisou ──────────────────
//
// A ideia veio dele: "a chave seria INSTANCIA_username_token, aí quando mexer no
// usuário você pode limpar o token".
//
// O instinto está certo nas duas pontas — a INSTÂNCIA precisa entrar (o mesmo
// texto de token em dois clientes não pode colidir) e o TOKEN precisa entrar (é
// ele que o logout apaga, e ter o token na chave é o que torna a limpeza exata).
//
// O ajuste é este: na LEITURA só existe o token. Quem chega numa rota manda o
// cabeçalho `session` e nada mais — o usuário é justamente o que se está indo
// buscar. Uma chave que exija o nome do usuário não pode ser montada antes de
// saber quem ele é.
//
// Então são DUAS chaves:
//
//   sessao:<instância>:<token>      o que a leitura acha, com o usuário dentro
//   sessoes:<instância>:<id>        o conjunto dos tokens daquela pessoa
//
// A segunda existe para "mexeu no usuário, limpa tudo dele": sem ela, limpar
// exigiria varrer o Redis inteiro procurando quais tokens são dele.
function chaveDoToken(instancia, token) {
  return `sessao:${instancia}:${token}`;
}

function chaveDoUsuario(instancia, userId) {
  return `sessoes:${instancia}:${userId}`;
}

// A instância da requisição atual. Fora de uma, não há sessão para guardar.
function instanciaAtual() {
  try {
    return instanceContext.current() || "";
  } catch (erro) {
    return "";
  }
}

// ── LER ───────────────────────────────────────────────────────────────────
//
// Devolve o usuário já resolvido (com papel e permissões), ou `null` — que
// significa "não sei", e quem chama vai ao banco como sempre foi.
async function ler(token) {
  if (!redis.ligado() || !token) return null;

  const instancia = instanciaAtual();
  if (!instancia) return null;

  try {
    const cru = await redis.lerTexto(chaveDoToken(instancia, token));
    if (!cru) return null;

    const user = JSON.parse(cru);
    // Um objeto sem `_id` é lixo (gravação truncada, formato antigo). Melhor ir
    // ao banco que devolver uma sessão pela metade.
    return user && user._id ? user : null;
  } catch (erro) {
    return null;
  }
}

// ── GUARDAR ───────────────────────────────────────────────────────────────
//
// O que entra é o MESMO objeto que a rota receberia — já filtrado por
// `User_model.filter`, sem senha e sem sal. Guardar o documento cru do Mongo
// aqui poria o hash da senha num segundo lugar, e num que é mais fácil de ler
// que o banco.
function guardar(token, user) {
  if (!redis.ligado() || !token || !user?._id) return;

  const instancia = instanciaAtual();
  if (!instancia) return;

  const id = String(user._id);

  // Sem `await`: a resposta já está pronta para quem pediu, e uma ida ao Redis
  // não deve entrar no tempo dela.
  redis.guardarTexto(chaveDoToken(instancia, token), JSON.stringify(user), PRAZO_MS);
  redis.somarAoConjunto(chaveDoUsuario(instancia, id), token, PRAZO_MS);
}

// ── ESQUECER ──────────────────────────────────────────────────────────────
//
// Os dois caminhos que apagam, e eles moram nos MODELOS e não nos controladores.
//
// A razão é o que este projeto já aprendeu com o escopo de cliente: são seis
// controladores que derrubam token ou mexem em usuário, e um esquecido é uma
// sessão que continua valendo depois de revogada — em silêncio. No modelo, todo
// caminho passa por um lugar só.
async function esquecerToken(token) {
  if (!redis.ligado() || !token) return;

  const instancia = instanciaAtual();
  if (!instancia) return;

  await redis.esquecer([chaveDoToken(instancia, token)]);
}

// Tudo de uma pessoa: usado quando o usuário muda (permissão, papel, conta
// desativada) e quando todas as sessões dela são derrubadas.
async function esquecerUsuario(userId, instancia = instanciaAtual()) {
  if (!redis.ligado() || !userId || !instancia) return;

  const id = String(userId);
  const conjunto = chaveDoUsuario(instancia, id);

  try {
    const tokens = await redis.membrosDoConjunto(conjunto);
    const chaves = (tokens || []).map((t) => chaveDoToken(instancia, t));
    await redis.esquecer([...chaves, conjunto]);
  } catch (erro) {
    // Nada a fazer: no pior caso a sessão velha vale até o prazo acabar.
  }
}

// TUDO de um cliente. Usado quando uma escrita em `users` alcança várias linhas
// e não dá para saber quais — derrubar o cache inteiro daquele cliente é melhor
// que adivinhar. O preço é um minuto de idas ao banco, e ele é pequeno.
async function esquecerTudo(instancia = instanciaAtual()) {
  if (!redis.ligado() || !instancia) return;

  await redis.esquecerPorPadrao(`sessao:${instancia}:*`);
  await redis.esquecerPorPadrao(`sessoes:${instancia}:*`);
}

module.exports = {
  ler,
  guardar,
  esquecerToken,
  esquecerUsuario,
  esquecerTudo,
  PRAZO_MS,
  chaveDoToken,
};
