const { ObjectId } = require("mongodb");

// A collection `aulaoes` — os AULÕES: aula em grupo com data, lugar e vagas.
//
//   "Aulão de pernas, 27/09 às 08:00, Parque Ibirapuera, 30 vagas, R$ 25"
//
// ── Por que não é um SERVIÇO com capacidade ───────────────────────────────
//
// `services` já tem `capacity`, `price` e `minutes`, e a agenda pública já
// oferece vaga em turma. A diferença é o TEMPO: um serviço é uma oferta
// permanente ("aula de grupo, 8 vagas") que acontece em qualquer horário livre
// da grade. Um aulão é um EVENTO — acontece uma vez, naquele dia, naquele
// lugar.
//
// Essa diferença arrasta tudo o mais: o aulão tem endereço próprio (não é onde
// a pessoa sempre atende), tem foto de capa e galeria (é divulgação, e serviço
// não divulga), tem uma lista de inscritos que fecha, e uma data depois da qual
// ele não existe mais. Empurrar isso para `services` daria a todo serviço seis
// campos que só um tipo usa.
//
// ── ELE VAI SER PÚBLICO, E ISSO NASCE AQUI ────────────────────────────────
//
// "esse aulão, em breve, gostaria de deixar público no site do VAFIT para
// outras pessoas também ver e poder se inscrever."
//
// Por isso `slug` e `publico` existem desde o primeiro dia, mesmo antes de a
// vitrine existir: acrescentar um slug depois é migrar todo aulão já criado e
// arriscar quebrar link que alguém guardou. O slug é único por instância e
// imutável depois de criado, pela mesma razão pela qual o nome de instância é.
//
// O que ainda NÃO existe é a listagem no site da VAFIT, e ela é uma decisão de
// arquitetura, não de código: o produto é escopado por instância
// (`lib/escopo.js`), e uma vitrine que junta aulões de clientes diferentes
// atravessa esse escopo de propósito. Fica para quando ele pedir.
//
// ── O DINHEIRO ────────────────────────────────────────────────────────────
//
// `priceCents` em centavos inteiros, como em `services` — e pelo mesmo motivo:
// `1.1 + 2.2` dá 3.3000000000000003, e um relatório financeiro que erra o
// centavo não é perdoado.
//
// Aulão de graça é `priceCents: 0`, e é diferente de `null`: não existe aulão
// sem preço definido — existe aulão gratuito.
function Aulao_model(app) {
  this.app = app;
}

Aulao_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("aulaoes");
};

Aulao_model.prototype.inscricoes = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("aulao_inscricoes");
};

// "120", "120,50", "R$ 1.200,00" → centavos. Mesma conta de `Service_model`:
// aceita as duas pontuações porque as duas são digitadas.
function centavos(valor) {
  if (valor === undefined || valor === null || valor === "") return 0;
  if (typeof valor === "number") return Math.max(0, Math.round(valor));

  const texto = String(valor).replace(/[^\d.,-]/g, "");
  if (!texto) return 0;

  // A última pontuação manda: em "1.200,50" a vírgula é decimal; em "1,200.50" é
  // o ponto. Adivinhar pelo primeiro separador erra um dos dois.
  const ultimaVirgula = texto.lastIndexOf(",");
  const ultimoPonto = texto.lastIndexOf(".");
  const decimal = ultimaVirgula > ultimoPonto ? "," : ".";
  const milhar = decimal === "," ? "." : ",";

  const normal = texto.split(milhar).join("").replace(decimal, ".");
  const n = Number(normal);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

function inteiroOuPadrao(valor, padrao, { min = 0, max = 100000 } = {}) {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) && n >= min && n <= max ? n : padrao;
}

// O endereço que vira link de mapa.
//
// Um campo de texto livre, e não rua/número/cidade separados: quem divulga um
// aulão escreve o endereço como diria no WhatsApp, e picá-lo em seis campos
// transformaria trinta segundos de cadastro em um formulário de cartório.
// Quem precisa de precisão põe o link do mapa no próprio texto.
const MAX_ENDERECO = 300;
const MAX_DESCRICAO = 4000;

