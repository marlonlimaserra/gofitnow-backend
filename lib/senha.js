const crypto = require("node:crypto");

// A SENHA: como ela é guardada, e por que mudou.
//
// ── O que havia antes ─────────────────────────────────────────────────────
//
// SHA-512 de UMA rodada, com salt por usuário. O salt cumpria o papel dele
// (duas senhas iguais não geram o mesmo hash), mas SHA-512 é um hash RÁPIDO —
// ele foi feito para verificar arquivo grande depressa, e essa velocidade é
// exatamente o que ajuda quem tenta adivinhar: uma placa de vídeo faz bilhões
// por segundo.
//
// Isso era tolerável enquanto cada instância guardava as suas: vazar um cliente
// expunha um cliente. Com `all_users` na central, as senhas de TODO MUNDO
// passam a morar num lugar só, e o prêmio de um vazamento muda de tamanho.
// Trocar o algoritmo é a contrapartida de centralizar.
//
// ── scrypt, e por que ele ─────────────────────────────────────────────────
//
// scrypt é uma função de derivação: ela é LENTA de propósito, e é lenta também
// em memória (o parâmetro N abaixo), que é o que tira a vantagem das placas de
// vídeo. E vem no Node, em `node:crypto` — nenhuma dependência nova para uma
// coisa que precisa durar dez anos.
//
// N = 16384 é o padrão recomendado para uso interativo: ~50 ms por verificação
// nesta máquina. É desprezível num login e é uma parede para quem tenta a
// força bruta.
const N = 16384;
const r = 8;
const p = 1;
const TAMANHO = 64;

// A memória que o scrypt pede com esses parâmetros passa do limite padrão do
// Node (32 MB), e sem isto ele recusa com "Invalid scrypt params".
const MAXMEM = 64 * 1024 * 1024;

const SCRYPT = "scrypt";
const ANTIGO = "sha512";

function novoSal() {
  return crypto.randomBytes(16).toString("hex");
}

function scrypt(senha, sal) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(senha), String(sal), TAMANHO, { N, r, p, maxmem: MAXMEM }, (erro, chave) =>
      erro ? reject(erro) : resolve(chave.toString("base64"))
    );
  });
}

// O hash ANTIGO continua existindo aqui, e não é sobra: enquanto houver uma
// conta que nunca mais entrou, o hash dela é SHA-512, e é com ele que a
// comparação tem de ser feita no dia em que a pessoa voltar.
function sha512(senha, sal) {
  return crypto
    .createHash("sha512")
    .update(sal + ":" + senha)
    .digest("base64");
}

// Guarda o ALGORITMO junto. Sem esse campo, "é scrypt ou é o antigo?" viraria
// adivinhação pelo tamanho do texto — que funciona hoje e quebra na próxima vez
// que alguém mexer nos parâmetros.
async function gerar(senha) {
  const salt = novoSal();
  return { password: await scrypt(senha, salt), salt, algo: SCRYPT };
}

// Comparação em tempo CONSTANTE.
//
// Um `!==` normal para na primeira letra diferente, e o tempo que ele leva
// conta quantas letras bateram. É um vazamento pequeno e real; `timingSafeEqual`
// custa o mesmo em qualquer caso.
function iguais(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Confere a senha contra o documento, seja qual for o algoritmo dele.
//
// Devolve `{ ok, precisaRegravar }`. O segundo é o que permite a migração
// acontecer SOZINHA: quem entra com uma senha certa guardada em SHA-512 tem o
// hash regravado em scrypt ali mesmo, e ninguém precisa redefinir nada. Contas
// que nunca mais entrarem ficam no algoritmo antigo — e é o correto, porque a
// única hora em que se pode gerar o hash novo é a hora em que a senha em texto
// existe na memória.
async function conferir(senha, doc) {
  if (!senha || !doc || !doc.password || !doc.salt) return { ok: false, precisaRegravar: false };

  if (doc.algo === SCRYPT) {
    return { ok: iguais(await scrypt(senha, doc.salt), doc.password), precisaRegravar: false };
  }

  const ok = iguais(sha512(senha, doc.salt), doc.password);
  return { ok, precisaRegravar: ok };
}

module.exports = { gerar, conferir, SCRYPT, ANTIGO };
