const crypto = require("crypto");

// Os erros que acontecem NA TELA de quem usa.
//
// Existe porque o console do navegador é inalcançável: quando um cliente diz
// "abri e ficou branco", pedir para ele apertar F12 e mandar foto não é suporte,
// é sorte. Aqui a tela conta sozinha, e o painel lê depois.
//
// ── Por que no banco CENTRAL e não no do cliente ──────────────────────────
//
// Porque metade dos erros acontece ANTES de existir instância: o portal genérico
// não é de cliente nenhum, e é justamente lá que mora a tela mais nova e mais
// provável de quebrar. E porque procurar um bug em trinta bancos separados é
// como não ter registro nenhum.
//
// ── Por que AGRUPADO por assinatura, e não uma linha por ocorrência ───────
//
// Um erro dentro de um `useEffect` dispara a cada render. Uma linha por
// ocorrência transformaria uma falha em dez mil registros iguais, e a leitura do
// painel viraria rolagem infinita do MESMO problema — que é exatamente como se
// perde o segundo problema, o que importava.
//
// Agrupado, dez mil viram uma linha com `count: 10000`, que é uma informação
// melhor: diz que é grave, e não só que existe.
function ClientError_model(app) {
  this.app = app;
}

// Trinta dias. O registro se apaga sozinho pelo índice TTL do Mongo.
//
// Não é economia de disco por avareza: a máquina tem 44 GB livres e roda o banco
// de TODOS os clientes. Um log de erro sem prazo é a coisa mais fácil de encher
// um disco no mundo — e disco cheio derruba o Mongo, ou seja, o registro de
// diagnóstico derrubaria a produção que ele existe para diagnosticar.
const DIAS = 30;

// Limites de tamanho, e eles são recusa e não truncamento silencioso do cliente.
//
// A tela manda o que ela viu, e o que ela viu pode ser uma pilha de 200 linhas.
// Cortar aqui, no servidor, é o único lugar que garante o corte — o cliente é
// código que roda na máquina de outra pessoa e pode mandar qualquer coisa.
const MAX_MENSAGEM = 500;
const MAX_PILHA = 4000;
const MAX_CAMPO = 300;

function corta(v, n) {
  return String(v == null ? "" : v).slice(0, n);
}

// De QUAL tela veio o erro.
//
//   app     — o sistema que o cliente usa (e o app instalado, que é o mesmo código)
//   painel  — a central, que só nós abrimos
//
// Os dois relatam para cá de propósito: um lugar só para olhar quando algo
// quebrou, em vez de dois painéis e a dúvida de em qual procurar. O que separa é
// este campo — e ele entra na assinatura, ver abaixo.
const ORIGENS = ["app", "painel"];

ClientError_model.prototype.collection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("client_errors");
};

// Os índices nascem na primeira escrita, uma vez por processo.
//
// Aqui e não no `schema.js` das instâncias porque a collection é do banco
// central, que não passa pelo provisionamento de cliente.
let indexado = false;

ClientError_model.prototype.garantirIndices = async function (col) {
  if (indexado) return;
  indexado = true;

  await col.createIndex({ sig: 1 }, { unique: true, name: "por_assinatura" });
  // O TTL olha `ultimoEm`, não `primeiroEm`: um erro que continua acontecendo
  // hoje não pode sumir porque começou há 31 dias.
  await col.createIndex({ ultimoEm: 1 }, { expireAfterSeconds: DIAS * 86400, name: "expira" });
  // A leitura do painel: os mais recentes primeiro, com filtro de resolvido.
  await col.createIndex({ resolvido: 1, ultimoEm: -1 }, { name: "por_estado_data" });
  await col.createIndex({ instance: 1, ultimoEm: -1 }, { name: "por_instancia" });
  await col.createIndex({ origem: 1, ultimoEm: -1 }, { name: "por_origem" });
};

