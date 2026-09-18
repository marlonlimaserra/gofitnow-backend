const { ObjectId } = require("mongodb");
const iconeGuardado = require("../lib/iconeGuardado.js");
const cep = require("../lib/cep.js");

// AS UNIDADES DA CASA — "Centro", "Barra", "Zona Sul".
//
// Pedido do Marlon em 18/09/2026: *"quero cadastrar unidades de academia sabe?
// não precisa ser exatamente de academia... foto da unidade, endereços de
// contatos, ícone da unidade etc... aí o aluno pode fazer parte ou não, de
// apenas 1 unidade"*.
//
// ── NÃO É SÓ DE ACADEMIA, e o modelo não presume que seja ───────────────
//
// Ele disse isso na mesma frase, e é a decisão de desenho mais importante
// daqui: uma clínica tem consultórios, um estúdio tem salas, um personal
// atende em dois condomínios. Por isso não há `cnpj`, `horárioDeFuncionamento`
// nem `capacidade` — nada que só faça sentido numa academia de bairro.
//
// O que toda unidade tem é: um NOME, um LUGAR e um JEITO DE FALAR com ela.
//
// ── UMA SÓ POR PESSOA ───────────────────────────────────────────────────
//
// "de apenas 1 unidade". Então o vínculo mora na PESSOA (`users.unit`), e não
// numa lista aqui: um campo que aceita um id só é impossível de encher com
// dois, enquanto uma lista de pessoas na unidade precisaria de uma regra
// dizendo que ninguém repete em duas — e regra se esquece.
//
// E é OPCIONAL: "pode fazer parte ou não". Quem atende em um lugar só nunca
// precisa saber que esta tela existe.
function Unit_model(app) {
  this.app = app;
}

Unit_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("units");
};

// ── O ENDEREÇO É ESTRUTURADO, e o CEP preenche o resto ──────────────────
//
// A primeira versão tinha uma caixa de texto só, e o argumento era razoável:
// endereço em campos separados só se paga quando alguém CALCULA com ele.
//
// *"peça o endereço completo e não um text area de endereço, peça o cep
// primeiro e preencha o resto"* — e ele está certo, porque alguém CALCULA com
// ele agora: o ponto no mapa. Geocodificar "Av. Paulista 1000 sala 4 SP" é
// adivinhação; geocodificar as partes é consulta.
//
// E a conta do trabalho virou: com o CEP preenchendo rua, bairro, cidade e UF,
// são DOIS campos digitados — o CEP e o número — contra uma linha inteira
// escrita à mão.
//
// ── `endereco` NÃO sumiu: ele virou o DERIVADO ─────────────────────────
//
// A lista, o cartão e um dia a vitrine mostram uma linha só. Ela é montada na
// gravação, a partir das partes (`lib/cep.js`), e não guardada pela tela: duas
// fontes para o mesmo endereço divergem na primeira edição, e a errada é
// sempre a que aparece.
//
// ── O CEP NÃO É OBRIGATÓRIO, e o formato não é exigido ─────────────────
//
// "CEP" é brasileiro. Quem cadastra uma unidade em Lisboa preenche tudo à mão
// e nada barra o caminho — o CEP é um atalho, nunca uma cerca.
const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 80),
  // A frase curta: "Ao lado do metrô", "Entrada pela lateral".
  tagline: (v) => String(v || "").trim().slice(0, 120),
  cep: (v) => String(v || "").trim().slice(0, 20),
  logradouro: (v) => String(v || "").trim().slice(0, 160),
  numero: (v) => String(v || "").trim().slice(0, 20),
  complemento: (v) => String(v || "").trim().slice(0, 80),
  bairro: (v) => String(v || "").trim().slice(0, 80),
  cidade: (v) => String(v || "").trim().slice(0, 80),
  uf: (v) => String(v || "").trim().slice(0, 40),
  // ── O PONTO NO MAPA ────────────────────────────────────────────────────
  //
  // Guardado como dois números, e não como um link: link é para ABRIR, e
  // coordenada é para CALCULAR. Com a coordenada dá para montar o link de
  // qualquer mapa, medir distância e um dia listar "as unidades perto de
  // você"; do link não se tira coordenada nenhuma.
  //
  // Fora da faixa vira NADA. Uma latitude de 200 não é um ponto — é um erro de
  // digitação que poria o alfinete no meio do oceano.
  lat: (v) => grau(v, 90),
  lng: (v) => grau(v, 180),
  mapa: (v) => link(v),
  phone: (v) => String(v || "").trim().slice(0, 30),
  whatsapp: (v) => String(v || "").trim().slice(0, 30),
  email: (v) => String(v || "").trim().slice(0, 120).toLowerCase(),
  icone: iconeGuardado.nome,
  active: (v) => v !== false,
  // ── APARECER NO MAPA DE PARCEIROS DA VAFIT ──────────────────────────────
  //
  // *"na unidade ponha um checkbox, exibir no mapa vafit"*.
  //
  // `v === true` e não `v !== false`: este é o único campo desta casa que
  // manda um dado do cliente para uma página NOSSA, aberta a qualquer um.
  // Ausente tem de significar NÃO — senão toda unidade já cadastrada apareceria
  // no mapa no dia do deploy, sem ninguém ter pedido.
  //
  // É a diferença entre um padrão e um consentimento: `active` pode nascer
  // ligado porque é sobre o uso interno; este não pode.
  noMapa: (v) => v === true,
  // Só o ID da foto, nunca a URL: guardar o endereço inteiro prenderia a
  // unidade ao domínio do backend do dia em que a foto subiu — e este sistema
  // já mudou de endereço uma vez.
  //
  // `""` é uma EDIÇÃO: tirar a foto é uma escolha, e precisa ser gravável.
  photo: (v) => {
    const id = String(v || "").split("/").pop();
    return ObjectId.isValid(id) ? new ObjectId(id) : null;
  },
};