// ── O SLUG ────────────────────────────────────────────────────────────────
//
// Vai no endereço público (`/aulao/pernas-27-09`), então é derivado do nome e
// legível — um id sorteado faria o link não dizer nada, e link de divulgação é
// lido em voz alta e digitado à mão.
function slugDe(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function limpar(obj) {
  return {
    name: String(obj.name || "").trim().slice(0, 140),
    description: String(obj.description || "").trim().slice(0, MAX_DESCRICAO),
    address: String(obj.address || "").trim().slice(0, MAX_ENDERECO),

    // ── QUANDO ──────────────────────────────────────────────────────────
    //
    // Um INSTANTE, e não data + hora em texto. A página pública de um aulão
    // pode ser aberta de outro fuso, e "08:00" em texto não se compara com
    // "agora" — é a mesma regra de `lib/slots.js`.
    startsAt: obj.startsAt ? new Date(obj.startsAt) : null,
    // Quanto dura, para a tela dizer "08:00 às 09:30" sem um segundo campo de
    // hora que pode discordar do primeiro.
    minutes: inteiroOuPadrao(obj.minutes, 60, { min: 5, max: 24 * 60 }),

    // ── AS VAGAS ────────────────────────────────────────────────────────
    //
    // Zero quer dizer SEM LIMITE, e é a escolha certa para aulão em parque:
    // "quantas vagas?" nem sempre tem resposta. Um `null` aqui seria um
    // terceiro estado para a mesma coisa.
    seats: inteiroOuPadrao(obj.seats, 0, { min: 0, max: 100000 }),

    priceCents: centavos(obj.price ?? obj.priceCents),

    // ── EM QUAL UNIDADE ─────────────────────────────────────────────────
    //
    // *"aulões também, sem respeitar unidade"*. Aqui, ao contrário do insumo,
    // o campo É do aulão: ele acontece num lugar e numa data — é um evento,
    // não um item de catálogo. Dois aulões da mesma casa em unidades
    // diferentes já são dois registros hoje.
    //
    // `null` é legítimo e vale "da casa toda": o aulão na praia não pertence
    // a nenhuma das salas, e é o caso do próprio exemplo que deu origem a
    // este produto.
    unit: ObjectId.isValid(String(obj.unit || "")) ? new ObjectId(String(obj.unit)) : null,

    // Publicado ou rascunho. Nasce RASCUNHO: um aulão sem foto e sem endereço
    // publicado por acidente é divulgação errada, e divulgação não se desfaz.
    published: obj.published === true || Number(obj.published) === 1,

    // ── NA VITRINE DA VAFIT, e por que é uma marca SEPARADA ───────────────
    //
    // `published` abre o aulão no endereço do PRÓPRIO cliente — é ele
    // divulgando na casa dele, para quem ele mandar o link. Aparecer no site da
    // VAFIT é outra coisa: é a gente divulgando o evento dele para
    // desconhecidos, num lugar que ele não escolheu.
    //
    // Derivar uma da outra pareceria conveniente e seria publicar o evento de um
    // cliente sem ele ter pedido. Nome, foto, endereço e horário de uma aula
    // dele num site que não é o dele — e, se o aulão for numa casa ou num
    // estúdio pequeno, o endereço é quase o endereço dele.
    //
    // Então são duas marcas, e esta nasce DESLIGADA. Quem quer aparecer marca.
    showcase: obj.showcase === true || Number(obj.showcase) === 1,

    // ── A CAPA E A GALERIA ──────────────────────────────────────────────
    //
    // As chaves das imagens, não os bytes. A capa é uma; a galeria é a ordem em
    // que elas passam no slider — e a ordem é dado, não detalhe de tela: quem
    // escolheu a foto que abre escolheu a primeira impressão.
    cover: String(obj.cover || "").trim().slice(0, 200) || null,
    gallery: Array.isArray(obj.gallery)
      ? obj.gallery.map((k) => String(k || "").trim()).filter(Boolean).slice(0, 12)
      : [],
  };
}

// ── CRIAR ─────────────────────────────────────────────────────────────────
//
// O slug é gravado UMA vez e nunca muda, mesmo que o nome mude: ele já está num
// link que alguém compartilhou. Renomear o aulão renomeia o título, não o
// endereço.
Aulao_model.prototype.insert = async function (criadoPor, obj) {
  const col = await this.collection();
  const limpo = limpar(obj);

  if (!limpo.name) return { ok: false, erro: "sem_nome" };
  if (!limpo.startsAt || Number.isNaN(limpo.startsAt.getTime())) return { ok: false, erro: "sem_data" };

  const base = slugDe(limpo.name) || "aulao";
  const slug = await this.slugLivre(base);

  const r = await col.insertOne({
    ...limpo,
    slug,
    createdBy: new ObjectId(criadoPor),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { ok: true, id: r.insertedId, slug };
};

// O primeiro slug livre a partir da base. Um laço, e não um `findOne` antes do
// insert, pelo mesmo motivo do alias de afiliado: entre o "está livre?" e o
// "grava" cabe outro cadastro.
Aulao_model.prototype.slugLivre = async function (base) {
  const col = await this.collection();

  for (let i = 0; i < 50; i++) {
    const tentativa = i === 0 ? base : `${base}-${i + 1}`;
    const existe = await col.findOne({ slug: tentativa }, { projection: { _id: 1 } });
    if (!existe) return tentativa;
  }

  // Cinquenta aulões com o mesmo nome. Desiste do legível em vez de estourar.
  return `${base}-${Date.now().toString(36)}`;
};

Aulao_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return { ok: false, erro: "invalido" };
  const col = await this.collection();
  const limpo = limpar(obj);

  if (!limpo.name) return { ok: false, erro: "sem_nome" };
  if (!limpo.startsAt || Number.isNaN(limpo.startsAt.getTime())) return { ok: false, erro: "sem_data" };

  // `slug` de fora do `$set`: ver o comentário do insert.
  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: { ...limpo, updatedAt: new Date() } });
  return r.matchedCount ? { ok: true } : { ok: false, erro: "nao_achei" };
};

