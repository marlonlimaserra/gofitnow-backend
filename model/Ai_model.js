const { ObjectId } = require("mongodb");
const ai = require("../lib/ai.js");

// A configuração do assistente: a chave da Anthropic e o modelo.
//
// Mora no documento do TENANT, junto da moeda, e pelo mesmo motivo: é
// característica do negócio, não preferência de quem está logado. Dois
// profissionais da mesma clínica com chaves diferentes seriam duas faturas para
// o mesmo cliente.
//
// E mora no documento do DONO da instância — o profissional mais antigo —, não
// no de quem salvou. A moeda escreve no documento de quem salva e lê no do dono,
// e isso só funciona enquanto quem salva é o dono; aqui as duas pontas apontam
// para o mesmo lugar de propósito, para não existir configuração salva e
// invisível.
function Ai_model(app) {
  this.app = app;
}

Ai_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("tenants");
};

// De quem é o documento da instância. É o mesmo critério de
// `Tenant_model#dataOfInstance`: a conta criada quando o cliente foi
// provisionado, o dono do negócio.
Ai_model.prototype.ownerId = async function () {
  const users = await this.app.api.user.collection();
  const dono = await users.findOne({ type: "trainer" }, { sort: { createdAt: 1 } });
  return dono?._id;
};

// A chave NUNCA volta inteira para a tela. Só o bastante para quem configurou
// reconhecer qual é — que é a única pergunta que a tela precisa responder.
//
// Ao contrário das chaves de API do próprio GoFitNow, esta é guardada como veio:
// ela precisa ser ENVIADA para a Anthropic a cada chamada, e um hash não pode
// ser desfeito. Por isso ela não sai daqui em resposta nenhuma.
Ai_model.prototype.hint = function (key) {
  const texto = String(key || "");
  if (texto.length < 12) return "";
  return texto.slice(0, 7) + "…" + texto.slice(-4);
};

// O que a tela recebe: se está configurado, qual modelo, e a dica da chave.
Ai_model.prototype.settings = async function () {
  const id = await this.ownerId();
  if (!id) return { configured: false, model: ai.DEFAULT_MODEL, hint: "" };

  const col = await this.collection();
  const doc = await col.findOne({ user: new ObjectId(id) });
  const guardado = doc?.ai || {};

  const provider = ai.normalizeProvider(guardado.provider);

  return {
    provider,
    // "Configurado" quer dizer coisas diferentes conforme quem responde: a
    // Anthropic precisa de chave, o Ollama precisa de endereço.
    configured:
      provider === "ollama" ? Boolean(guardado.baseUrl && guardado.model) : Boolean(guardado.key),
    model: ai.normalizeModel(guardado.model, provider),
    baseUrl: guardado.baseUrl || "",
    hint: this.hint(guardado.key),
    // O modo conversa é um EIXO SEPARADO: dá para escrever com o Claude e falar
    // com o Realtime. A chave dele também nunca volta inteira.
    realtime: {
      configured: Boolean(guardado.realtimeKey),
      hint: this.hint(guardado.realtimeKey),
      model: ai.normalizeRealtimeModel(guardado.realtimeModel),
      voice: ai.normalizeVoice(guardado.realtimeVoice),
    },
  };
};

// A chave da OpenAI, para quem vai criar a sessão efêmera. Só o controller usa.
Ai_model.prototype.realtimeCredentials = async function () {
  const id = await this.ownerId();
  if (!id) return null;

  const col = await this.collection();
  const doc = await col.findOne({ user: new ObjectId(id) });
  const guardado = doc?.ai;
  if (!guardado?.realtimeKey) return null;

  return {
    key: guardado.realtimeKey,
    model: ai.normalizeRealtimeModel(guardado.realtimeModel),
    voice: ai.normalizeVoice(guardado.realtimeVoice),
  };
};

// A chave de verdade, para quem vai chamar a Anthropic. Só o controller usa.
Ai_model.prototype.credentials = async function () {
  const id = await this.ownerId();
  if (!id) return null;

  const col = await this.collection();
  const doc = await col.findOne({ user: new ObjectId(id) });
  const guardado = doc?.ai;
  if (!guardado) return null;

  const provider = ai.normalizeProvider(guardado.provider);
  const model = ai.normalizeModel(guardado.model, provider);

  if (provider === "ollama") {
    if (!guardado.baseUrl || !model) return null;
    return { provider, baseUrl: guardado.baseUrl, model };
  }

  if (!guardado.key) return null;
  return { provider, key: guardado.key, model };
};

// Salvar.
//
// `key` em branco significa MANTER a que está — a tela nunca recebe a chave de
// volta, então um formulário que reenvia o campo vazio estaria apagando o que a
// pessoa não pediu para apagar. Para tirar de verdade existe `remove`.
Ai_model.prototype.save = async function (entrada) {
  const id = await this.ownerId();
  if (!id) return null;

  const col = await this.collection();
  const provider = ai.normalizeProvider(entrada?.provider);

  const set = {
    "ai.provider": provider,
    "ai.model": ai.normalizeModel(entrada?.model, provider),
    "ai.updatedAt": new Date(),
  };

  // O endereço do Ollama já chega conferido pelo controller.
  if (provider === "ollama") set["ai.baseUrl"] = String(entrada?.baseUrl || "");

  const chave = String(entrada?.key || "").trim();
  if (chave) set["ai.key"] = chave;

  // O modo conversa vem no mesmo salvar, e segue a mesma regra da chave: em
  // branco significa MANTER, não apagar.
  if (entrada?.realtimeModel !== undefined) {
    set["ai.realtimeModel"] = ai.normalizeRealtimeModel(entrada.realtimeModel);
  }
  if (entrada?.realtimeVoice !== undefined) {
    set["ai.realtimeVoice"] = ai.normalizeVoice(entrada.realtimeVoice);
  }

  const chaveVoz = String(entrada?.realtimeKey || "").trim();
  if (chaveVoz) set["ai.realtimeKey"] = chaveVoz;

  await col.updateOne(
    { user: new ObjectId(id) },
    { $set: { ...set, updatedAt: new Date() }, $setOnInsert: { user: new ObjectId(id), status: "none", createdAt: new Date() } },
    { upsert: true }
  );

  return this.settings();
};

Ai_model.prototype.remove = async function () {
  const id = await this.ownerId();
  if (!id) return null;

  const col = await this.collection();
  await col.updateOne({ user: new ObjectId(id) }, { $unset: { "ai.key": "" }, $set: { updatedAt: new Date() } });

  return this.settings();
};

module.exports = Ai_model;
