// OS ÂNGULOS DA FOTO DE EVOLUÇÃO, e o que cada casa faz deles.
//
// Nasceram fixos e em quatro — frente, lado direito, lado esquerdo, costas —
// porque a comparação depende disso: duas fotos de ângulos diferentes não
// mostram progresso, mostram duas poses. A regra continua de pé; o que mudou é
// quem a escreve. Quatro serve a quem avalia composição corporal e não serve a
// quem prepara atleta para palco, que fotografa pose, não lado.
//
// Então os quatro viraram o PADRÃO de cada instância, e a casa acrescenta ou
// tira nas configurações.
//
// ── A CHAVE É PARA SEMPRE, O RÓTULO NÃO ────────────────────────────────────
//
// A chave (`front`, `duplo-biceps`) é o que vai na URL da rota
// (`/assessments/:id/photos/:side`) e o que nomeia o campo dentro do documento
// da coleta (`photos.front`). Ela nasce do rótulo e nunca mais muda: renomear
// "Frente" para "Frente relaxada" mantém `front`, e as fotos de dois anos
// continuam achando o lugar delas.
//
// Daí o formato apertado: minúsculas, dígitos e hífen. Ponto e cifrão são
// proibidos pelo Mongo em nome de campo, e barra e espaço quebrariam a rota.
//
// ── RÓTULO VAZIO É DE PROPÓSITO ────────────────────────────────────────────
//
// Os quatro de fábrica saem daqui SEM rótulo, e é isso que os mantém traduzidos:
// a interface, não achando texto, usa `assessments.photoSides.<chave>` e diz
// "Frente" em português e "Front" em inglês. Escrever "Frente" aqui congelaria a
// palavra em português para uma conta que atende em duas línguas.
//
// Quem digita um rótulo assume a tradução — e é o certo: "Duplo bíceps" é o nome
// que aquela casa dá àquela pose, não uma frase do produto.

// Os quatro de fábrica, na ordem em que se fotografa: de frente, gira para a
// direita, gira de novo, e de costas.
const PADRAO = ["front", "right", "left", "back"];

// Doze, e não quatro nem infinito. Quatro deixou de servir — foi o que originou
// esta configuração. Infinito faria a coleta virar álbum, que é exatamente o que
// o formato de uma rota por ângulo evitou desde o começo: cada ângulo a mais é
// uma foto a mais por avaliação, para sempre, em todas as pessoas da conta.
//
// O NÚMERO SAIU DAQUI em 04/09/2026, e continua sendo doze. Ele passou a ser o
// teto ABSOLUTO em `lib/tetosEstruturais.js`, ao lado dos outros três que
// nasceram no mesmo dia (alimentos por refeição, exercícios por treino, séries
// por exercício) — e o plano ganhou o direito de apertar abaixo dele, na central.
//
// Escrito num lugar só porque a rota agora recusa acima do teto do plano e este
// arquivo corta acima do absoluto: dois números iguais em dois arquivos é um
// número que um dia vai divergir.
const MAXIMO = require("./tetosEstruturais.js").absoluto("photoSides");

const MAX_ROTULO = 40;
const MAX_CHAVE = 24;

function limparRotulo(v) {
  return String(v == null ? "" : v)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ROTULO);
}

// O acento cai antes do corte: "Duplo bíceps" vira `duplo-biceps`, e não
// `duplo-b-ceps`. `normalize("NFD")` separa a letra do acento e o intervalo
// apaga o acento sozinho.
function chaveDe(rotulo) {
  return String(rotulo || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHAVE)
    .replace(/-+$/g, "");
}

function chaveValida(v) {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,23}$/.test(v);
}

// A lista de fábrica. É ela que responde por toda instância que nunca abriu a
// configuração — e são quase todas.
function padrao() {
  return PADRAO.map((key) => ({ key, label: "" }));
}

// O que vem do banco, pronto para uso.
//
// `undefined` (nunca configurou) e `[]` (configurou e apagou todos) são coisas
// DIFERENTES: a primeira quer os quatro, a segunda quer nenhum — é a conta que
// não usa foto, e devolver os quatro ali seria desfazer uma escolha.
function daInstancia(guardado) {
  if (!Array.isArray(guardado)) return padrao();
  return guardado
    .filter((l) => l && chaveValida(l.key))
    .map((l) => ({ key: l.key, label: limparRotulo(l.label) }));
}

// O que chega da tela, pronto para o banco.
//
// Devolve `null` para entrada que não é lista — recusar é melhor que gravar uma
// lista vazia por engano, que apagaria os ângulos de todo mundo.
//
// Entrada sem chave é ângulo NOVO: a chave nasce do rótulo aqui, no servidor,
// para que exista um lugar só onde a regra do formato mora. Entrada com chave é
// ângulo que já existe, e a chave dele é intocável.
function normalizar(entrada) {
  if (!Array.isArray(entrada)) return null;

  const usadas = new Set();
  const saida = [];

  for (const bruto of entrada) {
    if (!bruto || typeof bruto !== "object") continue;
    if (saida.length >= MAXIMO) break;

    const label = limparRotulo(bruto.label);

    // A chave que veio manda, se for válida. Não sendo, nasce do rótulo; sem
    // rótulo utilizável (só emoji, só pontuação), vira `angulo-N` — que é feio
    // e funciona, e o rótulo na tela continua sendo o que a pessoa escreveu.
    let key = chaveValida(bruto.key) ? bruto.key : chaveDe(label);
    if (!key) key = "angulo-" + (saida.length + 1);

    // Duas vagas com a mesma chave seriam a mesma foto em dois lugares: a
    // segunda sobrescreveria a primeira sem avisar.
    if (usadas.has(key)) {
      let n = 2;
      while (usadas.has(`${key}-${n}`) && n < 99) n += 1;
      key = `${key}-${n}`.slice(0, MAX_CHAVE);
    }

    // Um ângulo de fábrica sem rótulo continua traduzido; um ângulo criado sem
    // rótulo não teria nome nenhum na tela, e a chave é o menos pior.
    usadas.add(key);
    saida.push({ key, label: label || (PADRAO.includes(key) ? "" : key) });
  }

  return saida;
}

module.exports = {
  PADRAO,
  MAXIMO,
  padrao,
  daInstancia,
  normalizar,
  chaveDe,
  chaveValida,
};