Aulao_model.prototype.byId = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

Aulao_model.prototype.bySlug = async function (slug) {
  const s = slugDe(slug);
  if (!s) return undefined;
  const col = await this.collection();
  return (await col.findOne({ slug: s })) || undefined;
};

// A lista para a tela de dentro: os que ainda vão acontecer primeiro, e os
// passados depois — é a ordem em que se pensa numa agenda de eventos.
Aulao_model.prototype.list = async function ({ passados = false, unit } = {}) {
  const col = await this.collection();
  const agora = new Date();

  const filtro = passados ? { startsAt: { $lt: agora } } : { startsAt: { $gte: agora } };

  // A LENTE. Um aulão sem unidade ("da casa toda") NÃO entra no recorte de
  // uma unidade — ele aparece em "Todas", que é onde de fato está. É a mesma
  // leitura da lista de pessoas.
  if (ObjectId.isValid(String(unit || ""))) filtro.unit = new ObjectId(String(unit));
  return col.find(filtro).sort({ startsAt: passados ? -1 : 1 }).toArray();
};

// ── A VITRINE DA VAFIT: OS AULÕES DE TODOS OS CLIENTES ────────────────────
//
// A ÚNICA leitura deste produto que atravessa o escopo de instância de
// propósito. Todas as outras passam por `lib/escopo.js`, que exige o
// `instance` em cada consulta — é ele que impede o dado de um cliente aparecer
// para outro.
//
// ── Por que ela precisa atravessar ────────────────────────────────────────
//
// A pergunta é "quais aulões existem no Brasil", e ela não tem dono. Responder
// dentro do escopo exigiria varrer as instâncias uma por uma, o que é a mesma
// coisa sem o escopo e mais lento.
//
// ── O QUE MANTÉM ISSO SEGURO ──────────────────────────────────────────────
//
// Três filtros, e nenhum é opcional:
//
//   showcase: true    o cliente PEDIU para aparecer. Ver o comentário do campo:
//                     publicar na casa dele não é publicar no nosso site.
//   published: true   não é rascunho.
//   startsAt futuro   aulão que já passou não é oferta.
//
// E um quarto que não está na consulta: as instâncias DESATIVADAS são cortadas
// depois, contra o registro central. Um cliente que saiu do produto não pode
// continuar anunciando pela nossa vitrine — e o registro de quem está ativo
// mora no central, não aqui.
//
// O que sai é só o que vende: nada de lista de inscritos, nada de e-mail, nada
// de id de pessoa.
Aulao_model.prototype.paraVitrine = async function ({ limite = 60 } = {}) {
  // `bancoCruSemEscopo` é a saída de emergência, e o nome é feio de propósito.
  // `test/lib/dbRouting.test.js` lista quem pode chamá-la — este método está lá.
  const db = await this.app.mongodb.bancoCruSemEscopo();

  // ── SÓ OS CLIENTES ATIVOS ─────────────────────────────────────────────
  //
  // No `$match`, e não filtrando depois: é a regra que os outros dois leitores
  // cruzados seguem, e `dbRouting.test.js` confere a presença deste `$in` no
  // fonte. A razão é dupla — um cliente que saiu do produto não pode continuar
  // anunciando pela nossa vitrine, e um cliente APAGADO do registro pode ter
  // deixado documentos para trás, que sem este filtro apareceriam.
  //
  // A lista vem do registro central, que é quem sabe quem está ativo.
  const registros = await this.app.api.center.list();
  const ativos = registros
    .filter((r) => r.active !== false && r.active !== 0)
    .map((r) => r.instance);

  return db
    .collection("aulaoes")
    .find(
      { instance: { $in: ativos }, showcase: true, published: true, startsAt: { $gte: new Date() } },
      {
        // Lista FECHADA de campos, e não o documento: é o que impede um campo
        // novo no aulão de aparecer no site público por acidente.
        projection: {
          instance: 1,
          slug: 1,
          name: 1,
          description: 1,
          address: 1,
          startsAt: 1,
          minutes: 1,
          seats: 1,
          priceCents: 1,
          cover: 1,
        },
      }
    )
    .sort({ startsAt: 1 })
    .limit(Math.min(Number(limite) || 60, 200))
    .toArray();
};

