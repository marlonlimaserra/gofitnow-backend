const { ObjectId } = require("mongodb");
const categorias = require("../lib/categoriasDeConta.js");

// OS FORNECEDORES — quem recebe o dinheiro que sai.
//
// *"Fornecedor, em cima ponha 'novo fornecedor', aí abre um dialog para digitar
// todos os dados do fornecedor e foto"*.
//
// ── ELE ERA TEXTO LIVRE, E ISSO NÃO IA DURAR ────────────────────────────
//
// A primeira versão de contas a pagar guardava o fornecedor como string, com o
// argumento de que uma academia paga para vinte fornecedores por ano e um
// cadastro seria uma tela a mais.
//
// O argumento estava incompleto, e é o mesmo que fez a CATEGORIA ser lista
// fechada: com campo livre, "Enel", "ENEL", "Enel SP" e "enel" viram quatro
// fornecedores, e "quanto paguei para a Enel este ano" deixa de ter resposta.
// A diferença é que a categoria tem treze opções e o fornecedor é de cada casa
// — então ele precisa de cadastro, e não de catálogo.
//
// O cadastro também guarda o que a string nunca guardaria: o CNPJ para a nota,
// o telefone de quem se liga quando a conta chega errada, e a foto — que numa
// lista de trinta contas é o que distingue as linhas antes da leitura.
//
// ── O QUE ELE NÃO É ─────────────────────────────────────────────────────
//
// Não é uma pessoa da conta. Fornecedor não faz login, não tem treino, não
// aparece em lugar nenhum do app do aluno. Reaproveitar `users` traria o
// documento inteiro — senha, sal, vínculo — para uma tela de conta de luz.
function Supplier_model(app) {
  this.app = app;
}

Supplier_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("suppliers");
};

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 140),
  // ── O QUE ELE PREENCHE SOZINHO ────────────────────────────────────────
  //
  // *"ponha para escolher o fornecedor primeiro, pois se escolher 'enel' já
  // auto preenche com conta de luz a descrição"*.
  //
  // São dois campos e eles ficam no FORNECEDOR, não numa tabela de regras: a
  // Enel é sempre energia e sempre "Conta de luz" nesta casa, e quem sabe disso
  // é o cadastro dela. Uma tabela à parte seria um segundo lugar para manter
  // igual, e a primeira coisa a divergir.
  //
  // São padrões, e não travas: a tela preenche e a pessoa corrige. A conta da
  // Enel que veio de uma obra é "Ligação provisória", e ninguém quer brigar com
  // o formulário para escrever isso.
  categoria: (v) => categorias.normalizar(v),
  defaultDescription: (v) => String(v || "").trim().slice(0, 200),
  // ── FÍSICA OU JURÍDICA ────────────────────────────────────────────────
  //
  // *"bote aqui 'tipo', se é física ou jurídica"*.
  //
  // O padrão é `pj`: quase todo fornecedor de academia é empresa — a
  // distribuidora, a operadora, a imobiliária. A pessoa física é o professor
  // terceirizado, o eletricista, a faxineira; ela existe e é minoria.
  //
  // O tipo não é enfeite: é ele que decide se o campo do documento pede CPF ou
  // CNPJ, e um dia é ele que separa quem entra no informe de rendimentos de
  // quem entra na nota fiscal.
  personType: (v) => (String(v) === "pf" ? "pf" : "pj"),
  // CNPJ ou CPF, como a pessoa escreve. Sem validação de dígito: um fornecedor
  // estrangeiro não tem nem um nem outro, e recusar o cadastro por causa do
  // documento seria impedir de lançar a conta.
  document: (v) => String(v || "").trim().slice(0, 30),
  // QUEM ATENDE do lado de lá. "Falar com a Márcia" é o que resolve a conta
  // errada, e é o dado que some quando o fornecedor é uma string.
  contact: (v) => String(v || "").trim().slice(0, 140),
  phone: (v) => String(v || "").trim().slice(0, 30),
  whatsapp: (v) => String(v || "").trim().slice(0, 30),
  email: (v) => String(v || "").trim().slice(0, 140).toLowerCase(),
  site: (v) => link(v),
  // O ENDEREÇO em uma linha, e não em partes como o da unidade.
  //
  // A unidade precisa das partes porque alguém CALCULA com elas: o ponto no
  // mapa. Do fornecedor ninguém calcula nada — o endereço existe para pôr na
  // nota e para achar a loja. Pedir CEP, número e bairro aqui seria cobrar seis
  // campos para o que cabe em um.
  address: (v) => String(v || "").trim().slice(0, 240),
  note: (v) => String(v || "").trim().slice(0, 2000),
  active: (v) => v !== false,
  // Só o ID da foto, nunca a URL: guardar o endereço prenderia o fornecedor ao
  // domínio do backend do dia em que a foto subiu. `""` é uma EDIÇÃO — tirar a
  // foto é uma escolha, e precisa ser gravável.
  photo: (v) => {
    const id = String(v || "").split("/").pop();
    return ObjectId.isValid(id) ? new ObjectId(id) : null;
  },
};

