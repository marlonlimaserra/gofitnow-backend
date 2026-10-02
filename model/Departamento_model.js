const { ObjectId } = require("mongodb");

// OS DEPARTAMENTOS — Financeiro, Vendas, Suporte.
//
// *"em administração crie 'departamentos' para a gente criar departamento
// financeiro, vendas, suporte etc… vamos usar isso em breve no chat"*
// (02/10/2026).
//
// ── POR QUE ISTO NÃO É UM TIPO DE USUÁRIO ──────────────────────────────
//
// A conta já tem "Tipos de usuário" (papéis) e "Grupos de permissão", e os dois
// respondem a mesma pergunta: **o que esta pessoa PODE fazer**. Departamento
// responde outra, que hoje não tem lugar: **por onde o assunto entra**.
//
// A diferença fica óbvia no chat, que é para onde isto vai: duas pessoas podem
// ter exatamente a mesma permissão e atender filas diferentes — uma responde
// cobrança, a outra responde dúvida de treino. E a mesma pessoa pode atender as
// duas. Guardar isso no papel obrigaria a criar "Atendente do Financeiro" e
// "Atendente do Suporte" com permissões idênticas, só para separar fila.
//
// ── O QUE ELE AINDA NÃO TEM, E POR QUÊ ─────────────────────────────────
//
// MEMBROS. Um departamento sem gente não roteia nada — mas a forma de "quem
// atende" depende de uma decisão do chat que ainda não foi tomada: é uma lista
// de usuários? é um grupo de permissão? é quem está on-line no momento? Inventar
// agora a estrutura errada custaria uma migração depois, e o cadastro já serve
// para o que ele pediu: existir, com nome, cor e ordem.
function Departamento_model(app) {
  this.app = app;
}

Departamento_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("departments");
};

const COR_PADRAO = "#64748b";

// A mesma regra de cor das gavetas de campos: hex, porque o selo é pintado em
// linha — classe do Tailwind montada em tempo de execução não existe no CSS
// final. Ver `lib/corDoGrupo.js` no painel.
function corValida(v) {
  const limpo = String(v || "").trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(limpo)) return COR_PADRAO;
  const cheio = limpo.length === 3 ? limpo.split("").map((c) => c + c).join("") : limpo;
  return "#" + cheio;
}

function chaveDe(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 60),
  // PARA QUE SERVE, em uma linha. Numa conta com oito departamentos, "Suporte"
  // e "Atendimento" são a mesma palavra para quem chegou esta semana — e é a
  // descrição que diz qual é qual.
  descricao: (v) => String(v || "").trim().slice(0, 200),
  cor: (v) => corValida(v),
  icone: (v) => String(v || "").trim().slice(0, 40),
  ordem: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
  // DESATIVADO em vez de apagado: o departamento vai carimbar conversa, e uma
  // conversa de março não pode apontar para um departamento que sumiu. Quem
  // parou de usar, desliga — e o histórico continua legível.
  ativo: (v) => v !== false,
};

// ── QUEM FAZ PARTE ──────────────────────────────────────────────────────
//
// *"faltou poder escolher quais usuários do sistema fazem parte desse
// departamento"* (02/10/2026).
//
// É a peça que faltava para o chat poder rotear: sem gente, o departamento é
// um rótulo. Com ela, "esta conversa é do Financeiro" passa a ter uma resposta
// para "então quem atende?".
//
// Uma LISTA DE IDS no documento do departamento, e não um campo no usuário.
// A pergunta que se faz o tempo todo é "quem atende esta fila?" — e ela se
// responde abrindo um documento. A inversa ("de quais filas eu faço parte?")
// acontece uma vez por login, e um `$in` resolve.
//
// E a mesma pessoa pode estar em vários: o professor que também cobra. Guardar
// no usuário forçaria um campo de lista lá, com o mesmo problema e mais longe
// de quem o lê.
function membrosValidos(bruto) {
  if (!Array.isArray(bruto)) return [];

  const vistos = new Set();
  const saida = [];

  // Cem é teto de sanidade, não regra de negócio: um departamento com cem
  // atendentes é uma lista que ninguém escolheu a dedo — é alguém mandando o
  // banco inteiro num pedido feito à mão.
  for (const id of bruto.slice(0, 100)) {
    const texto = String(id || "");
    if (!ObjectId.isValid(texto) || vistos.has(texto)) continue;
    vistos.add(texto);
    saida.push(new ObjectId(texto));
  }

  return saida;
}

function limpar(obj, { parcial = false } = {}) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (parcial && obj[campo] === undefined) continue;
    saida[campo] = tratar(obj[campo]);
  }
  if (!parcial || obj.membros !== undefined) saida.membros = membrosValidos(obj.membros);
  return saida;
}

// Os que SOBRARAM: quem foi apagado da conta sai da lista.
//
// Guardar o id de alguém que não existe mais não quebra nada hoje — a tela
// simplesmente não acha o nome —, mas no chat viraria uma fila com um
// atendente fantasma, e ninguém saberia por que a conversa não é respondida.
Departamento_model.prototype.filtrarMembros = async function (ids) {
  if (!Array.isArray(ids) || !ids.length) return [];

  const db = await this.app.mongodb.connectToServer();
  const achados = await db
    .collection("users")
    // `type: "trainer"` porque departamento é divisão da EQUIPE. Um aluno
    // dentro do Financeiro seria um erro de clique com consequência no chat.
    .find({ _id: { $in: ids }, type: "trainer" }, { projection: { _id: 1 } })
    .toArray();

  return achados.map((u) => u._id);
};

