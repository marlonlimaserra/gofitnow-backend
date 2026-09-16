const instanceContext = require("../lib/instance.js");
const modulos = require("../lib/modulos.js");

// O QUE ESTA CONTA JÁ LIBEROU.
//
// Um documento por cliente em `configurations`, sob `chave: "modulos"` — do lado
// da configuração da instância, que é o que ele é: uma escolha da conta, não do
// produto.
//
// Escopado pelo `lib/escopo.js` como todo o resto: `connectToServer()` injeta o
// `instance` no filtro, então uma conta nunca lê nem grava a liberação de outra.
//
// ── O CUIDADO QUE ESTE ARQUIVO TEM DE TER ─────────────────────────────────
//
// Se a lista vier vazia por acidente — documento ausente, leitura que falhou —
// a barra lateral esconde Aulões e Financeiro de quem está no meio de um
// atendimento. O padrão do erro, então, é ABRIR: quando não se sabe o que a
// conta liberou, mostra-se tudo. Ver `liberados`.
function Modulo_model(app) {
  this.app = app;
}

const CHAVE = "modulos";

Modulo_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("configurations");
};

// ── A LISTA, E O QUE ACONTECE QUANDO ELA NÃO EXISTE ───────────────────────
//
// `null` quer dizer "não sei", e é diferente de `[]`, que quer dizer "nada
// liberado". Quem chama decide o que fazer com o não sei — e as duas chamadas
// que existem decidem a mesma coisa: mostram tudo.
//
// A distinção importa porque as duas situações têm causas opostas. `[]` é uma
// conta nova que ainda não liberou nada, e esconder é o certo. `null` é o
// documento não ter sido semeado — e aí esconder é apagar menu de quem usa.
Modulo_model.prototype.liberados = async function () {
  const col = await this.collection();
  const doc = await col.findOne({ chave: CHAVE }, { projection: { lista: 1 } });
  if (!doc) return null;
  return Array.isArray(doc.lista) ? doc.lista.filter((k) => modulos.existe(k)) : [];
};

// ── OS CAMINHOS QUE A BARRA LATERAL ESCONDE ───────────────────────────────
//
// DOIS portões em série, e o menu só acende passando pelos dois:
//
//   1. o PLANO inclui este módulo?      (`Center_model.modulosDoPlano`)
//   2. a CONTA já o liberou?            (a notícia, com o vídeo e o botão)
//
// A ordem importa para quem lê, não para o resultado: sem o primeiro, o cliente
// do plano de entrada liberaria pela notícia um módulo que não comprou.
//
// ── Os dois "não sei" abrem ───────────────────────────────────────────────
//
// `null` do plano  = plano sem o campo, ou cliente sem plano → inclui tudo.
// `null` da conta  = documento não semeado                   → tem tudo.
//
// As duas são a mesma escolha, pelo mesmo motivo: esconder Aulões de quem está
// com a aula de sábado aberta, porque uma leitura não voltou, é tirar da pessoa
// uma coisa que ela tem. O erro barato é o que mostra.
Modulo_model.prototype.menusEscondidos = async function () {
  const [liberados, doPlano] = await Promise.all([
    this.liberados(),
    this.app.api.center.modulosDoPlano(instanceContext.required()),
  ]);

  // O que esta conta EFETIVAMENTE tem: liberado por ela E incluído no plano.
  const temNaConta = liberados === null ? modulos.CHAVES : liberados;
  const efetivos = doPlano === null ? temNaConta : temNaConta.filter((k) => doPlano.includes(k));

  return modulos.menusEscondidos(efetivos);
};

// LIBERAR. `$addToSet` porque apertar o botão duas vezes — duas abas, dois
// cliques — não pode gravar a chave duas vezes.
//
// `upsert` porque a conta pode não ter o documento ainda: o botão tem de
// funcionar mesmo numa conta que nunca passou pelo semeador.
Modulo_model.prototype.liberar = async function (chave) {
  if (!modulos.existe(chave)) return { ok: false, erro: "modulo_desconhecido" };

  const col = await this.collection();
  await col.updateOne(
    { chave: CHAVE },
    {
      $addToSet: { lista: String(chave) },
      $set: { updatedAt: new Date() },
      $setOnInsert: { chave: CHAVE, createdAt: new Date() },
    },
    { upsert: true }
  );

  return { ok: true, lista: await this.liberados() };
};

// ── O SEMEADOR, E A ARMADILHA QUE ELE EVITA ───────────────────────────────
//
// Chamado de dois lugares que querem coisas OPOSTAS, e é por isso que ele
// recebe `tudo` em vez de decidir sozinho:
//
//   • do BOOT (`ensureInstanceEssencial` percorre toda instância registrada):
//     `tudo: true`. Esta conta já existia antes deste recurso, e já tinha os
//     menus na tela. Semear vazio aqui apagaria Aulões e Financeiro do Marlon
//     no meio do dia — o defeito que este parâmetro existe para não cometer.
//
//   • do PROVISIONAMENTO de uma conta nova: `tudo: false`. Ela nasce só com o
//     que já é padrão, e recebe o resto pela notícia, com o vídeo e a
//     documentação.
//
// Sem o parâmetro, a única pista seria a data de criação da conta, comparada com
// uma data fixa no código — e uma data fixa é uma decisão que ninguém revisa
// depois, escrita num lugar onde ninguém procura.
//
// Só escreve quando NÃO HÁ documento: rodar no boot de novo não pode desfazer o
// que alguém liberou (nem o que alguém tirou, no dia em que houver como tirar).
Modulo_model.prototype.semear = async function ({ tudo = false } = {}) {
  const col = await this.collection();
  const jaTem = await col.findOne({ chave: CHAVE }, { projection: { _id: 1 } });
  if (jaTem) return { ok: true, criado: false };

  const lista = tudo ? [...modulos.CHAVES] : modulos.padroes();

  await col.insertOne({
    chave: CHAVE,
    lista,
    // Por que esta conta nasceu com esta lista. Dentro de um ano, "por que a
    // conta da Bruna tem aulão liberado e a nova não?" tem resposta aqui, em vez
    // de exigir arqueologia no log de deploy.
    semeadoComo: tudo ? "conta-anterior-ao-recurso" : "conta-nova",
    createdAt: new Date(),
  });

  return { ok: true, criado: true, lista };
};

module.exports = Modulo_model;
