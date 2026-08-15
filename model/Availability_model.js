const { ObjectId } = require("mongodb");
const { DIAS, minutos } = require("../lib/slots.js");

// A collection `availability` — quando cada profissional atende.
//
// Um documento por profissional. É a grade SEMANAL — "terça e quinta, das 7h
// às 12h" — e não uma lista de horários: guardar cada horário produziria
// milhares de documentos que precisariam ser gerados até algum futuro
// arbitrário, e mudar o expediente obrigaria a regerar tudo.
//
// Os horários que o cliente vê são CALCULADOS a partir daqui, na hora do
// pedido (lib/slots.js). Assim, mudar o expediente muda a oferta na mesma
// hora, e o passado continua sendo o que foi.
function Availability_model(app) {
  this.app = app;
}

Availability_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("availability");
};

function inteiroOuPadrao(valor, padrao, { min, max }) {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) && n >= min && n <= max ? n : padrao;
}

// A grade da semana, limpa. Só horas de verdade, e só janelas que existem.
function semanaLimpa(entrada) {
  const saida = {};

  for (const dia of DIAS) {
    const janelas = Array.isArray(entrada?.[dia]) ? entrada[dia] : [];

    saida[dia] = janelas
      .map((j) => ({ from: String(j?.from || "").trim(), to: String(j?.to || "").trim() }))
      // Janela invertida ou incompleta é engano de cadastro. Guardá-la faria a
      // conta de horários lidar com isso todo dia, em vez de uma vez aqui.
      .filter((j) => {
        const de = minutos(j.from);
        const ate = minutos(j.to);
        return de !== null && ate !== null && ate > de;
      })
      .slice(0, 6);
  }

  return saida;
}

function bloqueiosLimpos(entrada) {
  return (Array.isArray(entrada) ? entrada : [])
    .map((b) => ({
      from: new Date(b?.from),
      to: new Date(b?.to),
      reason: String(b?.reason || "").trim().slice(0, 120),
    }))
    .filter(
      (b) => !Number.isNaN(b.from.getTime()) && !Number.isNaN(b.to.getTime()) && b.to > b.from
    )
    .slice(0, 200);
}

function limpar(obj) {
  return {
    // A agenda pública deste profissional está ligada? Desligada, ele não
    // aparece para o cliente escolher — mas a grade fica guardada, para
    // religar sem recadastrar.
    active: obj.active === true,

    weekdays: semanaLimpa(obj.weekdays),

    // De quantos em quantos minutos um horário começa. 30 é o passo que a
    // maioria usa; 15 serve a quem atende consultas curtas.
    slotStep: inteiroOuPadrao(obj.slotStep, 30, { min: 5, max: 240 }),

    // Antecedência mínima: ninguém quer receber marcação para daqui a dez
    // minutos e descobrir depois de a pessoa chegar.
    minNoticeHours: inteiroOuPadrao(obj.minNoticeHours, 12, { min: 0, max: 720 }),

    // Até quando dá para marcar. Sem teto, um cliente marcaria para o ano que
    // vem e o profissional só descobriria em dezembro.
    horizonDays: inteiroOuPadrao(obj.horizonDays, 30, { min: 1, max: 365 }),

    blocks: bloqueiosLimpos(obj.blocks),
  };
}

Availability_model.prototype.of = async function (professionalId) {
  if (!ObjectId.isValid(professionalId)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({ professional: new ObjectId(professionalId) });
  return doc || undefined;
};

Availability_model.prototype.save = async function (professionalId, obj) {
  const col = await this.collection();
  const limpo = limpar(obj);

  await col.updateOne(
    { professional: new ObjectId(professionalId) },
    {
      $set: { ...limpo, updatedAt: new Date() },
      $setOnInsert: { professional: new ObjectId(professionalId), createdAt: new Date() },
    },
    { upsert: true }
  );

  return limpo;
};

// Quem tem a agenda pública LIGADA. É a lista que o cliente vê para escolher.
Availability_model.prototype.listActive = async function () {
  const col = await this.collection();
  return await col.find({ active: true }).toArray();
};

Availability_model.prototype.deleteOf = async function (professionalId) {
  if (!ObjectId.isValid(professionalId)) return false;
  const col = await this.collection();

  const r = await col.deleteOne({ professional: new ObjectId(professionalId) });
  return r.deletedCount > 0;
};

module.exports = Availability_model;
module.exports.semanaLimpa = semanaLimpa;