// Um grau de latitude ou longitude, ou nada. `null` e não `0`: zero é um ponto
// de verdade (no golfo da Guiné), e usá-lo como "sem ponto" poria o alfinete
// lá para toda unidade que nunca escolheu um.
function grau(v, teto) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= teto ? n : null;
}

// O link do mapa. `http`/`https` só: `javascript:` num `href` é execução, e
// este endereço pode acabar num cartão que o cliente embute no site dele.
function link(v) {
  const texto = String(v || "").trim().slice(0, 500);
  if (!texto) return "";
  try {
    const u = new URL(texto);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch (erro) {
    return "";
  }
}

const ICONE = { nome: "icone", svg: "iconeSvg", caixa: "iconeCaixa" };

Unit_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}).sort({ order: 1, createdAt: 1 }).toArray();
};

Unit_model.prototype.listActive = async function () {
  const col = await this.collection();
  return col.find({ active: true }).sort({ order: 1, createdAt: 1 }).toArray();
};

Unit_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

Unit_model.prototype.insert = async function (obj) {
  const col = await this.collection();

  const doc = {
    // No FIM da lista: quem cadastra uma unidade não a quer na frente das que
    // já estavam ali sem ter pedido.
    order: await col.countDocuments({}),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  for (const [campo, limpar] of Object.entries(CAMPOS)) doc[campo] = limpar(obj[campo]);
  if (!doc.name) return null;

  // A linha única é DERIVADA das partes, e nunca vem da tela: duas fontes para
  // o mesmo endereço divergem na primeira edição.
  doc.endereco = cep.umaLinha(doc);

  await iconeGuardado.aplicar(doc, null, ICONE);

  const r = await col.insertOne(doc);
  await this.recolherFotos(r.insertedId, doc.photo);

  return r.insertedId;
};

// Mescla, como `updateCharge` passou a fazer depois de reescrever o documento
// inteiro e apagar cinco cobranças de verdade. O que a chamada não menciona,
// ela não toca.
Unit_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }

  const antes = await col.findOne({ _id: new ObjectId(id) });
  await iconeGuardado.aplicar(mudanca, antes, ICONE);

  // A linha única se refaz a cada gravação, sobre o documento COMPLETO: uma
  // edição que mexe só no número precisa da rua que já estava lá, e montá-la
  // só com o que veio na chamada apagaria o resto do endereço.
  mudanca.endereco = cep.umaLinha({ ...antes, ...mudanca });

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });

  // A faxina olha o que ficou GRAVADO, e não o que veio na chamada: uma edição
  // que não menciona a foto mantém a de antes, e apagá-la aqui seria o mesmo
  // erro destrutivo do `updateCharge`.
  const depois = await col.findOne({ _id: new ObjectId(id) }, { projection: { photo: 1 } });
  await this.recolherFotos(id, depois?.photo);

  return r.matchedCount > 0;
};

// As fotos que a unidade NÃO usa mais. Nunca estoura: é faxina, e faxina que
// falha não pode impedir alguém de salvar.
Unit_model.prototype.recolherFotos = async function (id, photo) {
  try {
    await this.app.api.unitImage.pruneUnused(id, photo ? [String(photo)] : []);
  } catch (erro) {
    console.error("[unidades] faxina de foto:", erro?.message || erro);
  }
};

// ── APAGAR UMA UNIDADE COM GENTE DENTRO É RECUSADO ──────────────────────
//
// Apagar deixaria as pessoas apontando para uma unidade que não existe: elas
// não somem da lista, mas passam a mostrar um vínculo vazio que ninguém
// consegue explicar nem desfazer em lote.
//
// O erro diz QUANTAS pessoas estão nela — é o número que faz entender o que
// ia acontecer. Quem quer tirar a unidade do ar sem mexer em ninguém
// DESATIVA: ela some das escolhas e quem já está nela continua.
//
// Mesma regra da linha da tabela de benefícios, e pela mesma razão.
Unit_model.prototype.quantasPessoas = async function (id) {
  if (!ObjectId.isValid(id)) return 0;
  const db = await this.app.mongodb.connectToServer();
  return db.collection("users").countDocuments({ unit: new ObjectId(id) });
};

Unit_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });

  // As fotos vão junto: sem isto elas ficariam apontando para uma unidade que
  // não existe, e nada as alcançaria.
  try {
    await this.app.api.unitImage.removeAllOf(id);
  } catch (erro) {
    console.error("[unidades] fotos da unidade apagada:", erro?.message || erro);
  }

  return r.deletedCount > 0;
};

// A ORDEM é a das unidades na tela e na escolha da ficha. "Centro" vem antes
// de "Barra" porque é a matriz, e não porque começa com C.
Unit_model.prototype.reorder = async function (ids) {
  if (!Array.isArray(ids)) return false;
  const col = await this.collection();

  const validos = ids.filter((id) => ObjectId.isValid(id));
  if (validos.length !== ids.length) return false;

  await Promise.all(
    validos.map((id, i) => col.updateOne({ _id: new ObjectId(id) }, { $set: { order: i } }))
  );

  return true;
};

module.exports = Unit_model;
