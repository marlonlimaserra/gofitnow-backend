const { ObjectId } = require("mongodb");

// OS GRUPOS DE CAMPOS — as gavetas da ficha.
//
// *"gostaria de poder separar os campos por grupo, aí dentro do cliente abria
// algo parecido com isso com os campos dentro"* (01/10/2026), com a tela de um
// CRM mostrando dez sanfonas: Principal (36 campos), Pessoal (7), Qualificação
// (22), Assinatura (33)…
//
// ── POR QUE ELES PRECISAM EXISTIR DE VERDADE ───────────────────────────
//
// O grupo nasceu como TEXTO LIVRE no campo (`grupo: "principal"`), e isso
// aguenta três campos. Não aguenta trinta: "Pessoal", "pessoal" e "Dados
// pessoais" viram três gavetas, e a ficha abre com três sanfonas quase vazias
// em vez de uma cheia. É o mesmo motivo que fez a categoria de conta a pagar
// ser lista fechada.
//
// Com cadastro, o grupo ganha o que a tela precisa e o texto livre nunca teria:
// COR e ÍCONE (numa ficha com dez sanfonas, é a cor que encontra, não a
// leitura) e ORDEM (a gaveta que a casa abre todo dia tem de ser a primeira).
//
// ── `key` É A CHAVE, E NÃO O `_id` ──────────────────────────────────────
//
// O campo guarda `grupo: "pessoal"`, e não um ObjectId. Dois motivos: a
// exportação sai legível, e um grupo apagado por engano volta recriando com o
// mesmo nome — com id, voltaria como outro grupo e os campos continuariam
// órfãos.
function CustomFieldGroup_model(app) {
  this.app = app;
}

CustomFieldGroup_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("custom_field_groups");
};

// O grupo que sempre existe. Um campo sem gaveta não tem onde ser desenhado, e
// obrigar a criar um grupo antes do primeiro campo seria cobrar duas telas por
// uma pergunta.
const PADRAO = "principal";

// ── A COR É HEX, E NÃO UM NOME ──────────────────────────────────────────
//
// *"bote select de cor custom também, para eu escolher o #"* (01/10/2026).
//
// Ela nasceu como uma lista de oito nomes ("slate", "rose"), e a razão era
// técnica: as classes do Tailwind precisam estar escritas INTEIRAS no código —
// `bg-${cor}-100` montado em tempo de execução não existe no CSS final, e a
// gaveta sairia sem cor nenhuma.
//
// Guardando HEX, o problema some pela raiz: o selo passa a ser pintado por
// estilo em linha, e aí qualquer cor funciona. A casa que quer a cor da marca
// dela na gaveta "Assinatura" não precisa que eu adivinhe qual é.
//
// Os oito nomes continuam ACEITOS na entrada e viram hex na gravação: os
// grupos criados antes disto têm nome gravado, e recusá-los agora apagaria a
// cor deles.
const PALETA = {
  slate: "#64748b",
  blue: "#3b82f6",
  emerald: "#10b981",
  amber: "#f59e0b",
  violet: "#8b5cf6",
  rose: "#f43f5e",
  cyan: "#06b6d4",
  lime: "#84cc16",
};

const COR_PADRAO = PALETA.slate;
const CORES = Object.keys(PALETA);

// `#abc` vira `#aabbcc`, maiúscula vira minúscula, e o que não é cor vira o
// padrão — nunca vazio: um selo sem cor some do fundo branco.
function corValida(v) {
  const bruto = String(v || "").trim();
  if (PALETA[bruto]) return PALETA[bruto];

  const limpo = bruto.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(limpo)) return COR_PADRAO;

  const cheio = limpo.length === 3 ? limpo.split("").map((c) => c + c).join("") : limpo;
  return "#" + cheio;
}

function chaveDe(texto) {
  const limpo = String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  return limpo;
}

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 40),
  cor: (v) => corValida(v),
  icone: (v) => String(v || "").trim().slice(0, 40),
  ordem: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
};

function limpar(obj, { parcial = false } = {}) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (parcial && obj[campo] === undefined) continue;
    saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

CustomFieldGroup_model.prototype.list = async function () {
  const col = await this.collection();
  return col.find({}).collation({ locale: "pt" }).sort({ ordem: 1, name: 1 }).toArray();
};

