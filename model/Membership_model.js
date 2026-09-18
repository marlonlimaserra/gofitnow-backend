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
//     beneficios: [id], destaque, active, order }
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
// Agora eles apontam para o CATÁLOGO (`membership_benefits`), e "não" é
// ausência: o que não está na lista sai com o "×" cinza.
//
// O nome voltou a ser `beneficios` em 17/09/2026, por pedido dele — e é o certo:
// é a palavra que a própria tabela usa ("Compare os benefícios de cada plano").
// Nasceu `categorias` porque foi assim que ele descreveu a aba na primeira vez.
const MAX_BENEFICIOS = 60;

function beneficios(v) {
  if (!Array.isArray(v)) return [];

  const vistos = new Set();
  const saida = [];

  for (const x of v) {
    const id = String(x || "");
    if (!ObjectId.isValid(id) || vistos.has(id)) continue;
    vistos.add(id);
    saida.push(new ObjectId(id));
    if (saida.length >= MAX_BENEFICIOS) break;
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
  beneficios,
  // O "Mais vantajoso" da vitrine. Mais de um destaque não destaca nada, e quem
  // garante isso é a gravação — ver `insert` e `update`.
  destaque: (v) => v === true,
  active: (v) => v !== false,
  // ── A CAPA: só o ID, nunca a URL ────────────────────────────────────────
  //
  // A tela manda o endereço que recebeu do upload; aqui fica só o id. Guardar a
  // URL inteira prenderia o plano ao endereço do backend do dia em que a foto
  // subiu — e este sistema já mudou de endereço uma vez.
  //
  // `""` é uma EDIÇÃO: tirar a capa é uma escolha, e precisa ser gravável.
  cover: (v) => {
    const id = String(v || "").split("/").pop();
    return ObjectId.isValid(id) ? new ObjectId(id) : null;
  },
};

// A lista da TELA. Rascunho fica de fora: ele é um plano que alguém começou e
// não terminou, e uma linha vazia no meio do cardápio é confusão sem nenhum
// ganho. Quem o abandonou não vai procurá-lo.
Membership_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({ rascunho: { $ne: true } }).sort({ order: 1, createdAt: 1 }).toArray();
};

// A lista da VITRINE. `active: true` já exclui o rascunho, que nasce falso — o
// filtro extra está aqui para dizer, e não porque precisa.
Membership_model.prototype.listActive = async function () {
  const col = await this.collection();
  return col
    .find({ active: true, rascunho: { $ne: true } })
    .sort({ order: 1, createdAt: 1 })
    .toArray();
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
  await this.recolherCapas(r.insertedId, doc.cover);

  return r.insertedId;
};

// As capas que o plano NÃO usa mais.
//
// Roda em toda gravação e não só quando a capa muda: quem trocou a foto três
// vezes antes de salvar enviou três, e duas ficariam penduradas no bucket para
// sempre. O dono da verdade é o plano salvo.
//
// Nunca estoura: é faxina, e faxina que falha não pode impedir alguém de salvar
// um plano. A próxima gravação tenta de novo.
Membership_model.prototype.recolherCapas = async function (id, cover) {
  try {
    await this.app.api.membershipImage.pruneUnused(id, cover ? [String(cover)] : []);
  } catch (erro) {
    console.error("[planos] faxina de capa:", erro?.message || erro);
  }
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

  // Gravar TIRA o carimbo: a partir daqui ele é um plano como outro qualquer, e
  // a faxina de rascunhos abandonados não pode mais alcançá-lo.
  mudanca.rascunho = false;

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  if (mudanca.destaque) await this.apenasUmDestaque(id);

  // A faxina olha o que ficou GRAVADO, e não o que veio na chamada: uma edição
  // que não menciona a capa mantém a de antes, e apagá-la aqui seria o mesmo
  // erro destrutivo do `updateCharge`.
  const depois = await col.findOne({ _id: new ObjectId(id) }, { projection: { cover: 1 } });
  await this.recolherCapas(id, depois?.cover);

  return r.matchedCount > 0;
};

