const { ObjectId } = require("mongodb");

// A collection `services` — o que o profissional oferece.
//
//   "Treino personalizado, 60 min, R$ 120, 1 vaga"
//   "Aula de grupo, 50 min, R$ 40, 8 vagas"
//
// Existe porque três coisas precisam da MESMA definição e não podem discordar:
// a agenda interna (que sugere duração e gera a cobrança), o financeiro (que
// cobra o valor) e a agenda pública (que oferece ao cliente o que dá para
// marcar). Com o valor digitado a cada compromisso, dois lançamentos do mesmo
// serviço sairiam por preços diferentes sem ninguém notar.
//
// O VALOR fica em CENTAVOS, inteiro. `1.1 + 2.2` em ponto flutuante dá
// 3.3000000000000003, e dinheiro somado assim erra o centavo — que é
// exatamente o que ninguém perdoa num relatório financeiro.
function Service_model(app) {
  this.app = app;
}

const DURACAO_PADRAO = 60;

Service_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("services");
};

// "120", "120,50", "R$ 1.200,00" → centavos.
//
// Aceita as duas pontuações porque as duas são digitadas: o separador decimal
// é vírgula em português e ponto em inglês, e o mesmo campo recebe os dois.
// A regra: o ÚLTIMO separador é o decimal, e o resto é milhar.
function centavos(valor) {
  if (valor === undefined || valor === null || valor === "") return 0;

  // Já em centavos (veio do próprio sistema).
  if (typeof valor === "number") return Math.max(0, Math.round(valor));

  const texto = String(valor).replace(/[^\d.,-]/g, "");
  if (!texto) return 0;

  const ultimaVirgula = texto.lastIndexOf(",");
  const ultimoPonto = texto.lastIndexOf(".");
  const corte = Math.max(ultimaVirgula, ultimoPonto);

  // Sem separador nenhum, ou com ele longe do fim (1.200 = mil e duzentos),
  // o número é inteiro em reais.
  const decimais = corte >= 0 ? texto.length - corte - 1 : 0;
  if (decimais !== 1 && decimais !== 2) {
    const inteiro = Number(texto.replace(/[.,]/g, ""));
    return Number.isFinite(inteiro) ? Math.max(0, Math.round(inteiro * 100)) : 0;
  }

  const reais = texto.slice(0, corte).replace(/[.,]/g, "");
  const centavosTexto = texto.slice(corte + 1).padEnd(2, "0");

  const n = Number(reais || "0") * 100 + Number(centavosTexto);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function inteiroOuPadrao(valor, padrao, { min = 1, max = 100000 } = {}) {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) && n >= min && n <= max ? n : padrao;
}

function limpar(obj) {
  return {
    name: String(obj.name || "").trim().slice(0, 120),
    // Quanto dura, para a agenda já sugerir o fim do compromisso.
    minutes: inteiroOuPadrao(obj.minutes, DURACAO_PADRAO, { min: 5, max: 24 * 60 }),
    price: centavos(obj.price),
    // Em QUE moeda este serviço é vendido. Sem ela, um serviço em dólar geraria
    // cobrança na moeda padrão da conta, e o valor sairia certo com o símbolo
    // errado — o pior tipo de erro, porque parece certo.
    currency: obj.currency ? String(obj.currency).toUpperCase().slice(0, 3) : null,

    // Quantas pessoas cabem no MESMO horário. Um para atendimento
    // individual; oito para uma aula de grupo. É o que a agenda pública usa
    // para saber se ainda há vaga — e o que a interna usa para avisar.
    capacity: inteiroOuPadrao(obj.capacity, 1, { min: 1, max: 500 }),

    // Quais profissionais oferecem. Vazio significa TODOS: numa conta de um
    // profissional só, obrigar a marcar a si mesmo seria burocracia.
    professionals: Array.isArray(obj.professionals)
      ? obj.professionals.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id))
      : [],

    description: String(obj.description || "").trim().slice(0, 500),

    // Serviço desativado some da agenda pública e da lista de escolha, mas
    // continua existindo: os compromissos e as cobranças que já apontam para
    // ele não podem ficar órfãos.
    active: obj.active !== false,

    // A ordem em que aparece para o cliente. Quem vende quer o principal em
    // cima, e ordem alfabética não sabe disso.
    order: inteiroOuPadrao(obj.order, 0, { min: 0, max: 9999 }),
  };
}

Service_model.prototype.list = async function ({ apenasAtivos = false } = {}) {
  const col = await this.collection();

  const filtro = apenasAtivos ? { active: true } : {};
  return await col.find(filtro).sort({ order: 1, name: 1 }).toArray();
};

Service_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// Os serviços que um profissional oferece. Lista vazia no serviço significa
// "todos", então ele entra para qualquer profissional.
Service_model.prototype.listOfProfessional = async function (professionalId) {
  const todos = await this.list({ apenasAtivos: true });
  if (!ObjectId.isValid(professionalId)) return todos;

  return todos.filter(
    (s) =>
      !s.professionals?.length ||
      s.professionals.some((p) => String(p) === String(professionalId))
  );
};

Service_model.prototype.insert = async function (obj) {
  const col = await this.collection();

  const r = await col.insertOne({
    ...limpar(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Service_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...limpar(obj), updatedAt: new Date() } }
  );

  return r.matchedCount > 0;
};

Service_model.prototype.delete = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

module.exports = Service_model;
module.exports.centavos = centavos;
module.exports.DURACAO_PADRAO = DURACAO_PADRAO;