Aulao_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return { ok: false };
  const col = await this.collection();
  const insc = await this.inscricoes();

  // As inscrições vão junto: sem isto elas ficariam apontando para um aulão
  // apagado — nenhuma tela as alcançaria e nada as apagaria depois. É o mesmo
  // lixo permanente que os treinos de pessoa apagada já produziram uma vez.
  await insc.deleteMany({ aulao: new ObjectId(id) });

  // As FOTOS também, e estas custam mais que uma linha de banco: são bytes no
  // R2, que ninguém varre e ninguém cobra de volta. Apagar o aulão sem apagá-las
  // deixaria treze arquivos por aulão no bucket para sempre.
  await this.app.api.aulaoImage.removeAllOf(id);
  const r = await col.deleteOne({ _id: new ObjectId(id) });

  return { ok: r.deletedCount === 1 };
};

// ── AS INSCRIÇÕES ─────────────────────────────────────────────────────────
//
// Uma por pessoa por aulão, e o índice único é quem garante: dois toques no
// botão não podem consumir duas vagas.
Aulao_model.prototype.inscritos = async function (aulaoId) {
  if (!ObjectId.isValid(aulaoId)) return [];
  const insc = await this.inscricoes();
  return insc.find({ aulao: new ObjectId(aulaoId) }).sort({ createdAt: 1 }).toArray();
};

Aulao_model.prototype.contarInscritos = async function (aulaoId) {
  if (!ObjectId.isValid(aulaoId)) return 0;
  const insc = await this.inscricoes();
  return insc.countDocuments({ aulao: new ObjectId(aulaoId) });
};

