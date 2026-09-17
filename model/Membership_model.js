const { ObjectId } = require("mongodb");
const recorrencia = require("../lib/recorrencia.js");

// OS PLANOS QUE A CASA VENDE — "Black", "Fit", "Smart".
//
// ── POR QUE "MEMBERSHIP" E NÃO "PLAN" ────────────────────────────────────
//
// Porque "plano" já é outra coisa neste sistema: `controllers/Plan.js` e
// `app.api.center.plansForSale()` são os planos do PRODUTO — o que nós vendemos
// para a academia, com a Stripe do outro lado.
//
// Este aqui é o que a academia vende para os ALUNOS dela. Duas camadas de
// assinatura no mesmo servidor, e usar a mesma palavra para as duas é como se
// escreve um `app.api.plan` que um dia atende a pergunta errada. (Eu cheguei a
// escrever, e sobrescrevi o controller do checkout no caminho.)
//
// Na TELA os dois se chamam "Planos", porque é o que cada público entende.
//
//   { name, description, amount, currency, cadencia, fidelidadeMeses,
//     categorias: [id], destaque, active, order }
//
// Pedido do Marlon em 17/09/2026, com a página da Smart Fit ao lado: *"como
// pretendo oferecer para academias, ai eu crio a recorrencia com um plano"*.
//
// ── PLANO NÃO É RECORRÊNCIA, e a diferença é o que faz isto valer ────────
//
// O plano é o CARDÁPIO: existe uma vez, vale para todo mundo, e é o que vai na
// vitrine. A recorrência é o COMBINADO com uma pessoa: "a Giovana paga o Black,
// todo dia 5, desde julho".
//
// Três academias com quatrocentos alunos têm três planos e mil e duzentas
// recorrências. Guardar o preço só no plano faria "quanto a Giovana paga" ser
// uma pergunta sem resposta no dia em que o plano subir de preço.
//
// ── POR ISSO A RECORRÊNCIA COPIA, e não aponta ───────────────────────────
//
// Ao nascer de um plano, ela leva o valor, a cadência e o nome COPIADOS, e
// guarda o id só como origem. Subir o Black de 159 para 179 passa a valer para
// quem entrar depois; quem já assinou continua pagando o que combinou — que é
// como funciona em qualquer academia, e é o que a lei espera.
//
// Reajustar quem já está dentro é outra operação, deliberada, e ela não existe
// ainda. Quando existir, vai ser um botão que diz quantas recorrências vai
// mexer — nunca um efeito colateral de editar o cardápio.
function Membership_model(app) {
  this.app = app;
}

Membership_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("memberships");
};

const centavos = (v) => Math.max(0, Math.round(Number(v) || 0));

// ── O QUE O PLANO OFERECE É UMA LISTA DE IDS, e não de textos ────────────
//
// A primeira versão tinha `beneficios: ["texto", "texto"]`, digitados um a um.
// Desenha o cartão e NÃO desenha a tabela de comparação: para comparar, os três
// planos precisam falar da mesma linha — e "Acesso a aulas coletivas" num,
// "Aulas coletivas" no outro viram duas linhas que ninguém alinha.
//
// Agora eles apontam para o catálogo (`membership_categories`), e "não" é ausência:
// o que não está na lista sai com o "×" cinza. Ver o modelo das categorias.
const MAX_CATEGORIAS = 60;

