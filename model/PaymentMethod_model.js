const { ObjectId } = require("mongodb");

// As formas de pagamento DESTA conta: Pix, dinheiro, cartão — e o que mais o
// profissional usar.
//
//   { key, name, active, order, system }
//
// Era uma lista fixa no código, e o motivo de ser fixa continua valendo: `method`
// vira coluna de relatório, e com texto livre "pix", "PIX" e "Pix" seriam três
// formas diferentes. A saída não é abrir o campo — é abrir o CATÁLOGO e manter
// a chave.
//
// `key` é o que fica gravado no pagamento e nunca muda. `name` é o que se lê na
// tela e pode mudar quando quiser: renomear "Boleto" para "Boleto bancário" não
// mexe em lançamento nenhum.
//
// As sete originais nascem com `system: true`. Elas não podem ser APAGADAS —
// pagamentos antigos apontam para elas, e um pagamento cuja forma sumiu vira uma
// linha sem explicação. Podem ser renomeadas, desativadas e reordenadas, que é o
// que se quer na prática: quem não usa boleto o desliga e ele some do seletor
// sem apagar o histórico de quem já pagou assim.
const PADRAO = ["pix", "cash", "credit", "debit", "transfer", "billet", "other"];

function PaymentMethod_model(app) {
  this.app = app;
}

PaymentMethod_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payment_methods");
};

// A chave de uma forma NOVA, a partir do nome.
//
// Só letras, números e hífen: ela viaja em URL de relatório e em nome de coluna
// de planilha, e um "à vista / 50%" ali seria um problema em três lugares.
function chaveDe(nome) {
  const limpa = String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

  return limpa || null;
}

// A lista, semeada na primeira leitura.
//
// Semear aqui e não numa migração: instância nova, instância antiga e instância
// criada depois desta linha passam todas por aqui, e nenhuma delas precisa que
// alguém lembre de rodar nada.
//
// `name` nasce VAZIO nas sete originais de propósito. Elas são traduzidas — a
// tela mostra "Pix" em português e "Pix" em inglês, mas "Dinheiro" e "Cash".
// Gravar o nome no banco congelaria o idioma de quem criou a conta. Quem
// renomear passa a ter nome próprio, e aí a tradução sai de cena, que é o certo:
// o nome escolhido é o nome.
PaymentMethod_model.prototype.list = async function () {
  const col = await this.collection();
  const existentes = await col.find({}).sort({ order: 1 }).toArray();
  if (existentes.length) return existentes;

  const semente = PADRAO.map((key, i) => ({
    key,
    name: "",
    active: 1,
    order: i,
    system: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  await col.insertMany(semente);
  return col.find({}).sort({ order: 1 }).toArray();
};

// Só as que o seletor de pagamento oferece.
PaymentMethod_model.prototype.listActive = async function () {
  return (await this.list()).filter((f) => Number(f.active) !== 0);
};

// As chaves que um pagamento pode ter: TODAS, inclusive as desativadas.
//
// Desativar tira do seletor, não invalida o passado. Recusar aqui impediria de
// corrigir a observação de um pagamento antigo em boleto depois de o boleto
// sair de uso.
PaymentMethod_model.prototype.keys = async function () {
  return (await this.list()).map((f) => f.key);
};

PaymentMethod_model.prototype.insert = async function (obj) {
  const col = await this.collection();

  const nome = String(obj.name || "").trim().slice(0, 40);
  if (nome.length < 2) return { erro: "name" };

  const key = chaveDe(nome);
  if (!key) return { erro: "name" };

  const jaTem = await col.findOne({ key });
  if (jaTem) return { erro: "duplicate" };

  // Entra no FIM: uma forma nova no meio da lista mudaria de lugar o que as
  // pessoas já sabem onde fica.
  const ultima = await col.find({}).sort({ order: -1 }).limit(1).toArray();

  const r = await col.insertOne({
    key,
    name: nome,
    active: obj.active === undefined ? 1 : Number(obj.active) ? 1 : 0,
    order: (ultima[0]?.order ?? -1) + 1,
    system: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { id: r.insertedId };
};

PaymentMethod_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const set = { updatedAt: new Date() };

  if (obj.name !== undefined) {
    const nome = String(obj.name).trim().slice(0, 40);
    if (nome.length < 2) return { erro: "name" };
    set.name = nome;
  }

  if (obj.active !== undefined) set.active = Number(obj.active) ? 1 : 0;

  // A CHAVE nunca muda. Ela está gravada em todo pagamento feito naquela forma,
  // e trocá-la deixaria o histórico apontando para o nada.
  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
  return r.matchedCount > 0;
};

PaymentMethod_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const forma = await col.findOne({ _id: new ObjectId(id) });
  if (!forma) return false;

  // As sete originais não se apagam — só se desativam. Ver o comentário do topo.
  if (forma.system) return { erro: "system" };

  // Forma já usada também não: o pagamento ficaria com uma forma que não existe
  // em lugar nenhum, e a lista mostraria um branco onde havia "Cheque".
  const pagamentos = await (await this.app.mongodb.connectToServer())
    .collection("payments")
    .countDocuments({ method: forma.key }, { limit: 1 });

  if (pagamentos) return { erro: "inUse" };

  await col.deleteOne({ _id: new ObjectId(id) });
  return true;
};

// A ordem inteira de uma vez.
//
// Uma chamada por item deixaria a lista meio reordenada se a segunda falhasse —
// e "meio reordenada" é um estado que ninguém sabe consertar olhando a tela.
PaymentMethod_model.prototype.reorder = async function (ids) {
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

module.exports = PaymentMethod_model;
module.exports.PADRAO = PADRAO;
module.exports.chaveDe = chaveDe;