// A contagem de inscritos de VÁRIOS aulões, numa consulta.
//
// Existe porque a lista da tela mostra "12 de 30 vagas" em cada linha, e uma
// contagem por linha seriam N idas ao banco para desenhar uma tela. É o mesmo
// motivo do `notesMap` dos vínculos.
Aulao_model.prototype.contagemDeTodos = async function (ids) {
  const validos = (ids || []).filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (!validos.length) return {};

  const insc = await this.inscricoes();
  const linhas = await insc
    .aggregate([{ $match: { aulao: { $in: validos } } }, { $group: { _id: "$aulao", n: { $sum: 1 } } }])
    .toArray();

  return Object.fromEntries(linhas.map((l) => [String(l._id), l.n]));
};

// Inscreve uma pessoa. Devolve o que aconteceu, para quem chama decidir se
// cobra e avisa.
//
// ── A VAGA É CONFERIDA AQUI, e não na tela ────────────────────────────────
//
// Duas pessoas tocando no botão no mesmo segundo veriam as duas a última vaga
// livre. Quem decide é o índice único mais esta contagem — e o pior caso é uma
// vaga a mais, não uma vaga vendida duas vezes para a mesma pessoa.
// ── `novaPessoa`: ELA JÁ ERA ALUNA, OU CHEGOU PELO LINK? ─────────────────
//
// *"preciso ver quem se inscreveu e se já é usuário do meu sistema ou não."*
//
// Gravado no momento da inscrição, e não deduzido depois. Quem inscreve SABE a
// resposta — a rota pública acabou de procurar pelo telefone e ou achou ou
// criou. Deduzir mais tarde exigiria comparar a data de criação da pessoa com a
// da inscrição e chutar uma janela de segundos.
//
// É a informação que separa o aluno que já paga do desconhecido que o anúncio
// trouxe. Para quem vende, são duas listas diferentes na mesma tela.
Aulao_model.prototype.inscrever = async function (
  aulaoId,
  personId,
  { origem = "interna", novaPessoa = false } = {}
) {
  const aulao = await this.byId(aulaoId);
  if (!aulao) return { ok: false, erro: "nao_achei" };

  const insc = await this.inscricoes();

  if (aulao.seats > 0) {
    const quantos = await insc.countDocuments({ aulao: new ObjectId(aulaoId) });
    if (quantos >= aulao.seats) return { ok: false, erro: "lotado" };
  }

  try {
    const r = await insc.insertOne({
      aulao: new ObjectId(aulaoId),
      person: new ObjectId(personId),
      origem,
      // Ver o cabeçalho. `Boolean` porque o valor vem de `!existente` na rota
      // pública, e `undefined` no documento faria a tela não saber diferenciar
      // "era aluna" de "não sei".
      novaPessoa: Boolean(novaPessoa),
      createdAt: new Date(),
    });
    return { ok: true, id: r.insertedId, aulao };
  } catch (erro) {
    // 11000 é o índice único: esta pessoa já estava inscrita. Não é falha — é a
    // resposta, e a tela diz "você já está inscrito" em vez de "erro".
    if (erro?.code === 11000) return { ok: false, erro: "ja_inscrito", aulao };
    throw erro;
  }
};

Aulao_model.prototype.desinscrever = async function (aulaoId, personId) {
  if (!ObjectId.isValid(aulaoId) || !ObjectId.isValid(personId)) return { ok: false };
  const insc = await this.inscricoes();
  const r = await insc.deleteOne({ aulao: new ObjectId(aulaoId), person: new ObjectId(personId) });
  return { ok: r.deletedCount === 1 };
};

module.exports = Aulao_model;
module.exports.slugDe = slugDe;
module.exports.centavos = centavos;
module.exports.MAX_DESCRICAO = MAX_DESCRICAO;