function categorias(v) {
  if (!Array.isArray(v)) return [];

  const vistos = new Set();
  const saida = [];

  for (const x of v) {
    const id = String(x || "");
    if (!ObjectId.isValid(id) || vistos.has(id)) continue;
    vistos.add(id);
    saida.push(new ObjectId(id));
    if (saida.length >= MAX_CATEGORIAS) break;
  }

  return saida;
}

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 80),
  description: (v) => String(v || "").trim().slice(0, 500),
  amount: (v) => centavos(v),
  cadencia: (v) => recorrencia.normalizar(v),
  // ── FIDELIDADE EM MESES, e zero quer dizer "sem fidelidade" ────────────
  //
  // É o "12 meses de fidelidade" do cartão. Número e não texto porque um dia
  // ele vai decidir alguma coisa — quanto falta para poder cancelar sem multa —
  // e "12 meses" escrito à mão não decide nada.
  fidelidadeMeses: (v) => Math.min(Math.max(Math.round(Number(v) || 0), 0), 120),
  categorias,
  // O "Mais vantajoso" da vitrine. Mais de um destaque não destaca nada, e quem
  // garante isso é a gravação — ver `insert` e `update`.
  destaque: (v) => v === true,
  active: (v) => v !== false,
};

Membership_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}).sort({ order: 1, createdAt: 1 }).toArray();
};

Membership_model.prototype.listActive = async function () {
  const col = await this.collection();
  return col.find({ active: true }).sort({ order: 1, createdAt: 1 }).toArray();
};

Membership_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

// Só UM destaque por conta.
//
// Na vitrine ele é o cartão amarelo, o "Mais vantajoso". Dois cartões gritando
// ao mesmo tempo não destacam nada — e a tela não teria como escolher qual
// desenhar em cima. Quem acabou de ser marcado ganha; os outros perdem.
Membership_model.prototype.apenasUmDestaque = async function (id) {
  const col = await this.collection();
  await col.updateMany({ _id: { $ne: new ObjectId(id) }, destaque: true }, { $set: { destaque: false } });
};

Membership_model.prototype.insert = async function (obj, currency) {
  const col = await this.collection();

  const doc = {
    currency: currency || null,
    // No FIM da lista: quem cadastra um plano novo não quer que ele apareça na
    // frente dos que já estavam ali sem ter pedido.
    order: await col.countDocuments({}),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  for (const [campo, limpar] of Object.entries(CAMPOS)) doc[campo] = limpar(obj[campo]);

  const r = await col.insertOne(doc);
  if (doc.destaque) await this.apenasUmDestaque(r.insertedId);

  return r.insertedId;
};

// Mescla, como `updateCharge` passou a fazer depois de reescrever o documento
// inteiro e apagar cinco cobranças de verdade. O que a chamada não menciona,
// ela não toca.
Membership_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  if (mudanca.destaque) await this.apenasUmDestaque(id);

  return r.matchedCount > 0;
};

// ── APAGAR UM PLANO EM USO É RECUSADO ────────────────────────────────────
//
// Mesma decisão das formas de pagamento: a recorrência guarda o id dele como
// ORIGEM, e uma origem que aponta para o nada é uma linha que ninguém consegue
// explicar meses depois.
//
// Quem quer parar de vender não apaga — DESATIVA. O plano some da vitrine e do
// seletor, e continua explicando quem já está dentro.
Membership_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return { erro: "notFound" };

  const col = await this.collection();
  const alvo = await col.findOne({ _id: new ObjectId(id) });
  if (!alvo) return { erro: "notFound" };

  const recorrencias = await (await this.app.api.recurrence.collection()).countDocuments({
    plan: new ObjectId(id),
  });
  if (recorrencias > 0) return { erro: "inUse", quantas: recorrencias };

  await col.deleteOne({ _id: new ObjectId(id) });
  return { ok: true };
};

// A ORDEM é a da vitrine, e ela é escolhida — não sai de preço nem de nome.
// Grava tudo de uma vez: "meio reordenada" é um estado que ninguém sabe
// consertar olhando a tela.
Membership_model.prototype.reorder = async function (ids) {
  if (!Array.isArray(ids)) return false;
  const col = await this.collection();

  const validos = ids.filter((id) => ObjectId.isValid(id));
  if (!validos.length) return false;

  await Promise.all(
    validos.map((id, i) =>
      col.updateOne({ _id: new ObjectId(id) }, { $set: { order: i, updatedAt: new Date() } })
    )
  );

  return true;
};

module.exports = Membership_model;
module.exports.MAX_CATEGORIAS = MAX_CATEGORIAS;