// ── O QUE FAZ DOIS ERROS SEREM "O MESMO" ──────────────────────────────────
//
// Mensagem, arquivo e linha. NÃO entra a URL nem o usuário: o mesmo defeito
// atinge todo mundo em páginas diferentes, e separá-los por página devolveria a
// enxurrada que o agrupamento existe para evitar.
//
// A mensagem entra com os NÚMEROS trocados por `#`. Sem isso, "Cannot read
// properties of undefined (reading 'x') at line 4821" e a mesma coisa na linha
// 4822 viram dois problemas — e um deploy que só mexeu no espaçamento criaria
// registros novos para bugs velhos.
function assinatura({ message, source, line, tipo, origem }) {
  const bruto = [
    // A ORIGEM entra na assinatura porque o painel e o app são dois programas
    // diferentes. "i18n is not defined" pode acontecer nos dois, com pilhas e
    // consertos distintos — juntá-los num registro só faria alguém marcar como
    // resolvido um bug que continua de pé do outro lado.
    //
    // Ela foi acrescentada depois que a collection já tinha registros. Um erro
    // que já estava lá ganha assinatura nova e vira uma segunda linha, uma vez.
    // Não vale reescrever o histórico por isso: em trinta dias o TTL leva as
    // antigas, e até lá duas linhas do mesmo erro incomodam menos que um script
    // de migração mexendo no único registro de diagnóstico que existe.
    corta(origem, 10) || "app",
    corta(tipo, 20),
    corta(message, MAX_MENSAGEM).replace(/\d+/g, "#"),
    corta(source, MAX_CAMPO).replace(/[?#].*$/, ""),
    line || "",
  ].join("|");

  return crypto.createHash("sha1").update(bruto).digest("hex").slice(0, 16);
}

// ── O RUÍDO que não vale registrar ────────────────────────────────────────
//
// Cada um destes é um erro que aparece, não é nosso, e não tem conserto:
//
//   ResizeObserver — o navegador reclama de um laço de layout que ele mesmo
//   resolve no quadro seguinte. É o erro mais famoso do mundo por ser inútil.
//
//   Script error — erro dentro de um script de OUTRA origem, onde o navegador
//   recusa contar o que houve. Chega sem mensagem, sem arquivo e sem linha.
//
//   extensões — bloqueador de anúncio e tradutor injetam código na página e
//   quebram sozinhos. Vira registro nosso e não é nosso.
//
// Sem esta lista, o painel abre cheio de coisa que ninguém pode arrumar — e um
// painel assim se aprende a ignorar, inclusive no dia em que ele estiver certo.
// Os padrões são testados SEPARADAMENTE contra a mensagem e contra a origem.
//
// A primeira versão juntava as duas numa string e testava nela. Um teste pegou o
// erro: `/Failed to fetch$/` nunca casava, porque a concatenação punha um espaço
// depois da mensagem e o `$` deixava de encontrar o fim. Padrão ancorado só
// funciona no campo dele.
const RUIDO_MENSAGEM = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /^Non-Error promise rejection captured/i,
  // Navegação abortada no meio: a pessoa fechou a aba ou clicou noutro link
  // enquanto uma requisição corria. Não é defeito.
  /^Failed to fetch$/i,
  /^NetworkError when attempting/i,
  /^Load failed$/i,
  /^AbortError/i,
];

// O que veio de FORA da nossa página. Bloqueador de anúncio e tradutor injetam
// código e quebram sozinhos — vira registro nosso e não é nosso.
const RUIDO_ORIGEM = [/^(chrome|moz|safari)-extension:/i, /^chrome:\/\//i];

function ehRuido(message, source) {
  const m = String(message || "").trim();
  const o = String(source || "").trim();

  if (RUIDO_MENSAGEM.some((r) => r.test(m))) return true;
  if (o && RUIDO_ORIGEM.some((r) => r.test(o))) return true;

  return false;
}

// Grava — ou soma um ao que já existe.
//
// Devolve `{ registrado: false }` quando é ruído, para quem chamou poder
// responder a mesma coisa nos dois casos: a tela não precisa saber se o erro
// dela foi guardado, e dizer que não seria convidar a tentar de novo.
ClientError_model.prototype.registrar = async function (dados) {
  const message = corta(dados.message, MAX_MENSAGEM);
  const source = corta(dados.source, MAX_CAMPO);

  if (!message) return { registrado: false };
  if (ehRuido(message, source)) return { registrado: false };

  const col = await this.collection();
  await this.garantirIndices(col);

  const agora = new Date();

  // A origem é ESCOLHIDA DE UMA LISTA, nunca aceita como texto livre: ela vem de
  // código que roda na máquina de outra pessoa, e vai para dentro do filtro do
  // painel. Qualquer coisa fora da lista cai em "app", que é o caso comum.
  const origem = ORIGENS.includes(dados.origem) ? dados.origem : "app";

  const sig = assinatura({ message, source, line: dados.line, tipo: dados.tipo, origem });

  await col.updateOne(
    { sig },
    {
      // A ÚLTIMA ocorrência sobrescreve os detalhes, e isso é escolha: quando um
      // erro volta depois de um deploy, o que interessa é a versão de AGORA, não
      // a de trinta dias atrás. O `primeiroEm` guarda a história.
      $set: {
        message,
        source,
        stack: corta(dados.stack, MAX_PILHA),
        tipo: corta(dados.tipo, 20) || "js",
        line: Number(dados.line) || 0,
        col: Number(dados.col) || 0,
        caminho: corta(dados.caminho, MAX_CAMPO),
        origem,
        instance: corta(dados.instance, 60),
        host: corta(dados.host, MAX_CAMPO),
        versao: corta(dados.versao, 30),
        app: dados.app === true,
        navegador: corta(dados.navegador, MAX_CAMPO),
        ultimoEm: agora,
      },
      $inc: { count: 1 },
      $setOnInsert: { sig, primeiroEm: agora, resolvido: false },
    },
    { upsert: true }
  );

  return { registrado: true, sig };
};

module.exports = ClientError_model;
module.exports.assinatura = assinatura;
module.exports.ehRuido = ehRuido;
module.exports.ORIGENS = ORIGENS;