// ── PRESENÇA ──────────────────────────────────────────────────────────────
//
// *"senti falta de 'marcar como pago' e 'marcar presença'."*
//
// Mora na INSCRIÇÃO e não numa coleção nova: presença só existe para quem está
// inscrito, e uma coleção à parte criaria a pergunta "presente em quê?" para
// linhas sem inscrição correspondente.
//
// Três estados e não dois. `undefined` é "ninguém conferiu ainda", que é
// diferente de "faltou" — e a diferença importa no dia seguinte, quando se olha
// a lista para cobrar quem não foi: marcar todo mundo como ausente por omissão
// acusaria de falta quem o professor simplesmente não chamou.
Aulao_model.prototype.marcarPresenca = async function (aulaoId, personId, presente) {
  if (!ObjectId.isValid(aulaoId) || !ObjectId.isValid(personId)) {
    return { ok: false, erro: "nao_achei" };
  }

  const insc = await this.inscricoes();

  // `null` limpa a marca — é como se desfaz um clique errado sem ter de escolher
  // entre presente e ausente.
  const valor = presente === null ? undefined : Boolean(presente);

  const r = await insc.updateOne(
    { aulao: new ObjectId(aulaoId), person: new ObjectId(personId) },
    valor === undefined
      ? { $unset: { presente: "", presenteEm: "" }, $set: { updatedAt: new Date() } }
      : { $set: { presente: valor, presenteEm: new Date(), updatedAt: new Date() } }
  );

  if (!r.matchedCount) return { ok: false, erro: "nao_inscrito" };
  return { ok: true, presente: valor };
};

// ── DUPLICAR UM AULÃO ─────────────────────────────────────────────────────
//
// *"bote opção de duplicar, aí eu só preencho a nova data e hora."*
//
// Aula que deu certo se repete: mesma praia, mesmo preço, mesmas vagas, mesmo
// texto de divulgação com os emojis todos. O que muda é a data — e era isso que
// obrigava a redigitar doze campos e reenviar seis fotos.
//
// ── NASCE RASCUNHO, SEMPRE ────────────────────────────────────────────────
//
// `published: false` e `showcase: false`, mesmo que o original fosse os dois.
//
// Porque a data ainda é a ANTIGA neste instante: o modelo exige `startsAt`, e
// criar sem data não é possível. Uma cópia publicada seria, por alguns segundos,
// um aulão no ar anunciando a data da semana passada — e se a vitrine estivesse
// ligada, no site da VAFIT.
//
// Rascunho, o link não abre (a rota pública recusa o que não está publicado) e
// nada vaza enquanto a pessoa corrige a data.
//
// ── O QUE NÃO VEM ─────────────────────────────────────────────────────────
//
// As INSCRIÇÕES. Quem estava na aula de setembro não está na de outubro, e
// trazê-las criaria cobranças para gente que não se inscreveu — dinheiro
// cobrado de quem não comprou, que é o pior erro que este módulo pode cometer.
Aulao_model.prototype.duplicar = async function (criadoPor, id, { nome } = {}) {
  const original = await this.byId(id);
  if (!original) return { ok: false, erro: "nao_achei" };

  const escolhido = String(nome || "").trim();

  const feito = await this.insert(criadoPor, {
    name: escolhido || original.name,
    description: original.description,
    address: original.address,
    // A data do original, como marcador: é a que a pessoa vai trocar. Ver o
    // cabeçalho sobre por que a cópia nasce rascunho por causa disto.
    startsAt: original.startsAt,
    minutes: original.minutes,
    seats: original.seats,
    priceCents: original.priceCents,
    published: false,
    showcase: false,
  });

  if (!feito.ok) return feito;

  // ── AS FOTOS, em cópias próprias ────────────────────────────────────────
  //
  // Ver `AulaoImage.copiarPara`: copiar os IDS faria apagar o original levar as
  // fotos da cópia junto, e a página pública mostraria quadrados vazios.
  const mapa = await this.app.api.aulaoImage.copiarPara(original._id, feito.id);

  if (mapa.size) {
    const col = await this.collection();
    await col.updateOne(
      { _id: feito.id },
      {
        $set: {
          // A ORDEM da galeria é preservada, e a capa continua sendo a mesma
          // foto — `mapa` traduz cada id antigo no novo.
          gallery: (original.gallery || []).map((x) => mapa.get(String(x))).filter(Boolean),
          cover: mapa.get(String(original.cover)) || null,
          updatedAt: new Date(),
        },
      }
    );
  }

  return { ok: true, id: feito.id, slug: feito.slug };
};