// `http`/`https` só: `javascript:` num `href` é execução, e este endereço vira
// um link clicável na ficha do fornecedor.
function link(v) {
  const texto = String(v || "").trim().slice(0, 300);
  if (!texto) return "";
  try {
    const u = new URL(texto.includes("://") ? texto : `https://${texto}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch (erro) {
    return "";
  }
}

function limpar(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) saida[campo] = tratar(obj[campo]);
  return saida;
}

function limparParcial(obj) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

// Em ordem ALFABÉTICA, e não por criação: a lista existe para achar um nome
// numa caixa de busca, e a ordem de cadastro não ajuda ninguém a achar.
Supplier_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}).collation({ locale: "pt" }).sort({ name: 1 }).toArray();
};

Supplier_model.prototype.listActive = async function () {
  return (await this.list()).filter((f) => f.active !== false);
};

// ── IMPORTAR OS DO VAFIT ──────────────────────────────────────────────────
//
// *"coloque um botão 'usar os do vafit', aí puxa da central todos os
// fornecedores"*.
//
// O que entra é CÓPIA: o cliente edita à vontade, e uma correção nossa no
// catálogo não sobrescreve o que ele ajustou. É a mesma relação do catálogo de
// exercícios com "meus exercícios" — lá é a semente, aqui é o que a casa
// cultivou.
//
// ── O QUE JÁ EXISTE NÃO É TOCADO ────────────────────────────────────────
//
// Casado pelo NOME, sem acento e em minúsculas. Quem já cadastrou "Enel" à mão,
// com o contato do gerente dele, não pode receber uma segunda "Enel" limpa — e
// muito menos ter a dele sobrescrita.
//
// É o que faz o botão poder ser clicado duas vezes sem medo, que é exatamente o
// que acontece quando alguém não tem certeza se já clicou.
//
// ── A LOGO VEM JUNTO ────────────────────────────────────────────────────
//
// `logos` é um mapa `{ id do conhecido: { mime, data } }`, lido do banco do
// painel por `center.logosDeConhecidos`. Os bytes são COPIADOS para a base da
// casa, como o resto: apontar para a imagem do painel faria a logo da Enel
// sumir da tela dele no dia em que alguém a trocasse lá.
//
// Falhar ao gravar uma logo NÃO derruba a importação. O fornecedor sem logo é
// um fornecedor; a importação que morre no meio deixa metade do catálogo dentro
// e a outra metade fora, e ninguém sabe qual metade.
Supplier_model.prototype.importarConhecidos = async function (conhecidos, logos = {}) {
  if (!Array.isArray(conhecidos) || !conhecidos.length) return { criados: 0, jaExistiam: 0 };

  const col = await this.collection();
  const atuais = await col.find({}, { projection: { name: 1 } }).toArray();
  const tem = new Set(atuais.map((f) => chave(f.name)));

  const novos = [];
  let jaExistiam = 0;

  for (const c of conhecidos) {
    if (tem.has(chave(c.name))) {
      jaExistiam++;
      continue;
    }

    // A chave entra no conjunto na hora: o catálogo pode trazer duas linhas com
    // nomes que normalizam igual, e sem isto as duas entrariam.
    tem.add(chave(c.name));

    novos.push({
      // De qual linha do catálogo ele veio — só para achar a logo logo abaixo.
      // Não vai para o banco: é apagado antes do insert.
      _origem: String(c._id || ""),
      ...limpar({
        name: c.name,
        categoria: c.categoria,
        defaultDescription: c.defaultDescription,
        personType: c.personType,
        document: c.document,
        phone: c.phone,
        site: c.site,
        active: true,
      }),
      // DE ONDE VEIO. Não muda comportamento nenhum hoje; serve para responder
      // "esta lista é minha ou veio pronta?" quando alguém estranhar um nome.
      fromCatalog: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  if (!novos.length) return { criados: 0, jaExistiam };

  const origens = novos.map((n) => n._origem);
  for (const n of novos) delete n._origem;

  const r = await col.insertMany(novos);

  let comLogo = 0;
  for (let i = 0; i < novos.length; i++) {
    const logo = logos[origens[i]];
    const bytes = logo && bytesDaLogo(logo.data);
    if (!bytes || !logo.mime) continue;

    try {
      const id = String(r.insertedIds[i]);
      const salva = await this.app.api.supplierImage.save(id, logo.mime, bytes);
      await col.updateOne({ _id: r.insertedIds[i] }, { $set: { photo: new ObjectId(salva.id) } });
      comLogo++;
    } catch (erro) {
      console.error("[fornecedores] logo importada:", erro.message);
    }
  }

  return { criados: novos.length, jaExistiam, comLogo };
};

// O que o Mongo devolve num campo binário não é sempre a mesma coisa: por
// padrão o driver entrega um `Binary` do BSON, cujo `.buffer` é o Buffer de
// verdade, e com `promoteBuffers` entrega o Buffer direto.
//
// A diferença morde: um Buffer TAMBÉM tem `.buffer` — o ArrayBuffer do pool
// interno, de 64 KB —, e testar por ele primeiro transformava uma logo de 4
// bytes em 65.536. Por isso o Buffer é reconhecido ANTES.
function bytesDaLogo(data) {
  if (!data) return undefined;
  if (Buffer.isBuffer(data)) return data;
  if (data.buffer) return Buffer.from(data.buffer);
  return Buffer.from(data);
}

// Sem acento e em minúsculas: "ENEL", "Enel" e "enel" são o mesmo fornecedor.
function chave(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

Supplier_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

Supplier_model.prototype.insert = async function (obj) {
  const doc = limpar(obj);
  // Sem nome não há fornecedor: a linha da conta não diria para quem foi.
  if (!doc.name) return null;

  const col = await this.collection();
  const r = await col.insertOne({ ...doc, createdAt: new Date(), updatedAt: new Date() });

  await this.recolherFotos(r.insertedId, doc.photo);
  return r.insertedId;
};

Supplier_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;

  const set = limparParcial(obj);
  if (set.name !== undefined && !set.name) return false;

  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...set, updatedAt: new Date() } }
  );

  const depois = await col.findOne({ _id: new ObjectId(id) }, { projection: { photo: 1 } });
  await this.recolherFotos(id, depois?.photo);

  return r.matchedCount > 0;
};

// As fotos que o fornecedor NÃO usa mais.
//
// Roda em toda gravação e não só quando a foto muda: quem trocou a imagem três
// vezes antes de salvar enviou três, e duas ficariam penduradas no bucket para
// sempre. O dono da verdade é o fornecedor salvo.
//
// Nunca estoura: é faxina, e faxina que falha não pode impedir ninguém de
// salvar. A próxima gravação tenta de novo.
Supplier_model.prototype.recolherFotos = async function (id, photo) {
  try {
    await this.app.api.supplierImage.pruneUnused(id, photo ? [String(photo)] : []);
  } catch (erro) {
    console.error("[fornecedor] faxina das fotos:", erro.message);
  }
};

// Quantas contas apontam para este fornecedor. É o que a exclusão pergunta
// antes de deixar apagar: sumir com o fornecedor deixaria trinta linhas de
// histórico sem dizer para quem o dinheiro foi.
Supplier_model.prototype.quantasContas = async function (id) {
  if (!ObjectId.isValid(id)) return 0;
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payables").countDocuments({ supplier: new ObjectId(String(id)) });
};

Supplier_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });

  if (r.deletedCount) {
    try {
      await this.app.api.supplierImage.removeAllOf(id);
    } catch (erro) {
      console.error("[fornecedor] fotos órfãs:", erro.message);
    }
  }

  return r.deletedCount > 0;
};

module.exports = Supplier_model;