Departamento_model.prototype.list = async function ({ ativos = false } = {}) {
  const col = await this.collection();
  const filtro = ativos ? { ativo: { $ne: false } } : {};
  return col.find(filtro).collation({ locale: "pt" }).sort({ ordem: 1, name: 1 }).toArray();
};

Departamento_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(String(id)) })) || undefined;
};

Departamento_model.prototype.insert = async function (obj) {
  const doc = limpar(obj);
  if (!doc.name) return { erro: "sem_nome" };

  // ── A CHAVE, E POR QUE ELA EXISTE ──────────────────────────────────────
  //
  // `financeiro`, e não o `_id`. É ela que a conversa vai carimbar e que uma
  // integração vai mandar — legível na exportação, e estável: um departamento
  // apagado por engano volta recriando com o mesmo nome, e as conversas antigas
  // o encontram de novo. Com id, voltaria como outro e o histórico ficaria órfão.
  const key = chaveDe(obj.key || doc.name);
  if (!key) return { erro: "sem_nome" };

  const col = await this.collection();
  if (await col.findOne({ key })) return { erro: "em_uso" };

  doc.membros = await this.filtrarMembros(doc.membros);

  const r = await col.insertOne({ ...doc, key, createdAt: new Date(), updatedAt: new Date() });
  return { id: r.insertedId };
};

Departamento_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return { erro: "nao_encontrado" };

  const col = await this.collection();
  const antes = await col.findOne({ _id: new ObjectId(String(id)) });
  if (!antes) return { erro: "nao_encontrado" };

  const set = limpar(obj, { parcial: true });
  if (set.name !== undefined && !set.name) return { erro: "sem_nome" };

  if (set.membros !== undefined) set.membros = await this.filtrarMembros(set.membros);

  // A CHAVE não muda: é ela que a conversa carimba. Renomear é mexer no `name`,
  // que é o que se lê na tela.
  await col.updateOne({ _id: antes._id }, { $set: { ...set, updatedAt: new Date() } });
  return { id: antes._id };
};

Departamento_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(String(id)) });
  return r.deletedCount > 0;
};

// ── A MESMA LISTA, EDITADA PELO OUTRO LADO ──────────────────────────────
//
// *"coloque para poder escolher os departamentos aqui também"* (02/10/2026),
// no cadastro do usuário.
//
// A tentação é guardar `departamentos` no documento do usuário e pronto. Isso
// cria DUAS verdades sobre a mesma coisa — a lista no departamento e a lista
// no usuário — e elas divergem no primeiro lugar que escrever só uma. É o
// defeito clássico de relação mantida nos dois lados.
//
// Então o armazenamento continua UM: `membros`, no departamento. Editar pelo
// usuário é sincronizar essa lista — entra onde foi marcado, sai de onde não
// foi.
//
// Duas escritas e não uma por departamento: são dois `updateMany`,
// independentes do tamanho da conta.
Departamento_model.prototype.definirDoUsuario = async function (userId, ids) {
  if (!ObjectId.isValid(userId)) return { ok: false };

  const alvo = new ObjectId(String(userId));
  const escolhidos = membrosValidos(ids);

  const col = await this.collection();

  if (escolhidos.length) {
    await col.updateMany(
      { _id: { $in: escolhidos } },
      { $addToSet: { membros: alvo }, $set: { updatedAt: new Date() } }
    );
  }

  // Sai de todos os OUTROS. Sem este segundo passo, desmarcar não desmarcaria
  // nada — só marcar funcionaria, e a lista cresceria para sempre.
  await col.updateMany(
    { _id: { $nin: escolhidos }, membros: alvo },
    { $pull: { membros: alvo }, $set: { updatedAt: new Date() } }
  );

  return { ok: true, quantos: escolhidos.length };
};

// A ordem, gravada de uma vez — mesma razão das gavetas de campos: arrastar o
// último para o topo move todos uma casa, e em chamadas separadas qualquer
// falha deixaria dois no mesmo número.
Departamento_model.prototype.reordenar = async function (ids) {
  if (!Array.isArray(ids) || !ids.length) return { ok: false };

  const col = await this.collection();
  const operacoes = ids
    .filter((id) => ObjectId.isValid(id))
    .map((id, i) => ({
      updateOne: {
        filter: { _id: new ObjectId(String(id)) },
        update: { $set: { ordem: (i + 1) * 10, updatedAt: new Date() } },
      },
    }));

  if (!operacoes.length) return { ok: false };

  await col.bulkWrite(operacoes);
  return { ok: true, quantos: operacoes.length };
};

module.exports = Departamento_model;
module.exports.COR_PADRAO = COR_PADRAO;
module.exports.corValida = corValida;
module.exports.chaveDe = chaveDe;
module.exports.membrosValidos = membrosValidos;