CustomFieldGroup_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(String(id)) })) || undefined;
};

CustomFieldGroup_model.prototype.insert = async function (obj) {
  const doc = limpar(obj);
  if (!doc.name) return { erro: "sem_nome" };

  const key = chaveDe(obj.key || doc.name);
  if (!key) return { erro: "sem_nome" };

  const col = await this.collection();
  if (await col.findOne({ key })) return { erro: "em_uso" };

  const r = await col.insertOne({ ...doc, key, createdAt: new Date(), updatedAt: new Date() });
  return { id: r.insertedId };
};

CustomFieldGroup_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return { erro: "nao_encontrado" };

  const col = await this.collection();
  const antes = await col.findOne({ _id: new ObjectId(String(id)) });
  if (!antes) return { erro: "nao_encontrado" };

  const set = limpar(obj, { parcial: true });
  if (set.name !== undefined && !set.name) return { erro: "sem_nome" };

  // A CHAVE NÃO MUDA, pelo mesmo motivo do alias de um campo: os campos
  // apontam para ela. Renomear a gaveta é mexer em `name`, que é o que se lê.
  await col.updateOne({ _id: antes._id }, { $set: { ...set, updatedAt: new Date() } });
  return { id: antes._id };
};

// ── APAGAR UM GRUPO NÃO APAGA OS CAMPOS ─────────────────────────────────
//
// Eles voltam para o `principal`. A alternativa — recusar enquanto houver campo
// dentro — obrigaria a mover trinta campos à mão antes de arrumar uma gaveta,
// e a alternativa pior apagaria os trinta junto com a gaveta.
//
// O `principal` não se apaga: é para onde todo mundo cai.
CustomFieldGroup_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return { erro: "nao_encontrado" };

  const col = await this.collection();
  const alvo = await col.findOne({ _id: new ObjectId(String(id)) });
  if (!alvo) return { erro: "nao_encontrado" };
  if (alvo.key === PADRAO) return { erro: "padrao" };

  const db = await this.app.mongodb.connectToServer();
  const r = await db
    .collection("custom_fields")
    .updateMany({ grupo: alvo.key }, { $set: { grupo: PADRAO, updatedAt: new Date() } });

  await col.deleteOne({ _id: alvo._id });

  return { ok: true, movidos: r.modifiedCount || 0 };
};

// ── A ORDEM, GRAVADA DE UMA VEZ ─────────────────────────────────────────
//
// *"permita reordenar, assim no cadastro do cliente abre na ordem"*
// (02/10/2026).
//
// Uma chamada com a lista inteira, e não um `PUT` por gaveta. Arrastar a
// última para o topo move TODAS as outras uma casa: em chamadas separadas
// seriam nove requisições, e qualquer uma que falhasse deixaria a ordem
// pela metade — com duas gavetas no mesmo número, que é uma ordem que não
// existe.
//
// A posição é recalculada aqui (10, 20, 30…) e não vem da tela: o espaço entre
// elas é o que deixa um grupo novo nascer no fim sem reescrever ninguém.
CustomFieldGroup_model.prototype.reordenar = async function (ids) {
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

  // `bulkWrite` e não um laço: é uma ida ao banco, e o escopo do cliente é
  // injetado em cada operação por `lib/escopo.js`.
  await col.bulkWrite(operacoes);

  return { ok: true, quantos: operacoes.length };
};

// Roda a cada boot, como os papéis do sistema. Só escreve o que falta.
CustomFieldGroup_model.prototype.semear = async function () {
  const col = await this.collection();
  if (await col.findOne({ key: PADRAO })) return { criados: 0 };

  await col.insertOne({
    // Sem `name`: o rótulo sai da tradução de quem abre, como nos campos
    // nativos. Renomeou, o nome dela vence.
    name: "",
    rotuloPadrao: "customFields.group.principal",
    key: PADRAO,
    cor: COR_PADRAO,
    icone: "User",
    ordem: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { criados: 1 };
};

module.exports = CustomFieldGroup_model;
module.exports.PADRAO = PADRAO;
module.exports.CORES = CORES;
module.exports.PALETA = PALETA;
module.exports.COR_PADRAO = COR_PADRAO;
module.exports.corValida = corValida;
module.exports.chaveDe = chaveDe;