// ── O RASCUNHO ───────────────────────────────────────────────────────────
//
// Nasce vazio e FORA DE VENDA, no clique de "Novo plano" — antes de a pessoa
// digitar qualquer coisa.
//
// Pedido dele, e ele está certo sobre o porquê: *"quando clicar em criar você já
// pode criar um rascunho, assim já deixa enviar a foto. A mesma coisa no aulão,
// precisar criar pra depois editar e mandar a foto é ruim"*.
//
// A foto pertence a UM plano — a rota é `/memberships/:id/cover` — e um plano
// que não existe não tem id. Sem o rascunho, as saídas eram esconder o campo de
// capa até salvar (e capa é a PRIMEIRA coisa que se escolhe, não a última) ou
// aceitar imagem solta, que criaria bytes sem dono que a faxina nunca alcança.
//
// O preço é o rascunho abandonado: quem abre e fecha deixa um plano vazio. Dois
// cuidados cobrem isso — ele nasce `active: false`, então nunca chega à vitrine;
// e a tela APAGA o que abriu e não salvou.
Membership_model.prototype.rascunho = async function (currency) {
  const col = await this.collection();

  const r = await col.insertOne({
    name: "",
    description: "",
    amount: 0,
    currency: currency || null,
    cadencia: recorrencia.PADRAO,
    fidelidadeMeses: 0,
    beneficios: [],
    cover: null,
    destaque: false,
    active: false,
    // `rascunho` é o que separa "nunca foi salvo" de "salvo e fora de venda".
    // Sem ele não haveria como apagar o abandonado sem apagar o desativado de
    // propósito — e os dois parecem iguais no banco.
    rascunho: true,
    order: await col.countDocuments({}),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// ── CLONAR ───────────────────────────────────────────────────────────────
//
// *"bote um botão para clonar"*, e o pedido cai no lugar certo: os planos de uma
// academia são quase o mesmo plano. O "Fit" é o "Black" sem duas linhas, o
// "Smart" é o "Fit" sem mais uma. Montar o terceiro do zero é remarcar oito
// benefícios para mudar um.
//
// A cópia nasce FORA DE VENDA e SEM DESTAQUE, e as duas coisas são de propósito:
//
//   fora de venda   ela é um rascunho — "Black (cópia)" na vitrine, com o mesmo
//                   preço do Black, é o tipo de coisa que alguém publica sem
//                   querer e descobre pelo cliente.
//   sem destaque    destaque é único por conta; clonar o destacado tiraria o
//                   selo do original sem ninguém pedir.
//
// ── A LISTA É COPIADA, mas NÃO com `structuredClone` ────────────────────
//
// Copiar é necessário: sem isso as duas apontariam para o mesmo array, e marcar
// um benefício na cópia marcaria no original.
//
// Mas `structuredClone` DESTRÓI ObjectId — ele vira um objeto comum, sem a
// classe, e a lista da cópia deixa de casar com benefício nenhum. Foi o que o
// teste pegou: `[object Object]` no lugar do id. O treino usa `structuredClone`
// e está certo lá, porque o que ele copia são séries, que são dados puros.
//
// Aqui basta copiar o ARRAY: ObjectId é valor imutável, e o risco de aliasing
// era do array, não dos ids dentro dele.
Membership_model.prototype.duplicate = async function (id) {
  const origem = await this.data(id);
  if (!origem) return undefined;

  const col = await this.collection();

  const r = await col.insertOne({
    name: `${origem.name} (cópia)`,
    description: origem.description || "",
    amount: origem.amount || 0,
    currency: origem.currency || null,
    cadencia: origem.cadencia,
    fidelidadeMeses: origem.fidelidadeMeses || 0,
    beneficios: [...(origem.beneficios || [])],
    // A CAPA NÃO É COPIADA, e é a única coisa que fica de fora.
    //
    // Duas linhas apontando para a MESMA imagem fariam a faxina de uma apagar a
    // foto da outra: o dono da verdade é cada plano, e o da cópia não referencia
    // nada até alguém enviar. Clonar os bytes seria a alternativa, e ninguém
    // quer três cópias do mesmo JPEG no bucket para ver a mesma foto.
    cover: null,
    destaque: false,
    active: false,
    order: await col.countDocuments({}),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
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
  // Sem isto os bytes ficariam no bucket apontando para um plano que não existe:
  // nenhuma tela os alcançaria e nada os apagaria depois.
  await this.app.api.membershipImage.removeAllOf(id).catch(() => {});

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
module.exports.MAX_BENEFICIOS = MAX_BENEFICIOS;
